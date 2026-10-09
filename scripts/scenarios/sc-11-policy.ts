// SC-11 · contact policy (docs/test-plan.md §4.5; FL-072, FL-073, FL-076, FL-078): the 24 h window (an answer
// inside it; a notice 25 h later denied), quiet hours (a proactive notice at 22:00 deferred to 07:00, in a
// world of its own so the main clock keeps its order), the recipient fence evaluated without sending, and
// sensitive data by chat (a CURP masked before it is stored; a card blocked before G1 and escalated).
import { DAY, at, decided, orderIn, personIn, say, settledOn, withAction } from "./lib/assist";
import { caseOn } from "./lib/cases";
import { type ScenarioContext, ensure } from "./lib/context";
import { agentReplies, outOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, stored } from "./lib/world";

/** A CURP of the synthetic form (no real person): the mask recognizes the pattern, never the person. */
const SYNTHETIC_CURP = "QAXX010101HDFXXX09";
const TEST_CARD = "4111 1111 1111 1111";
const world = (ctx: ScenarioContext) => stored<World>(ctx, "world");

export default defineScenario({
  id: "SC-11",
  slug: "sc-11",
  title: "Contact policy",
  suites: ["full"],
  async setup(ctx) {
    const active = { activeWorkOrderId: true } as const;
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "09:30"),
      settings: { demoMode: false },
      operations: [
        { key: "a", model: "wo-24817", installer: "own", preset: { ...active, lastInboundAtSim: at(DAY, "09:25") } },
        { key: "c", model: "wo-24819", installer: "own", preset: active },
      ],
    });
    ctx.state.quiet = await createWorld(ctx, { startAtSim: at(DAY, "21:50"), operations: [{ key: "b", model: "wo-24817", installer: "own", preset: active }] }, "quiet");
  },
  steps: [
    {
      id: "1",
      title: "a: an answer inside the window",
      kind: "agent",
      flows: ["FL-072"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a");
        await say(ctx, w, a.installerId, "Ya estoy afuera del domicilio, ¿qué sigue?");
        const snapshot = await settledOn(ctx, w, a.installerId, [a.workOrderId]);
        const replies = agentReplies(personIn(snapshot, a.installerId).messages);
        ctx.check(replies.length === 1 && ["SENT", "DELIVERED", "READ"].includes(replies[0]?.status ?? ""), `${replies.length} reply(ies) sent`);
        ctx.check(decided(orderIn(snapshot, a.workOrderId).decisions, "DENY", "CP-WA-24H").filter((entry) => entry.messageId === replies[0]?.messageId).length === 0, "the reply was denied by CP-WA-24H");
      },
    },
    {
      id: "2",
      title: "a: → +25 h → case.open → the CASE_NOTICE denied by CP-WA-24H",
      kind: "det",
      flows: ["FL-072"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a");
        await ctx.qa("clock.advance", { clockId: w.clockId, minutes: 25 * 60 });
        await ctx.qa("case.open", { workOrderId: a.workOrderId, reason: "OTHER" });
        await caseOn(ctx, w, "a");
        const snapshot = await settledOn(ctx, w, a.installerId, [a.workOrderId]);
        ctx.check(decided(orderIn(snapshot, a.workOrderId).decisions, "DENY", "CP-WA-24H").length > 0, "no DENY CP-WA-24H");
        ctx.none(snapshot, "CASE_NOTICE sent outside the window", outOf(personIn(snapshot, a.installerId).messages, { kind: "CASE_NOTICE" }).filter((message) => ["SENT", "DELIVERED", "READ"].includes(message.status)));
      },
    },
    {
      id: "3",
      title: "b writes at 21:50; the dispatcher reschedules at 22:00 → DEFER CP-QUIET-HOURS → → 07:00 → SENT",
      kind: "det",
      flows: ["FL-073"],
      after: "preset",
      async run(ctx) {
        const w = stored<World>(ctx, "quiet");
        const b = op(w, "b");
        await say(ctx, w, b.installerId, "Ya terminé por hoy");
        await settledOn(ctx, w, b.installerId, [b.workOrderId]);
        await ctx.qa("clock.advanceTo", { clockId: w.clockId, to: at(DAY, "22:00") });
        await ctx.qa("dispatch.reschedule", { workOrderId: b.workOrderId, newWindow: { start: "2026-10-14T09:00:00-06:00", end: "2026-10-14T11:00:00-06:00" } });
        const deferred = await ctx.eventually(
          "the deferred notice",
          async () => {
            const seen = await ctx.snapshot({ clockId: w.clockId, workOrderIds: [b.workOrderId] });
            return decided(seen.decisions, "DEFER", "CP-QUIET-HOURS").length > 0 ? seen : undefined;
          },
          300,
        );
        ctx.check(deferred.timers.some((timer) => timer.kind === "DEFERRED_SEND"), "no DEFERRED_SEND pending");
        await ctx.qa("clock.advanceTo", { clockId: w.clockId, to: "2026-10-14T07:00:00-06:00" });
        const snapshot = await settledOn(ctx, w, b.installerId, [b.workOrderId]);
        const sent = outOf(personIn(snapshot, b.installerId).messages).filter((message) => Date.parse(message.sentAtSim) === Date.parse("2026-10-14T07:00:00-06:00") && ["SENT", "DELIVERED", "READ"].includes(message.status));
        ctx.check(sent.length >= 1, "nothing went out at 07:00");
      },
    },
    {
      id: "4",
      title: "fence.probe of the world: only the SES simulator",
      kind: "det",
      flows: ["FL-076"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const addresses = ["success@simulator.amazonses.com", "ops@cuadrilla.demo.craftech.io", "alguien@demo.craftech.io", "cliente@example.com", "cliente@simulator.amazonses.com.example.org", "no-es-un-correo"];
        const probe = (await ctx.qa("fence.probe", { clockId: w.clockId, addresses })) as { decisions: Array<{ allowed: boolean }> };
        ctx.check(probe.decisions.map((decision) => decision.allowed).join(",") === "true,false,false,false,false,false", `fence: ${probe.decisions.map((decision) => decision.allowed).join(",")}`);
      },
    },
    {
      id: "5",
      title: "A CURP in a message → GUARDRAIL_MASK, masked in Conversations; Memory without it (informed if the extraction did not end)",
      kind: "det",
      flows: ["FL-078"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a");
        await say(ctx, w, a.installerId, `El CURP de la señora es ${SYNTHETIC_CURP}, ¿lo anoto en algún lado?`);
        const snapshot = await settledOn(ctx, w, a.installerId, [a.workOrderId]);
        const person = personIn(snapshot, a.installerId);
        ctx.check(person.messages.every((message) => !(message.text ?? "").includes(SYNTHETIC_CURP)), "the CURP is stored in clear");
        ctx.check(person.messages.some((message) => message.direction === "IN" && /\[CURP\]/.test(message.text ?? "")), "the stored message does not carry the CURP mask");
        ctx.check(decided(orderIn(snapshot, a.workOrderId).decisions, "DENY", undefined, "GUARDRAIL_BLOCK").length === 0, "the CURP was blocked instead of masked");
        ctx.check(withAction(orderIn(snapshot, a.workOrderId).decisions, "GUARDRAIL_MASK").length > 0 || withAction(snapshot.decisions, "GUARDRAIL_MASK").length > 0, "no GUARDRAIL_MASK");
        try {
          const memory = (await ctx.qa("memory.inspect", { installerId: a.installerId })) as { records: Array<{ sensitive: string[] }>; eventSensitive: string[] };
          ctx.check(memory.eventSensitive.length === 0 && memory.records.every((record) => record.sensitive.length === 0), "Memory keeps a sensitive value");
        } catch (error) {
          ctx.inform("memory", `not inspected: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
    {
      id: "6",
      title: "A card number → blocked before G1 and an OTHER case",
      kind: "det",
      flows: ["FL-078"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const c = op(w, "c");
        await say(ctx, w, c.installerId, `Me pidió que anote su tarjeta ${TEST_CARD} para el pago`);
        const snapshot = await settledOn(ctx, w, c.installerId, [c.workOrderId]);
        const order = orderIn(snapshot, c.workOrderId);
        const block = decided(order.decisions, "DENY", undefined, "GUARDRAIL_BLOCK")[0];
        ensure(block !== undefined, "no GUARDRAIL_BLOCK");
        ctx.check(block.detail?.origin === "PREFILTER", `the block came from ${String(block.detail?.origin ?? "unknown")}`);
        ctx.blocked("PREFILTER", "card");
        ctx.exactly(snapshot, 1, "OTHER cases", order.cases.filter((entry) => entry.reason === "OTHER"));
        ctx.check(personIn(snapshot, c.installerId).messages.every((message) => !(message.text ?? "").replace(/\s/g, "").includes(TEST_CARD.replace(/\s/g, ""))), "the card is stored in clear");
      },
    },
  ],
});
