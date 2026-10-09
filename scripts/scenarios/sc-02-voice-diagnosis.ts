// SC-02 · voice and diagnosis (docs/test-plan.md §4.5; FL-017 … FL-026, FL-102): a voice note transcribed by
// the real Transcribe with the read receipt first, the guided diagnosis until the ONU is online, the voice
// notices without a turn, three failed attempts escalated by code, the unprovisioned ONU, the dying gasp, the
// installer asking for the supervisor, small talk and other people's data, and the orchestrator down. Every
// order has an installer of its own, so no step changes what another one reads.
import { DAY, assertCleanOutbound, at, isNotice, orderIn, personIn, say, send, settledOn, voice } from "./lib/assist";
import { type ScenarioContext, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { agentReplies, citationProblem, containsWords, outOf, refList, ungroundedFigures, turnOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, stored } from "./lib/world";

const active = { activeWorkOrderId: true } as const;
const PHOTO_ITEMS = ["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"];
const world = (ctx: Parameters<typeof stored>[0]) => stored<World>(ctx, "world");

/** The installer's order and the snapshot after it went quiet. */
async function turnOn(ctx: ScenarioContext, key: string, timeoutSec?: number) {
  const w = world(ctx);
  const target = op(w, key);
  const snapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId], [target.installerId], timeoutSec);
  return { w, target, snapshot, order: orderIn(snapshot, target.workOrderId), person: personIn(snapshot, target.installerId) };
}

