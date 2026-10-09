// SC-18 · the guest's guided tour (docs/test-plan.md §4.5; FL-082, FL-084, FL-085, FL-017, FL-087), by IAM only:
// the `GUEST` principal of `GUEST#isp-guest-test` runs `console.tour.run` over `views/tour/steps.ts` (the ids
// of routers/tour.ts), the full track and the express one, each action as soon as `clock.get.busy` is false.
// Every `det` step after an `agent` one starts with its scene jump ("Saltar a escena"), so none depends on
// what the model decided; 4.a and 4.b depend only on step 2 and on the voice note step 4 sends itself.
import { GUEST_TEST_CLOCK_ID } from "@cuadrilla/shared";
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { assertCleanOutbound, orderIn, personIn } from "./lib/assist";
import { TOUR_STEPS, type TourTrackId } from "../../packages/web/src/views/tour/steps";
import { type ScenarioContext, ScenarioBug, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { agentReplies, citationProblem, citationsOf, containsWords, normalizeFacts, outOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { registerWorld } from "./lib/world";
import { GUEST_ORDER, asGuest } from "./sc-19-guest-world";

const ROGELIO = "inst-rogelio-gtest";
const HECTOR = "sup-hector-gtest";
type Track = TourTrackId;

async function idle(ctx: ScenarioContext): Promise<void> {
  await ctx.eventually("the world idle (clock.get.busy false)", async () => ((await asGuest(ctx, "clock.get")) as { busy: boolean }).busy === false, WAITS.settleSec, 3);
}

/** One step of the tour (or one part of it), as soon as the world is idle. */
async function run(ctx: ScenarioContext, track: Track, stepId: string, part?: number): Promise<void> {
  if (!TOUR_STEPS[track].some((step) => step.stepId === stepId)) throw new ScenarioBug(`${track} ${stepId} is not a step of views/tour/steps.ts`);
  await idle(ctx);
  await asGuest(ctx, "tour.run", { track, stepId, ...(part === undefined ? {} : { part }) });
}

async function jump(ctx: ScenarioContext, sceneId: string): Promise<void> {
  await idle(ctx);
  await asGuest(ctx, "clock.jumpToScene", { sceneId });
}

/** Rogelio's 24817 once the world is quiet. */
async function rogelio(ctx: ScenarioContext, timeoutSec?: number) {
  const snapshot = await ctx.settled({ installerId: ROGELIO }, { clockId: GUEST_TEST_CLOCK_ID, workOrderIds: [GUEST_ORDER], personIds: [ROGELIO, HECTOR] }, timeoutSec);
  return { snapshot, order: orderIn(snapshot, GUEST_ORDER), person: personIn(snapshot, ROGELIO) };
}

/** FL-036..FL-043 with a real turn and FL-103 over the photos of the step: the glare one not PASS, a good one PASS, one coherent reaction each. */
async function photosOracle(ctx: ScenarioContext) {
  const { snapshot, order, person } = await rogelio(ctx, WAITS.photoSec * 4 + WAITS.turnSec);
  const label = order.validations.filter((validation) => validation.item === "ONU_LABEL_PHOTO" && validation.source !== "SEED");
  ctx.check(label.some((validation) => validation.verdict !== "PASS") && label.some((validation) => validation.verdict === "PASS"), `label validations: ${label.map((validation) => validation.verdict).join(", ")}`);
  const reactions = outOf(person.messages, { kind: "VERDICT_REACTION" });
  for (const validation of order.validations.filter((entry) => entry.source !== "SEED")) {
    const own = reactions.filter((message) => message.refs?.validationId === validation.validationId);
    ctx.check(own.length === 1 && own[0]?.refs?.verdict === validation.verdict, `validation ${validation.verdict}: ${own.length} reaction(s)`);
  }
  assertCleanOutbound(ctx, snapshot);
}

async function safetyOracle(ctx: ScenarioContext) {
  const { person } = await rogelio(ctx);
  ctx.check(outOf(person.messages, { kind: "SAFETY_INSTRUCTION" }).some((message) => normalizeFacts(message.text ?? "") === normalizeFacts(esMX.safetyInstruction)), "no fixed safety instruction");
}

async function certificateOracle(ctx: ScenarioContext) {
  const { order, snapshot } = await rogelio(ctx);
  ctx.check(order.order.status === "CLOSED" && order.certificate !== undefined, `the 24817 is ${order.order.status}`);
  ctx.check(snapshot.outbox.some((mail) => mail.kind === "CERTIFICATE_EMAIL"), "the outbox has no certificate email");
}

export default defineScenario({
  id: "SC-18",
  slug: "sc-18",
  title: "The guest's guided tour",
  suites: ["full"],
  lane: "guest-test",
  async setup(ctx) {
    registerWorld(ctx.state, GUEST_TEST_CLOCK_ID);
    await ctx.qa("world.destroy", { clockId: GUEST_TEST_CLOCK_ID });
    await ctx.qa("world.create", { clockId: GUEST_TEST_CLOCK_ID, template: "guest" });
  },
  steps: [
    {
      id: "1",
      title: "Its own world, the clock paused at 07:00, the 24817 pinned, the brand and the notice by brand.get",
      kind: "det",
      flows: ["FL-084"],
      after: "preset",
      async run(ctx) {
        const clock = (await asGuest(ctx, "clock.get")) as { mode: string; simNow: string };
        ctx.check(clock.mode === "PAUSED" && Date.parse(clock.simNow) === Date.parse("2026-10-13T07:00:00-06:00"), `the clock is ${clock.mode} at ${clock.simNow}`);
        const orders = (await asGuest(ctx, "orders.list", {})) as { workOrders: Array<{ workOrderId: string; pinned?: boolean }> };
        ctx.check(orders.workOrders.some((order) => order.workOrderId === GUEST_ORDER), "the 24817 is not in the day");
        const brand = (await ctx.qa("console", { clockId: GUEST_TEST_CLOCK_ID, procedure: "brand.get" })) as Record<string, unknown>;
        ensure(brand !== null && typeof brand === "object", "brand.get answered nothing");
        ctx.inform("brandMode", String(brand.mode ?? "unknown"));
      },
    },
    {
      id: "2",
      title: "Start the day",
      kind: "det",
      flows: ["FL-084"],
      after: "1",
      async run(ctx) {
        await run(ctx, "FULL", "2");
        const { person } = await rogelio(ctx);
        ctx.check(outOf(person.messages, { kind: "DAY_START" }).length === 1, "no DAY_START to Rogelio");
      },
    },
    {
      id: "3",
      title: "\"Ver órdenes\" (FL-082 → FL-010)",
      kind: "agent",
      flows: ["FL-082"],
      after: "2",
      async run(ctx) {
        await run(ctx, "FULL", "3");
        const { person, snapshot } = await rogelio(ctx);
        const detail = agentReplies(person.messages).at(-1);
        ensure(detail !== undefined, "no ORDERS_DETAIL");
        ctx.check(JSON.stringify(detail.refs ?? {}).includes(GUEST_ORDER) || (detail.text ?? "").includes("24817"), "the detail does not list the 24817");
        assertCleanOutbound(ctx, snapshot);
      },
    },
    {
      id: "4",
      title: "Rogelio sends vn-01 (one action of the tour)",
      parts: [
        {
          part: "a",
          title: "clock.get.busy true while it is transcribed",
          kind: "det",
          flows: ["FL-082", "FL-085"],
          after: "2",
          async run(ctx) {
            await run(ctx, "FULL", "4", 0);
            await asGuest(ctx, "tour.run", { track: "FULL", stepId: "4", part: 1 });
            const busy = (await asGuest(ctx, "clock.get")) as { busy: boolean };
            ctx.check(busy.busy, "the world is not busy right after the voice note");
          },
        },
        {
          part: "b",
          title: "vn-01 in GUEST#isp-guest-test (a clock id with #) → the transcription accepted, a transcript with confidence ≥ 0,55",
          kind: "det",
          flows: ["FL-082", "FL-017"],
          after: "2",
          async run(ctx) {
            const { person } = await rogelio(ctx, WAITS.voiceSec + WAITS.turnSec);
            const note = person.messages.filter((message) => message.direction === "IN" && message.content === "VOICE").at(-1);
            ensure(note?.transcript !== undefined, "the voice note has no transcript");
            ctx.check(note.transcript.confidence >= 0.55 && containsWords(note.transcript.text, ["ONU"]), `transcript confidence ${note.transcript.confidence}`);
          },
        },
        {
          part: "c",
          title: "The answer to the voice note cites §DIAG-02",
          kind: "agent",
          flows: ["FL-082", "FL-019", "FL-020", "FL-028"],
          after: "4.b",
          oracleFlow: "FL-082",
          async run(ctx) {
            const { person, order } = await rogelio(ctx);
            ctx.check(agentReplies(person.messages).some((reply) => citationProblem(order, reply, ["DIAG-02"]) === undefined), "no reply cites §DIAG-02");
          },
        },
      ],
    },
    {
      id: "5",
      title: "The ONU online (FL-082 → FL-020)",
      kind: "agent",
      flows: ["FL-082"],
      after: "4.c",
      async run(ctx) {
        await run(ctx, "FULL", "5");
        const { order } = await rogelio(ctx);
        ctx.check(order.checklist.find((item) => item.item === "ONU_ONLINE")?.status === "PASSED", "ONU_ONLINE is not PASSED");
      },
    },
    {
      id: "6",
      title: "A policy question and manual.section of the citation (FL-082 → FL-028)",
      kind: "agent",
      flows: ["FL-082"],
      after: "5",
      async run(ctx) {
        await run(ctx, "FULL", "6");
        const { person, order } = await rogelio(ctx);
        const reply = agentReplies(person.messages).at(-1);
        ensure(reply !== undefined, "no REPLY");
        const problem = citationProblem(order, reply, ["COM-04"]);
        ctx.check(problem === undefined, problem ?? "");
        const section = citationsOf(reply)[0];
        if (section !== undefined) ensure((await asGuest(ctx, "manual.section", { sectionId: section })) !== null, "the cited section does not open");
      },
    },
    {
      id: "7",
      title: "The photos: the glare rejected, the good one passed, coherent reactions (FL-082 → FL-036..FL-043, FL-103)",
      kind: "agent",
      flows: ["FL-082"],
      after: "6",
      async run(ctx) {
        await run(ctx, "FULL", "7");
        await photosOracle(ctx);
      },
    },
    {
      id: "8",
      title: "Jump to \"Checklist completo\" → \"Cerrar instalación\" → the certificate and the outbox",
      kind: "det",
      flows: ["FL-082", "FL-084"],
      after: "scene",
      async run(ctx) {
        await jump(ctx, "checklist-completo");
        await run(ctx, "FULL", "8");
        await certificateOracle(ctx);
      },
    },
    {
      id: "9",
      title: "Escalation at 11:50 (FL-082 → FL-023)",
      kind: "agent",
      flows: ["FL-082"],
      after: "scene",
      async run(ctx) {
        await jump(ctx, "segunda-visita-1150");
        await run(ctx, "FULL", "9");
        const { order, snapshot } = await rogelio(ctx, WAITS.voiceSec * 3 + WAITS.turnSec);
        ctx.exactly(snapshot, 1, "DIAGNOSIS_ATTEMPTS cases", order.cases.filter((entry) => entry.reason === "DIAGNOSIS_ATTEMPTS"));
      },
    },
    {
      id: "10",
      title: "Jump to \"Caso abierto 11:50\" → \"Avanzar al próximo evento\" → 12:00, reassigned",
      kind: "det",
      flows: ["FL-082", "FL-084"],
      after: "scene",
      async run(ctx) {
        await jump(ctx, "caso-con-supervisora");
        await run(ctx, "FULL", "10");
        const { order } = await rogelio(ctx);
        const open = order.cases.find((entry) => entry.status !== "CLOSED");
        ctx.check(open?.rung === "SECONDARY", `the case is at ${open?.rung ?? "nothing"}`);
      },
    },
    {
      id: "11",
      title: "Héctor takes, answers and closes; the agent resumes",
      parts: [
        {
          part: "a",
          title: "In the same scene, Héctor takes, answers (the physical action) and closes",
          kind: "det",
          flows: ["FL-082"],
          after: "10",
          async run(ctx) {
            await run(ctx, "FULL", "11");
            const { order } = await rogelio(ctx);
            const closed = order.cases.find((entry) => entry.takenBy === HECTOR);
            ctx.check(closed?.status === "CLOSED", `Héctor's case is ${closed?.status ?? "missing"}`);
          },
        },
        {
          part: "b",
          title: "The agent resumes (FL-082 → FL-063)",
          kind: "agent",
          flows: ["FL-082", "FL-063"],
          after: "11.a",
          oracleFlow: "FL-082",
          async run(ctx) {
            const { person } = await rogelio(ctx);
            ctx.check(person.turnNotes.some((note) => note.trigger === "CASE_CLOSED"), "no CASE_CLOSED turn");
          },
        },
      ],
    },
    {
      id: "12",
      title: "Jump to \"Tercera visita 15:10\" → safety",
      kind: "det",
      flows: ["FL-082", "FL-084"],
      after: "scene",
      async run(ctx) {
        await jump(ctx, "tercera-visita-1510");
        await run(ctx, "FULL", "12");
        await safetyOracle(ctx);
      },
    },
    {
      id: "13",
      title: "Metrics",
      kind: "det",
      flows: ["FL-087"],
      after: "preset",
      async run(ctx) {
        const summary = (await asGuest(ctx, "metrics.summary", { tab: "WORLD" })) as unknown;
        ensure(summary !== null && typeof summary === "object", "no metrics");
        ctx.check(!/evaluaci[oó]n|EV-0/i.test(JSON.stringify(summary)), "the metrics name the measurement with internal words");
      },
    },
    { id: "X1", title: "Express: on site at 09:20, the voice note answered with §DIAG-02", kind: "agent", flows: ["FL-082"], after: "scene", run: async (ctx) => {
      await jump(ctx, "en-sitio-0920");
      await run(ctx, "EXPRESS", "X1");
      const { person, order } = await rogelio(ctx, WAITS.voiceSec + WAITS.turnSec);
      ctx.check(agentReplies(person.messages).some((reply) => citationProblem(order, reply, ["DIAG-02"]) === undefined), "no reply cites §DIAG-02");
    } },
    { id: "X2", title: "Express: the evidence, the glare rejected and the good one passed", kind: "agent", flows: ["FL-082"], after: "scene", run: async (ctx) => {
      await jump(ctx, "evidencia");
      await run(ctx, "EXPRESS", "X2");
      await photosOracle(ctx);
    } },
    { id: "X3", title: "Express: \"Checklist completo\" (the scene's offer) → the certificate", kind: "det", flows: ["FL-082"], after: "scene", run: async (ctx) => {
      await jump(ctx, "checklist-completo");
      await run(ctx, "EXPRESS", "X3");
      await certificateOracle(ctx);
    } },
    { id: "X4", title: "Express: the third visit at 15:10 → safety", kind: "det", flows: ["FL-082"], after: "scene", run: async (ctx) => {
      await jump(ctx, "tercera-visita-1510");
      await run(ctx, "EXPRESS", "X4");
      await safetyOracle(ctx);
    } },
  ],
});
