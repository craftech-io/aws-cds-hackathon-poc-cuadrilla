// SC-06 · the ladder (docs/test-plan.md §4.5; FL-054, FL-059 … FL-062, FL-066, FL-021/023 through the agent).
// Every case runs in a world of its own, so each has its own roster (two supervisors and a zone chief cloned
// for that world) and no message of one case reaches the people of another. The cases of the `det` steps are
// opened by the `case` preset or by `case.open`, both the real `open_case` in the installer's queue.
import type { QaOperation } from "../../packages/bff/src/worlds/templates";
import { DAY, at, decided, orderIn, personIn, say, settledOn, tap, withAction } from "./lib/assist";
import { CREW_N3, caseIn, caseOn, caseSnapshot, caseTimersIn } from "./lib/cases";
import { type ScenarioContext, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { agentReplies, citationProblem, outOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, type WorldRequest, createWorld, op, staff, stored } from "./lib/world";

const START = at(DAY, "11:40");
const OPEN_CASE = { case: { reason: "DIAGNOSIS_ATTEMPTS", rung: "PRIMARY", status: "OPEN" } } as const;
const caseWorld = (preset: NonNullable<QaOperation["preset"]> = OPEN_CASE, settings: WorldRequest["settings"] = { demoMode: false }): WorldRequest => ({
  startAtSim: START,
  settings,
  operations: [{ key: "k", model: "wo-24818", installer: "own", preset: { activeWorkOrderId: true, ...preset } }],
});
const named = (ctx: ScenarioContext, name: string) => stored<World>(ctx, name);

/** The CASE_REQUEST template a supervisor got for the case. */
function requested(snapshot: Parameters<typeof personIn>[0], personId: string, template: string) {
  return outOf(personIn(snapshot, personId).messages, { kind: "CASE_REQUEST", templateName: template });
}

export default defineScenario({
  id: "SC-06",
  slug: "sc-06",
  title: "The ladder",
  suites: ["full"],
  async setup(ctx) {
    ctx.state.a = await createWorld(ctx, caseWorld({ onu: { behaviour: "LOW_POWER" } }), "a");
    ctx.state.a2 = await createWorld(ctx, caseWorld(), "a2");
    ctx.state.b = await createWorld(ctx, caseWorld(), "b");
    ctx.state.c = await createWorld(ctx, caseWorld({}), "c");
    ctx.state.s = await createWorld(ctx, caseWorld(), "s");
    ctx.state.d = await createWorld(ctx, caseWorld({}, { demoMode: true }), "demo");
    const c = named(ctx, "c");
    for (const supervisor of [CREW_N3.primary, CREW_N3.secondary]) await ctx.qa("wa.inbound", { clockId: c.clockId, identity: staff(c, supervisor), content: { type: "text", text: "BAJA" } });
    await ctx.qa("world.settle", { clockId: c.clockId, timeoutSec: WAITS.settleSec });
  },
  steps: [
    {
      id: "1",
      title: "a: three failed steps → the case → caso_escalado to the supervisor on duty and the CASE_NOTICE",
      kind: "agent",
      flows: ["FL-021", "FL-023", "FL-054"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "a");
        const k = op(w, "k");
        for (const text of ["La potencia sale muy baja, ¿qué hago?", "Ya limpié el conector y sigue igual", "Ya revisé la curvatura y sigue igual", "Cambié el conector y sigue igual"]) {
          await say(ctx, w, k.installerId, text);
          await settledOn(ctx, w, k.installerId, [k.workOrderId]);
        }
        const primary = staff(w, CREW_N3.primary);
        const snapshot = await settledOn(ctx, w, k.installerId, [k.workOrderId], [k.installerId, primary]);
        const order = orderIn(snapshot, k.workOrderId);
        ctx.check(order.checklist.find((item) => item.item === "ONU_ONLINE")?.status !== "PASSED", "ONU_ONLINE passed with the power out of range");
        ctx.check(agentReplies(personIn(snapshot, k.installerId).messages).some((reply) => citationProblem(order, reply, ["DIAG-03", "MED-01"]) === undefined), "no reply cites §DIAG-03 or §MED-01");
        ctx.exactly(snapshot, 1, "DIAGNOSIS_ATTEMPTS cases", order.cases.filter((entry) => entry.reason === "DIAGNOSIS_ATTEMPTS"));
        ctx.exactly(snapshot, 1, "caso_escalado to the supervisor on duty", requested(snapshot, primary, "caso_escalado"));
        ctx.exactly(snapshot, 1, "CASE_NOTICE to the installer", outOf(personIn(snapshot, k.installerId).messages, { kind: "CASE_NOTICE" }));
      },
    },
    {
      id: "2",
      title: "a2: the preset opened the case by the real open_case → PRIMARY, ladder[0] NOTIFIED; → +10 min → caso_reasignado to the backup",
      kind: "det",
      flows: ["FL-054", "FL-060"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "a2");
        const k = op(w, "k");
        const opened = await caseOn(ctx, w, "k");
        const primary = staff(w, CREW_N3.primary);
        const backup = staff(w, CREW_N3.secondary);
        let snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, [primary, backup]);
        const notified = caseIn(snapshot, opened.caseId);
        ctx.check(notified.rung === "PRIMARY" && notified.ladder[0]?.outcome === "NOTIFIED", `rung ${notified.rung}, ladder[0] ${notified.ladder[0]?.outcome ?? "none"}`);
        ctx.exactly(snapshot, 1, "caso_escalado to the supervisor on duty", requested(snapshot, primary, "caso_escalado"));
        ctx.exactly(snapshot, 1, "CASE_NOTICE to the installer", outOf(personIn(snapshot, k.installerId).messages, { kind: "CASE_NOTICE" }));
        await ctx.qa("clock.advance", { clockId: w.clockId, minutes: 10 });
        snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, [primary, backup]);
        ctx.check(caseIn(snapshot, opened.caseId).rung === "SECONDARY", "the case did not move to the backup");
        ctx.exactly(snapshot, 1, "caso_reasignado to the backup", requested(snapshot, backup, "caso_reasignado"));
      },
    },
    {
      id: "3",
      title: "a2: → +10 min → ZONE_CHIEF_ALERT with DELIVERY; the case stays OPEN",
      kind: "det",
      flows: ["FL-061"],
      after: "2",
      async run(ctx) {
        const w = named(ctx, "a2");
        const opened = await caseOn(ctx, w, "k");
        await ctx.qa("clock.advance", { clockId: w.clockId, minutes: 10 });
        const snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, []);
        const item = caseIn(snapshot, opened.caseId);
        ctx.check(item.rung === "ZONE_CHIEF" && item.status === "OPEN", `rung ${item.rung}, ${item.status}`);
        const alert = orderIn(snapshot, op(w, "k").workOrderId).emails.find((email) => email.kind === "ZONE_CHIEF_ALERT");
        ensure(alert !== undefined, "no ZONE_CHIEF_ALERT");
        const outcome = (await ctx.qa("mail.outcome", { clockId: w.clockId, mailId: alert.mailId, until: "FINAL", timeoutSec: WAITS.emailSec })) as { events: Array<{ type: string }> };
        ctx.check(outcome.events.some((event) => event.type === "DELIVERY"), "the alert did not reach DELIVERY");
        ctx.check(caseTimersIn(snapshot, opened.caseId).every((timer) => timer.status !== "SCHEDULED"), "a timer is still pending after the zone chief");
      },
    },
    {
      id: "4",
      title: "a2: the supervisor on duty taps the old button → TAKEN; the backup taps after → CASE_TAKE_LOST",
      kind: "det",
      flows: ["FL-062"],
      after: "3",
      async run(ctx) {
        const w = named(ctx, "a2");
        const opened = await caseOn(ctx, w, "k");
        const primary = staff(w, CREW_N3.primary);
        const backup = staff(w, CREW_N3.secondary);
        await tap(ctx, w, primary, "TAKE_CASE");
        await ctx.qa("world.settle", { clockId: w.clockId, timeoutSec: WAITS.settleSec });
        await tap(ctx, w, backup, "TAKE_CASE");
        const snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, [primary, backup]);
        const item = caseIn(snapshot, opened.caseId);
        ctx.check(item.status === "TAKEN" && item.takenBy === primary, `the case is ${item.status} by ${item.takenBy ?? "nobody"}`);
        ctx.check(decided(snapshot.decisions, "ACTION", undefined, "CASE_TAKE_LOST").length + decided(orderIn(snapshot, op(w, "k").workOrderId).decisions, "ACTION", undefined, "CASE_TAKE_LOST").length > 0, "no CASE_TAKE_LOST");
      },
    },
    {
      id: "5",
      title: "b: \"No puedo\" of the supervisor on duty → reassigned without waiting",
      kind: "det",
      flows: ["FL-059"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "b");
        const opened = await caseOn(ctx, w, "k");
        const backup = staff(w, CREW_N3.secondary);
        await tap(ctx, w, staff(w, CREW_N3.primary), "DECLINE_CASE");
        const snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, [backup]);
        const item = caseIn(snapshot, opened.caseId);
        ctx.check(item.rung === "SECONDARY" && item.ladder[0]?.outcome === "DECLINED", `rung ${item.rung}, ladder[0] ${item.ladder[0]?.outcome ?? "none"}`);
        ctx.exactly(snapshot, 1, "caso_reasignado to the backup", requested(snapshot, backup, "caso_reasignado"));
        const timers = caseTimersIn(snapshot, opened.caseId);
        ctx.check(timers.some((timer) => timer.status === "CANCELLED") && timers.some((timer) => timer.status === "SCHEDULED"), "the PRIMARY timeout was not cancelled and the SECONDARY one armed");
      },
    },
    {
      id: "6",
      title: "b: \"No puedo\" of the backup → the alert",
      kind: "det",
      flows: ["FL-061"],
      after: "5",
      async run(ctx) {
        const w = named(ctx, "b");
        const opened = await caseOn(ctx, w, "k");
        await tap(ctx, w, staff(w, CREW_N3.secondary), "DECLINE_CASE");
        const snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, []);
        ctx.check(caseIn(snapshot, opened.caseId).rung === "ZONE_CHIEF", "the case did not reach the zone chief");
        ctx.exactly(snapshot, 1, "ZONE_CHIEF_ALERT emails", orderIn(snapshot, op(w, "k").workOrderId).emails.filter((email) => email.kind === "ZONE_CHIEF_ALERT"));
      },
    },
    {
      id: "7",
      title: "c: both supervisors opted out → case.open → the alert at once",
      kind: "det",
      flows: ["FL-066"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "c");
        await ctx.qa("case.open", { workOrderId: op(w, "k").workOrderId, reason: "OTHER" });
        const opened = await caseOn(ctx, w, "k");
        const snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, [staff(w, CREW_N3.primary), staff(w, CREW_N3.secondary)]);
        const item = caseIn(snapshot, opened.caseId);
        ctx.check(item.ladder.map((entry) => entry.outcome).join(",") === "SKIPPED,SKIPPED,NOTIFIED", `ladder ${item.ladder.map((entry) => entry.outcome).join(",")}`);
        ctx.exactly(snapshot, 1, "ZONE_CHIEF_ALERT emails", orderIn(snapshot, op(w, "k").workOrderId).emails.filter((email) => email.kind === "ZONE_CHIEF_ALERT"));
        ctx.none(snapshot, "pending timers of the case", caseTimersIn(snapshot, opened.caseId).filter((timer) => timer.status === "SCHEDULED"));
        ctx.none(snapshot, "templates to the supervisors who opted out", [...outOf(personIn(snapshot, staff(w, CREW_N3.primary)).messages, { kind: "CASE_REQUEST" }), ...outOf(personIn(snapshot, staff(w, CREW_N3.secondary)).messages, { kind: "CASE_REQUEST" })]);
      },
    },
    {
      id: "8",
      title: "schedule.fireStale with an old version → ignored",
      kind: "det",
      flows: ["FL-060"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "s");
        const opened = await caseOn(ctx, w, "k");
        const before = await caseSnapshot(ctx, w, "k", opened.caseId, []);
        const pending = caseTimersIn(before, opened.caseId).find((timer) => timer.kind === "CASE_TIMEOUT" && timer.status === "SCHEDULED");
        ensure(pending !== undefined, "the case has no pending timeout");
        await ctx.qa("schedule.fireStale", { clockId: w.clockId, timerKey: pending.timerKey, staleBy: 1 });
        const after = await caseSnapshot(ctx, w, "k", opened.caseId, []);
        const item = caseIn(after, opened.caseId);
        ctx.check(item.rung === "PRIMARY" && item.rungVersion === caseIn(before, opened.caseId).rungVersion, "the stale firing moved the case");
        ctx.check(caseTimersIn(after, opened.caseId).find((timer) => timer.timerKey === pending.timerKey)?.status === "SCHEDULED", "the timer did not stay pending");
        ctx.check(withAction(after.decisions, "TIMER_STALE").length > 0, "the stale firing was not audited (TIMER_STALE)");
      },
    },
    {
      id: "9",
      title: "d (demo mode): clock.unfreeze → case.open → the 60 s CASE_TIMEOUT fired by the real Scheduler ≤ 150 s → clock.freeze",
      kind: "det",
      flows: ["FL-060", "FL-084"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "d");
        await ctx.qa("clock.unfreeze", { clockId: w.clockId });
        try {
          await ctx.qa("case.open", { workOrderId: op(w, "k").workOrderId, reason: "OTHER" });
          const opened = await caseOn(ctx, w, "k");
          const started = ctx.now();
          await ctx.eventually(
            "the CASE_TIMEOUT by the Scheduler",
            async () => {
              const snapshot = await ctx.snapshot({ clockId: w.clockId, caseIds: [opened.caseId] });
              return caseTimersIn(snapshot, opened.caseId).some((timer) => timer.kind === "CASE_TIMEOUT" && timer.status === "FIRED" && timer.firedBy === "SCHEDULER") && caseIn(snapshot, opened.caseId).rung === "SECONDARY";
            },
            WAITS.caseTimeoutSec,
          );
          ctx.latency("caseTimeoutMs", ctx.now() - started);
        } finally {
          await ctx.qa("clock.freeze", { clockId: w.clockId });
        }
      },
    },
  ],
});
