// SC-08 · physical safety (docs/test-plan.md §4.5; FL-067 … FL-071): the lexicon's hazard answered with the
// fixed instruction of §SEG-01 (never written by the model), the parallel alert to the supervisor on duty and
// the zone chief, the hazard only the agent recognizes, the hazard by voice, the ambiguous phrase, the hazard
// at night (exempt from quiet hours, in a world of its own so the main clock stays at 11:40) and the order on
// hold until the case closes.
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { DAY, at, orderIn, personIn, say, settledOn, voice } from "./lib/assist";
import { CREW_N3, caseIn, caseOn, caseSnapshot } from "./lib/cases";
import { type ScenarioContext, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { normalizeFacts, outOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, staff, stored } from "./lib/world";

const HAZARD = "Hay un cable pelado en el poste, está chispeando";
const world = (ctx: ScenarioContext) => stored<World>(ctx, "world");
const active = { activeWorkOrderId: true } as const;

/** The installer's hazard ends in the fixed instruction and a SAFETY case; the latency from the inbound is recorded. */
async function hazard(ctx: ScenarioContext, w: World, key: string, send: () => Promise<{ sentAtReal: string }>, timeoutSec?: number) {
  const target = op(w, key);
  const sent = await send();
  const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId], [target.installerId], timeoutSec);
  const order = orderIn(snapshot, target.workOrderId);
  const instruction = outOf(personIn(snapshot, target.installerId).messages, { kind: "SAFETY_INSTRUCTION" })[0];
  ensure(instruction !== undefined, "no SAFETY_INSTRUCTION");
  ctx.check(normalizeFacts(instruction.text ?? "") === normalizeFacts(esMX.safetyInstruction), "the instruction is not the fixed text of §SEG-01");
  ctx.check(order.cases.some((entry) => entry.reason === "SAFETY"), "no SAFETY case");
  if (instruction.sentAtReal !== undefined) ctx.latency("safetyInstructionMs", Date.parse(instruction.sentAtReal) - Date.parse(sent.sentAtReal));
  return { snapshot, order, instruction };
}

export default defineScenario({
  id: "SC-08",
  slug: "sc-08",
  title: "Physical safety",
  suites: ["full"],
  async setup(ctx) {
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "11:40"),
      settings: { demoMode: false },
      operations: ["s1", "s2", "s3", "s4"].map((key) => ({ key, model: "wo-24819", installer: "own" as const, preset: active })),
    });
    ctx.state.night = await createWorld(ctx, { startAtSim: at(DAY, "21:30"), operations: [{ key: "s5", model: "wo-24819", installer: "own", preset: active }] }, "night");
  },
  steps: [
    {
      id: "1",
      title: "\"Hay un cable pelado en el poste, está chispeando\" → SAFETY_INSTRUCTION (latency recorded)",
      kind: "det",
      flows: ["FL-067"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const { order } = await hazard(ctx, w, "s1", () => say(ctx, w, op(w, "s1").installerId, HAZARD));
        ctx.check(order.order.onHoldSafety, "the order is not on hold");
      },
    },
    {
      id: "2",
      title: "alerta_seguridad and ZONE_CHIEF_ALERT with DELIVERY (latency recorded)",
      kind: "det",
      flows: ["FL-068"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const s1 = op(w, "s1");
        const primary = staff(w, CREW_N3.primary);
        const snapshot = await settledOn(ctx, w, s1.installerId, [s1.workOrderId], [primary]);
        ctx.check(outOf(personIn(snapshot, primary).messages, { templateName: "alerta_seguridad" }).length === 1, "no alerta_seguridad to the supervisor on duty");
        const alert = orderIn(snapshot, s1.workOrderId).emails.find((email) => email.kind === "ZONE_CHIEF_ALERT");
        ensure(alert !== undefined, "no ZONE_CHIEF_ALERT");
        const outcome = (await ctx.qa("mail.outcome", { clockId: w.clockId, mailId: alert.mailId, until: "FINAL", timeoutSec: WAITS.emailSec })) as { events: Array<{ type: string; atReal: string }> };
        const delivery = outcome.events.find((event) => event.type === "DELIVERY");
        ensure(delivery !== undefined, "the alert did not reach DELIVERY");
        const inbound = personIn(snapshot, s1.installerId).messages.find((message) => message.direction === "IN");
        if (inbound?.sentAtReal !== undefined) ctx.latency("safetyAlertMs", Date.parse(delivery.atReal) - Date.parse(inbound.sentAtReal));
      },
    },
    {
      id: "3",
      title: "A phrase outside the lexicon (the wasp nest in the terminal box) → report_safety_hazard or the lexicon",
      kind: "agent",
      flows: ["FL-069"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const { snapshot } = await hazard(ctx, w, "s2", () => say(ctx, w, op(w, "s2").installerId, "Hay un panal de avispas dentro de la caja terminal y ya me picaron"));
        const detected = snapshot.orders[0]?.decisions.find((entry) => entry.action === "SAFETY_DETECTED");
        ctx.inform("detectedBy", String(detected?.detail?.detectedBy ?? "unknown"));
      },
    },
    {
      id: "4",
      title: "vn-05 → safety",
      kind: "det",
      flows: ["FL-070"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        await hazard(ctx, w, "s3", () => voice(ctx, w, op(w, "s3").installerId, "vn-05"), WAITS.voiceSec + WAITS.settleSec);
      },
    },
    {
      id: "5",
      title: "An ambiguous phrase → safety (a false positive is preferred)",
      kind: "det",
      flows: ["FL-071"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        await hazard(ctx, w, "s4", () => say(ctx, w, op(w, "s4").installerId, "el cable está pelado"));
      },
    },
    {
      id: "6",
      title: "At 21:30 → sent all the same (exempt from quiet hours)",
      kind: "det",
      flows: ["FL-071"],
      after: "preset",
      async run(ctx) {
        const w = stored<World>(ctx, "night");
        const { instruction } = await hazard(ctx, w, "s5", () => say(ctx, w, op(w, "s5").installerId, HAZARD));
        ctx.check(["SENT", "DELIVERED", "READ"].includes(instruction.status), `the instruction is ${instruction.status}`);
      },
    },
    {
      id: "7",
      title: "With the order on hold, a request to go on → no STEP#; the case closed → the order resumes",
      kind: "det",
      flows: ["FL-071"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const s1 = op(w, "s1");
        const stepsBefore = orderIn(await ctx.snapshot({ clockId: w.clockId, workOrderIds: [s1.workOrderId] }), s1.workOrderId).steps.length;
        await say(ctx, w, s1.installerId, "Ya me alejé, ¿sigo con la limpieza del conector?");
        const held = await settledOn(ctx, w, s1.installerId, [s1.workOrderId]);
        ctx.exactly(held, stepsBefore, "troubleshooting steps while on hold", orderIn(held, s1.workOrderId).steps);
        const safety = await caseOn(ctx, w, "s1", "SAFETY");
        await ctx.qa("console", { clockId: w.clockId, procedure: "cases.take", input: { caseId: safety.caseId } });
        await ctx.qa("console", { clockId: w.clockId, procedure: "cases.close", input: { caseId: safety.caseId } });
        const closed = await caseSnapshot(ctx, w, "s1", safety.caseId, []);
        ctx.check(caseIn(closed, safety.caseId).status === "CLOSED", "the safety case did not close");
        ctx.check(!orderIn(closed, s1.workOrderId).order.onHoldSafety, "the order is still on hold");
      },
    },
  ],
});