export default defineScenario({
  id: "SC-02",
  slug: "sc-02",
  title: "Voice and diagnosis",
  suites: ["full"],
  async setup(ctx) {
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "09:15"),
      settings: { demoMode: false },
      operations: [
        { key: "los", model: "wo-24817", installer: "own", preset: active },
        { key: "low", model: "wo-24818", installer: "own", preset: { ...active, onu: { behaviour: "LOW_POWER" } } },
        { key: "np", model: "wo-24830", installer: "own", preset: active },
        { key: "dg", model: "wo-24832", installer: "own", preset: active },
        { key: "voice", model: "wo-24819", installer: "own", preset: active },
        { key: "ask", model: "wo-24820", installer: "own", preset: active },
        { key: "chat", model: "wo-24821", installer: "own", preset: active },
        { key: "net", model: "wo-24817", installer: "own", preset: active },
      ],
    });
  },
  steps: [
    {
      id: "1",
      title: "vn-01 → READ_ACK before the first outgoing message; transcript with ONU and PON, confidence ≥ 0,55",
      kind: "det",
      flows: ["FL-017", "FL-102"],
      after: "preset",
      async run(ctx) {
        await voice(ctx, world(ctx), op(world(ctx), "los").installerId, "vn-01");
        const { person } = await turnOn(ctx, "los", WAITS.voiceSec + WAITS.turnSec);
        const note = person.messages.find((message) => message.direction === "IN" && message.content === "VOICE");
        ensure(note?.transcript !== undefined, "the voice note has no transcript");
        ctx.check(containsWords(note.transcript.text, ["ONU", "PON"]), "the transcript lacks ONU or PON");
        ctx.check(note.transcript.confidence >= 0.55, `confidence ${note.transcript.confidence}`);
        const ack = outOf(person.messages, { kind: "READ_ACK" })[0];
        const first = outOf(person.messages).filter((message) => message.kind !== "READ_ACK").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        ensure(ack !== undefined, "no READ_ACK");
        ctx.check(first === undefined || ack.createdAt <= first.createdAt, "the READ_ACK came after the first outgoing message");
      },
    },
    {
      id: "2",
      title: "get_onu_status LOS and a REPLY citing §DIAG-02; the step PENDING recorded",
      kind: "agent",
      flows: ["FL-019", "FL-020"],
      after: "1",
      async run(ctx) {
        const { order, person, snapshot } = await turnOn(ctx, "los");
        ctx.check(order.turns.some((turn) => turn.tools.includes("get_onu_status")), "no get_onu_status in the turn");
        const reply = agentReplies(person.messages)[0];
        ensure(reply !== undefined, "no REPLY");
        const problem = citationProblem(order, reply, ["DIAG-02"]);
        ctx.check(problem === undefined, problem ?? "");
        ctx.check(order.steps.some((step) => step.stepRef.startsWith("DIAG-02") && step.outcome === "PENDING"), "no DIAG-02 step PENDING");
        assertCleanOutbound(ctx, snapshot);
      },
    },
    {
      id: "3",
      title: "vn-02 → physical action, ONLINE −21,4, ONU_ONLINE PASSED, the 3 photos asked",
      kind: "agent",
      flows: ["FL-020"],
      after: "2",
      async run(ctx) {
        await voice(ctx, world(ctx), op(world(ctx), "los").installerId, "vn-02");
        const { order, person, snapshot } = await turnOn(ctx, "los", WAITS.voiceSec + WAITS.turnSec);
        ctx.check(order.checklist.find((item) => item.item === "ONU_ONLINE")?.status === "PASSED", "ONU_ONLINE is not PASSED");
        ctx.check(order.order.lastOnuReading?.operState === "ONLINE", "the last reading is not ONLINE");
        const asked = agentReplies(person.messages).flatMap((message) => refList(message, "items"));
        ctx.check(PHOTO_ITEMS.every((item) => asked.includes(item)), `the photos asked: ${asked.join(", ")}`);
        for (const reply of agentReplies(person.messages)) ctx.check(ungroundedFigures(reply.text ?? "", turnOf(order, reply)).length === 0, "a reply carries a figure its turn never read");
        assertCleanOutbound(ctx, snapshot);
      },
    },
    {
      id: "4",
      title: "vn-09 (noise) → the fixed notice, no turn (empty or confidence < 0,55)",
      kind: "det",
      flows: ["FL-018"],
      after: "preset",
      async run(ctx) {
        await voice(ctx, world(ctx), op(world(ctx), "voice").installerId, "vn-09");
        const { person, snapshot } = await turnOn(ctx, "voice", WAITS.voiceSec);
        const note = person.messages.find((message) => message.direction === "IN" && message.content === "VOICE");
        ctx.check((note?.transcript?.text ?? "").trim() === "" || (note?.transcript?.confidence ?? 0) < 0.55, "the noise was transcribed with confidence");
        ctx.check(person.messages.some((message) => isNotice(message, "voiceUnclear")), "no voiceUnclear notice");
        ctx.none(snapshot, "turns for the unclear note", person.turnNotes);
      },
    },
    {
      id: "5",
      title: "vn-10 (150 s) → the too-long notice, not transcribed",
      kind: "det",
      flows: ["FL-018"],
      after: "preset",
      async run(ctx) {
        await voice(ctx, world(ctx), op(world(ctx), "voice").installerId, "vn-10");
        const { person, snapshot } = await turnOn(ctx, "voice", WAITS.voiceSec);
        const notes = person.messages.filter((message) => message.direction === "IN" && message.content === "VOICE");
        ctx.check(notes.at(0)?.transcript === undefined || notes.length > 1, "the long note was transcribed");
        ctx.check(person.messages.some((message) => isNotice(message, "voiceTooLong")), "no voiceTooLong notice");
        ctx.none(snapshot, "turns for the long note", person.turnNotes);
      },
    },
    {
      id: "6",
      title: "A video → the fixed notice",
      kind: "det",
      flows: ["FL-018"],
      after: "preset",
      async run(ctx) {
        await send(ctx, world(ctx), op(world(ctx), "voice").installerId, { type: "other", kind: "video" });
        const { person, snapshot } = await turnOn(ctx, "voice");
        ctx.check(person.messages.some((message) => isNotice(message, "unsupportedMedia")), "no unsupportedMedia notice");
        ctx.none(snapshot, "turns for the video", person.turnNotes);
      },
    },
    {
      id: "7",
      title: "LOW_POWER: three \"sigue igual\" (the third vn-04) → exactly one DIAGNOSIS_ATTEMPTS case at the third",
      kind: "agent",
      flows: ["FL-023"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const installer = op(w, "low").installerId;
        await say(ctx, w, installer, "La ONU tiene potencia muy baja, ¿qué reviso?");
        await turnOn(ctx, "low");
        await say(ctx, w, installer, "Ya limpié el conector y sigue igual");
        await turnOn(ctx, "low");
        await say(ctx, w, installer, "Revisé la curvatura del cable y sigue igual");
        await turnOn(ctx, "low");
        await voice(ctx, w, installer, "vn-04");
        const { order, snapshot } = await turnOn(ctx, "low", WAITS.voiceSec + WAITS.turnSec);
        const worse = order.steps.some((step) => step.outcome === "WORSE");
        const cases = order.cases.filter((entry) => entry.reason === "DIAGNOSIS_ATTEMPTS");
        ctx.exactly(snapshot, worse && cases.length === 0 ? 0 : 1, "DIAGNOSIS_ATTEMPTS cases", cases);
        if (worse) ctx.inform("alternative", "the agent recorded WORSE");
        assertCleanOutbound(ctx, snapshot);
      },
    },
    {
      id: "8",
      title: "NOT_PROVISIONED: two readings in a row → the case",
      kind: "agent",
      flows: ["FL-022"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const installer = op(w, "np").installerId;
        await say(ctx, w, installer, "La ONU no levanta, ¿la puedes revisar?");
        await turnOn(ctx, "np");
        await say(ctx, w, installer, "Revísala otra vez por favor, sigue sin levantar");
        const { order, snapshot } = await turnOn(ctx, "np");
        const provisioned = order.cases.filter((entry) => entry.reason === "NOT_PROVISIONED");
        const other = order.cases.filter((entry) => entry.reason === "OTHER");
        ctx.exactly(snapshot, 1, "cases of the unprovisioned ONU", provisioned.length > 0 ? provisioned : other);
        if (provisioned.length === 0) ctx.inform("alternative", "case OTHER opened by the agent");
      },
    },
    {
      id: "9",
      title: "DYING_GASP → §DIAG-01 and ONLINE after the physical action",
      kind: "agent",
      flows: ["FL-022"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const installer = op(w, "dg").installerId;
        await say(ctx, w, installer, "La ONU no prende ninguna luz");
        const first = await turnOn(ctx, "dg");
        const reply = agentReplies(first.person.messages).at(-1);
        ensure(reply !== undefined, "no REPLY");
        const problem = citationProblem(first.order, reply, ["DIAG-01"]);
        ctx.check(problem === undefined, problem ?? "");
        await say(ctx, w, installer, "Ya conecté bien el eliminador al contacto y ya prendió");
        const { order } = await turnOn(ctx, "dg");
        ctx.check(order.checklist.find((item) => item.item === "ONU_ONLINE")?.status === "PASSED", "ONU_ONLINE is not PASSED");
      },
    },
    {
      id: "10",
      title: "vn-08 → an INSTALLER_ASKED case",
      kind: "agent",
      flows: ["FL-024"],
      after: "preset",
      async run(ctx) {
        await voice(ctx, world(ctx), op(world(ctx), "ask").installerId, "vn-08");
        const { order, person, snapshot } = await turnOn(ctx, "ask", WAITS.voiceSec + WAITS.turnSec);
        const asked = order.cases.filter((entry) => entry.reason === "INSTALLER_ASKED");
        const other = order.cases.filter((entry) => entry.reason === "OTHER");
        ctx.exactly(snapshot, 1, "cases asked by the installer", asked.length > 0 ? asked : other);
        ctx.check(outOf(person.messages, { kind: "CASE_NOTICE" }).length >= 1, "no CASE_NOTICE");
      },
    },
    {
      id: "11",
      title: "Small talk, another person's orders and two \"hola\" in a row with the clock paused (each with its REPLY)",
      kind: "agent",
      flows: ["FL-025"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const installer = op(w, "chat").installerId;
        for (const text of ["¿Quién ganó el partido anoche?", "¿Qué órdenes tiene Karina hoy?", "Hola", "hola"]) {
          await say(ctx, w, installer, text);
          await turnOn(ctx, "chat");
        }
        const { order, person, snapshot } = await turnOn(ctx, "chat");
        ctx.none(snapshot, "cases", order.cases);
        const inbound = person.messages.filter((message) => message.direction === "IN" && message.content === "TEXT");
        const replies = agentReplies(person.messages);
        ctx.check(replies.length >= inbound.length, `${replies.length} replies for ${inbound.length} messages`);
        const others = w.operations.filter((entry) => entry.key !== "chat").map((entry) => entry.workOrderId.slice("wo-".length));
        ctx.check(replies.every((reply) => others.every((number) => !(reply.text ?? "").includes(number))), "a reply names another installer's order");
        assertCleanOutbound(ctx, snapshot);
      },
    },
    {
      id: "12",
      title: "network.setFaults(ERROR_503) → available false, no invented figures",
      kind: "agent",
      flows: ["FL-026"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const installer = op(w, "net").installerId;
        await ctx.qa("network.setFaults", { clockId: w.clockId, mode: "ERROR_503" });
        try {
          await say(ctx, w, installer, "¿Cómo ves la ONU de esta orden? ¿Ya tiene señal?");
          const { order, person, snapshot } = await turnOn(ctx, "net");
          ctx.check(person.processError === undefined, "the turn failed");
          for (const reply of agentReplies(person.messages)) ctx.check(ungroundedFigures(reply.text ?? "", turnOf(order, reply)).length === 0 && !/dbm/i.test(reply.text ?? ""), "a reply states a power the network did not give");
          assertCleanOutbound(ctx, snapshot);
        } finally {
          await ctx.qa("network.setFaults", { clockId: w.clockId, mode: null });
        }
      },
    },
  ],
});
