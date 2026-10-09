// SC-14 · failures and the emergency cut (docs/test-plan.md §4.5; FL-099, FL-100): a turn that fails on
// purpose (the fixed fallback), the photo validator down (UNSURE and human review), Transcribe down (the voice
// notice), an event that reaches the DLQ (its process error, the world quiet again, the DLQ cleaned), and the
// world's own kill switch (`KILL#AGENT#<clockId>`, never the global one): no Harness nor Transcribe while on,
// the safety instruction all the same, a turn again once off.
import { esMX } from "../../packages/bff/src/copy/es-MX";
import { DAY, at, isNotice, orderIn, personIn, say, settledOn, voice, withAction } from "./lib/assist";
import { type ScenarioContext, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { normalizeFacts, outOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, presetOf, stored } from "./lib/world";

const world = (ctx: ScenarioContext) => stored<World>(ctx, "world");
/** The kill switch's readers cache an item 30 s (ops/kill-switch.ts `KILL_CACHE_TTL_MS`), plus a margin. */
const KILL_CACHE_SEC = 35;

export default defineScenario({
  id: "SC-14",
  slug: "sc-14",
  title: "Failures and the emergency cut",
  suites: ["full"],
  async setup(ctx) {
    const active = { activeWorkOrderId: true } as const;
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "10:00"),
      operations: [
        { key: "f1", model: "wo-24817", installer: "own", preset: active },
        { key: "f2", model: "wo-24817", installer: "own", preset: { ...active, onu: { fixed: true }, candidates: ["ph-meter-01"] } },
        { key: "f3", model: "wo-24817", installer: "own", preset: active },
        { key: "f4", model: "wo-24817", installer: "own", preset: active },
        { key: "f5", model: "wo-24817", installer: "own", preset: active },
      ],
    });
    ctx.state.since = new Date(ctx.now()).toISOString();
  },
  cleanup: async (ctx) => {
    const w = world(ctx);
    await ctx.qa("kill.set", { clockId: w.clockId, scope: "AGENT", on: false });
    for (const action of ["validator.setFaults", "transcribe.setFaults"] as const) await ctx.qa(action, { clockId: w.clockId, mode: null });
    await ctx.qa("dlq.delete", { clockId: w.clockId });
  },
  steps: [
    {
      id: "1",
      title: "turn.forceFailure → AGENT_FALLBACK",
      kind: "det",
      flows: ["FL-099"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const f1 = op(w, "f1");
        await ctx.qa("turn.forceFailure", { clockId: w.clockId });
        await say(ctx, w, f1.installerId, "¿Cómo voy con esta orden?");
        const snapshot = await settledOn(ctx, w, f1.installerId, [f1.workOrderId]);
        ctx.check(personIn(snapshot, f1.installerId).messages.some((message) => isNotice(message, "agentFallback")), "no agentFallback notice");
        ctx.check(withAction(orderIn(snapshot, f1.workOrderId).decisions, "AGENT_FALLBACK").length + withAction(snapshot.decisions, "AGENT_FALLBACK").length > 0, "no AGENT_FALLBACK audited");
      },
    },
    {
      id: "2",
      title: "validator.setFaults → UNSURE and human review",
      kind: "det",
      flows: ["FL-099"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const f2 = op(w, "f2");
        const candidateId = presetOf(w, f2.workOrderId)?.candidates[0];
        ensure(candidateId !== undefined, "no candidate");
        await ctx.qa("validator.setFaults", { clockId: w.clockId, mode: "ERROR_503" });
        try {
          const answer = (await ctx.qa("tool.invoke", { clockId: w.clockId, tool: "validate_install_photo", args: { candidateId, item: "POWER_READING_PHOTO" }, installerId: f2.installerId, workOrderId: f2.workOrderId })) as { verdict?: string };
          ctx.check(answer.verdict === "UNSURE", `the validator down answered ${answer.verdict ?? "nothing"}`);
          const snapshot = await settledOn(ctx, w, f2.installerId, [f2.workOrderId]);
          ctx.check(orderIn(snapshot, f2.workOrderId).checklist.find((entry) => entry.item === "POWER_READING_PHOTO")?.status === "IN_REVIEW", "the item is not IN_REVIEW");
        } finally {
          await ctx.qa("validator.setFaults", { clockId: w.clockId, mode: null });
        }
      },
    },
    {
      id: "3",
      title: "transcribe.setFaults → the voice notice",
      kind: "det",
      flows: ["FL-099"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const f3 = op(w, "f3");
        await ctx.qa("transcribe.setFaults", { clockId: w.clockId, mode: "ERROR" });
        try {
          await voice(ctx, w, f3.installerId, "vn-01");
          const snapshot = await settledOn(ctx, w, f3.installerId, [f3.workOrderId], [f3.installerId], WAITS.voiceSec);
          ctx.check(personIn(snapshot, f3.installerId).messages.some((message) => isNotice(message, "voiceFailed")), "no voiceFailed notice");
          ctx.none(snapshot, "turns for a note that could not be transcribed", personIn(snapshot, f3.installerId).turnNotes);
        } finally {
          await ctx.qa("transcribe.setFaults", { clockId: w.clockId, mode: null });
        }
      },
    },
    {
      id: "4",
      title: "event.poison → processError → installer.settle returns → dlq.find ≤ 10 min → alarm.history → dlq.delete",
      kind: "det",
      flows: ["FL-099"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const f4 = op(w, "f4");
        const poisoned = (await ctx.qa("event.poison", { installerId: f4.installerId })) as { eventId: string };
        await ctx.eventually("the process error", async () => personIn(await ctx.snapshot({ clockId: w.clockId, personIds: [f4.installerId] }), f4.installerId).processError?.eventId === poisoned.eventId, WAITS.dlqSec, 15);
        await ctx.qa("installer.settle", { installerId: f4.installerId, timeoutSec: WAITS.settleSec });
        await ctx.eventually("the event in the DLQ", async () => ((await ctx.qa("dlq.find", { clockId: w.clockId, eventId: poisoned.eventId })) as { found: unknown[] }).found.length > 0, WAITS.dlqSec, 15);
        const alarms = (await ctx.qa("alarm.history", { sinceReal: stored<string>(ctx, "since") })) as { transitions: unknown[] };
        ctx.inform("alarmTransitions", String(alarms.transitions.length));
        const deleted = (await ctx.qa("dlq.delete", { clockId: w.clockId, eventId: poisoned.eventId })) as { deleted: number };
        ctx.check(deleted.deleted >= 1, "the DLQ's event was not deleted");
      },
    },
    {
      id: "5",
      title: "kill.set on → servicePaused, no Harness nor Transcribe; a hazard → the instruction all the same; kill.set off → a turn again",
      kind: "det",
      flows: ["FL-100"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const f5 = op(w, "f5");
        await ctx.qa("kill.set", { clockId: w.clockId, scope: "AGENT", on: true });
        await ctx.pause(KILL_CACHE_SEC);
        try {
          await say(ctx, w, f5.installerId, "¿Qué sigue en esta orden?");
          await voice(ctx, w, f5.installerId, "vn-01");
          const paused = await settledOn(ctx, w, f5.installerId, [f5.workOrderId]);
          const person = personIn(paused, f5.installerId);
          ctx.check(person.messages.some((message) => isNotice(message, "servicePaused")), "no servicePaused notice");
          ctx.none(paused, "turns while the agent is cut", person.turnNotes);
          ctx.none(paused, "transcripts while the agent is cut", person.messages.filter((message) => message.direction === "IN" && message.transcript !== undefined));
          await say(ctx, w, f5.installerId, "Hay un cable pelado en el poste, está chispeando");
          const hazard = await settledOn(ctx, w, f5.installerId, [f5.workOrderId]);
          ctx.check(outOf(personIn(hazard, f5.installerId).messages, { kind: "SAFETY_INSTRUCTION" }).some((message) => normalizeFacts(message.text ?? "") === normalizeFacts(esMX.safetyInstruction)), "no safety instruction while the agent is cut");
        } finally {
          await ctx.qa("kill.set", { clockId: w.clockId, scope: "AGENT", on: false });
        }
        await ctx.pause(KILL_CACHE_SEC);
        await say(ctx, w, f5.installerId, "Ya me alejé del poste, ¿seguimos?");
        const resumed = await settledOn(ctx, w, f5.installerId, [f5.workOrderId]);
        ctx.check(personIn(resumed, f5.installerId).turnNotes.length >= 1, "no turn after the cut was turned off");
      },
    },
  ],
});
