import { describe, expect, it } from "vitest";
import { timerRefKey } from "../connector/keys";
import { advanceClock } from "../clock/advance";
import { unfreeze } from "../clock/modes";
import { armRungTimeout, rungWaitSeconds } from "../cases/timeouts";
import { queueTimerDispatcher, timerEventId, timerEventIdOf } from "./dispatch";
import { SCHEDULE_NAME_MAX, atExpression, schedulePlan, scheduleNameOf } from "./schedule";
import { CASE_HOME, CLOCK, ISP, ORDER_HOME, PERSON_HOME, START_SIM, timeWorld } from "./testing";

const at = (iso: string): string => new Date(iso).toISOString();
const DEMO_SETTINGS = { demoMode: true, demoCaseTimeoutSec: 60, caseTimeoutSec: 600 };

describe("timer schedules [FL-060] [FL-084]", () => {
  it("[FL-084] names a schedule tm-<w>-<hash> per world and timer, within 64 characters, and rounds at() up", () => {
    const ref = { home: CASE_HOME, kind: "CASE_TIMEOUT" as const, timerId: "PRIMARY" };
    const demo = scheduleNameOf(CLOCK, ref);
    expect(demo).toMatch(/^tm-d-[0-9a-f]{32}$/);
    expect(scheduleNameOf("GUEST#isp-guest-07", ref)).toMatch(/^tm-g-/);
    expect(scheduleNameOf("qa-812-1-sc-06", ref)).toMatch(/^tm-q-/);
    expect(scheduleNameOf("eval-812-1", ref)).toMatch(/^tm-e-/);
    expect(scheduleNameOf(CLOCK, { ...ref, home: { kind: "CASE", id: "case-01J9ZQX0000000000000000001" } })).not.toBe(demo);
    expect(demo.length).toBeLessThanOrEqual(SCHEDULE_NAME_MAX);
    expect(atExpression(new Date("2026-10-13T13:00:14.200Z"))).toBe("at(2026-10-13T13:00:15)");
  });

  it("[FL-060] a paused world never schedules; a running one schedules within the hour and the live window only", () => {
    const now = Date.parse("2026-10-13T13:00:00.000Z");
    const paused = { mode: "PAUSED" as const, pausedSimNow: START_SIM, offsetMs: 0, worldEpoch: 1 };
    const running = { mode: "RUNNING" as const, pausedSimNow: START_SIM, offsetMs: 0, worldEpoch: 1, runningUntilReal: "2026-10-13T13:30:00.000Z" };
    expect(schedulePlan("2026-10-13T07:10:00-06:00", paused, now)).toEqual({ kind: "NONE" });
    expect(schedulePlan("2026-10-13T07:00:00-06:00", paused, now)).toEqual({ kind: "DIRECT", firedBy: "CLOCK" });
    expect(schedulePlan("2026-10-13T07:00:15-06:00", running, now)).toEqual({ kind: "SCHEDULE", at: new Date("2026-10-13T13:00:15.000Z") });
    expect(schedulePlan("2026-10-13T06:59:59-06:00", running, now)).toEqual({ kind: "DIRECT", firedBy: "SCHEDULER" });
    expect(schedulePlan("2026-10-13T07:45:00-06:00", running, now)).toEqual({ kind: "NONE" });
  });
});

describe("TimerPort [FL-060] [FL-073] [FL-084]", () => {
  it("[FL-060] a timer under 20 s away in a running world gets its schedule, and the worker re-evaluates dueAtSim", async () => {
    const world = await timeWorld();
    await world.run(START_SIM);
    const armed = await world.service.armWithOutcome({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY", clockId: CLOCK, dueAtSim: "2026-10-13T07:00:15-06:00", payload: { rungVersion: 0 } });
    expect(armed.outcome).toBe("SCHEDULED");
    expect(world.scheduler.puts).toHaveLength(1);
    const [spec] = world.scheduler.puts;
    expect(spec?.at.toISOString()).toBe("2026-10-13T13:00:15.000Z");
    expect(spec?.input).toEqual({ clockId: CLOCK, timerKey: timerRefKey({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY" }), dueAtSim: at("2026-10-13T07:00:15-06:00"), version: armed.timer.version });
    expect(armed.timer.scheduleName).toBe(spec?.name);
    expect(world.dispatcher.sent).toHaveLength(0);

    // The schedule fires a second early: not due in the world yet, so it is re-armed and nothing runs.
    world.advance(14_000);
    const early = await world.service.fire({ timerKey: spec?.input.timerKey ?? "", version: spec?.input.version, firedBy: "SCHEDULER" });
    expect(early.status).toBe("NOT_DUE");
    expect(world.scheduler.puts).toHaveLength(2);
    const rearmed = world.scheduler.puts[1];
    expect(rearmed).toMatchObject({ name: spec?.name, input: { version: spec?.input.version } });

    world.advance(2_000);
    const fired = await world.service.fire({ timerKey: rearmed?.input.timerKey ?? "", version: rearmed?.input.version, firedBy: "SCHEDULER" });
    expect(fired).toMatchObject({ status: "FIRED", eventAtSim: at("2026-10-13T07:00:15-06:00"), timer: { status: "FIRED", firedBy: "SCHEDULER" } });
    // The same firing delivered again (a retried queue event) is the same claim; an older version is stale.
    expect((await world.service.fire({ timerKey: rearmed?.input.timerKey ?? "", version: rearmed?.input.version, firedBy: "SCHEDULER" })).status).toBe("FIRED");
    expect(await world.service.fire({ timerKey: spec?.input.timerKey ?? "", version: (spec?.input.version ?? 1) - 1, firedBy: "SCHEDULER" })).toMatchObject({ status: "STALE", reason: "NOT_SCHEDULED" });
  });

  it("[FL-060] demoCaseTimeoutSec only rules while the clock is RUNNING", async () => {
    const world = await timeWorld({ simStart: "2026-10-13T11:50:00-06:00" });
    await world.connector.isps.putSettings({
      ispId: ISP,
      clockId: CLOCK,
      quietHours: { start: "21:00", end: "07:00" },
      whatsappMode: "simulated",
      turnCaps: { perHour: 200, perDay: 1000 },
      simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 20 },
      ...DEMO_SETTINGS,
    });
    expect(rungWaitSeconds({ ...DEMO_SETTINGS, demoMode: false }, true)).toBe(600);
    const deps = { connector: world.connector, realClock: world.realClock, timers: world.service };
    const rung = { caseId: CASE_HOME.id, clockId: CLOCK, ispId: ISP, rungVersion: 0, notifiedAtSim: "2026-10-13T11:50:00-06:00" };
    expect(await armRungTimeout(deps, { ...rung, rung: "PRIMARY" })).toBe(at("2026-10-13T12:00:00-06:00"));
    expect(world.scheduler.puts).toHaveLength(0);
    await world.run("2026-10-13T11:50:00-06:00");
    expect(await armRungTimeout(deps, { ...rung, rung: "SECONDARY", rungVersion: 1 })).toBe(at("2026-10-13T11:51:00-06:00"));
    expect(world.scheduler.puts.map((spec) => spec.at.toISOString())).toEqual([new Date(world.now().getTime() + 60_000).toISOString()]);
    // A live window that ended reads as paused again.
    world.advance(31 * 60_000);
    expect(await armRungTimeout(deps, { ...rung, rung: "ZONE_CHIEF", rungVersion: 2, notifiedAtSim: "2026-10-13T12:21:00-06:00" })).toBe(at("2026-10-13T12:31:00-06:00"));
  });

  it("[FL-084] arming twice returns the timer unchanged; an already due timer is dispatched at once", async () => {
    const world = await timeWorld();
    const request = { home: ORDER_HOME, kind: "DAY_START" as const, timerId: "inst-rogelio-2026-10-13", clockId: CLOCK, dueAtSim: "2026-10-13T07:30:00-06:00" };
    const first = await world.service.armWithOutcome(request);
    expect(first.outcome).toBe("NONE");
    expect(await world.service.armWithOutcome({ ...request, dueAtSim: "2026-10-13T08:00:00-06:00" })).toMatchObject({ outcome: "EXISTING", timer: { dueAtSim: at(request.dueAtSim), version: 1 } });
    const due = await world.service.armWithOutcome({ ...request, home: PERSON_HOME, timerId: "late", dueAtSim: "2026-10-13T06:59:00-06:00" });
    expect(due.outcome).toBe("DISPATCHED");
    expect(world.dispatcher.sent[0]).toMatchObject({ installerId: "inst-rogelio", firedBy: "CLOCK", eventId: timerEventId(due.timer, 1) });
    expect(world.scheduler.puts).toHaveLength(0);
  });

  it("[FL-073] reschedule moves the timer and its schedule; cancel deletes the schedule; locate names the installer", async () => {
    const world = await timeWorld();
    await world.run(START_SIM);
    const timer = await world.service.arm({ home: ORDER_HOME, kind: "DEFERRED_SEND", timerId: "msg-1", clockId: CLOCK, dueAtSim: "2026-10-13T07:10:00-06:00", payload: { messageId: "msg-1" } });
    const moved = await world.service.reschedule({ home: ORDER_HOME, kind: "DEFERRED_SEND", timerId: "msg-1" }, "2026-10-13T07:20:00-06:00");
    expect(moved.version).toBeGreaterThan(timer.version);
    expect(world.scheduler.live.get(moved.scheduleName ?? "")?.input).toMatchObject({ dueAtSim: at("2026-10-13T07:20:00-06:00"), version: moved.version });
    expect(await world.service.locate(timerRefKey(moved))).toMatchObject({ installerId: "inst-rogelio" });
    expect(await world.service.locate(timerRefKey({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "nope" }))).toBeUndefined();
    const cancelled = await world.service.cancel({ home: ORDER_HOME, kind: "DEFERRED_SEND", timerId: "msg-1" }, "superseded");
    expect(cancelled).toMatchObject({ status: "CANCELLED", reason: "superseded" });
    expect(world.scheduler.live.size).toBe(0);
    expect(await world.service.fire({ timerKey: timerRefKey(moved), version: moved.version, firedBy: "SCHEDULER" })).toMatchObject({ status: "STALE", reason: "NOT_SCHEDULED" });
  });

  it("[FL-073] a deferred send at nextAllowedAt 07:00 fires when the clock reaches it, as a TIMER of the installer's queue", async () => {
    const world = await timeWorld({ simStart: "2026-10-13T22:00:00-06:00" });
    await world.service.arm({ home: ORDER_HOME, kind: "DEFERRED_SEND", timerId: "msg-quiet", clockId: CLOCK, dueAtSim: "2026-10-14T07:00:00-06:00", payload: { messageId: "msg-quiet" } });
    const moved = await advanceClock({ clockId: CLOCK, target: { next: true }, caller: { actor: "QA" } }, { ...world.deps(), data: world.connector });
    expect(moved.simNow).toBe(at("2026-10-14T07:00:00-06:00"));
    expect(world.dispatcher.summary()).toEqual([`DEFERRED_SEND@${at("2026-10-14T07:00:00-06:00")}/CLOCK`]);
    const due = world.dispatcher.sent[0];
    if (due === undefined) throw new Error("nothing dispatched");
    const queued: unknown[] = [];
    await queueTimerDispatcher({ enqueue: async (event) => void queued.push(event) }).dispatch(due);
    const timerKey = timerRefKey(due.timer);
    expect(queued).toEqual([{ type: "TIMER", eventId: due.eventId, clockId: CLOCK, ispId: "isp-demo", installerId: "inst-rogelio", timerKey, dueAtSim: due.timer.dueAtSim, version: due.timer.version, firedBy: "CLOCK" }]);
    expect(due.eventId).toBe(timerEventIdOf({ clockId: CLOCK, worldEpoch: 1, timerKey, dueAtSim: "2026-10-14T07:00:00-06:00", version: due.timer.version }));
    // The same timer in the next epoch of the world (a reset rewrites it identically) is another event.
    expect(timerEventId(due.timer, 2)).not.toBe(due.eventId);
    const fired = await world.service.fire({ timerKey, version: due.timer.version, firedBy: "CLOCK", eventAtSim: due.eventAtSim });
    expect(fired).toMatchObject({ status: "FIRED", eventAtSim: at("2026-10-14T07:00:00-06:00"), timer: { status: "FIRED", firedBy: "CLOCK" } });
  });

  it("[FL-060] a firing of another version, or of a timer that already fired, is stale; a timer gone with its world is missing", async () => {
    const world = await timeWorld();
    const timer = await world.timer({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY", dueAtSim: "2026-10-13T07:00:00-06:00" });
    const timerKey = timerRefKey(timer);
    expect(await world.service.fire({ timerKey, version: timer.version + 1, firedBy: "SCHEDULER" })).toMatchObject({ status: "STALE", reason: "VERSION" });
    expect(await world.service.fire({ timerKey, version: timer.version, firedBy: "CLOCK" })).toMatchObject({ status: "FIRED" });
    expect(await world.service.fire({ timerKey, version: timer.version, firedBy: "SCHEDULER" })).toMatchObject({ status: "STALE", reason: "NOT_SCHEDULED" });
    await world.connector.timers.deleteTimer({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY" });
    expect(await world.service.fire({ timerKey, version: timer.version, firedBy: "CLOCK" })).toEqual({ status: "MISSING" });
    expect(await world.service.fire({ timerKey: "not-a-key", firedBy: "CLOCK" })).toEqual({ status: "MISSING" });
  });

  it("[FL-084] unfreeze never moves the clock back, runs it and schedules the next timer", async () => {
    const world = await timeWorld({ simStart: "2026-10-13T11:59:00-06:00" });
    const timer = await world.timer({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY", dueAtSim: "2026-10-13T12:00:00-06:00" });
    const unfrozen = await unfreeze({ clockId: CLOCK }, world.deps());
    // 120 s of lead would put the clock at 11:58: it stays at 11:59.
    expect(unfrozen.simNow).toBe(at("2026-10-13T11:59:00-06:00"));
    expect(unfrozen.dueAtReal).toBe(new Date(world.now().getTime() + 60_000).toISOString());
    expect((await world.clock()).mode).toBe("RUNNING");
    expect(world.scheduler.puts.map((spec) => spec.input.timerKey)).toEqual([timerRefKey(timer)]);

    const later = await timeWorld({ simStart: "2026-10-13T11:00:00-06:00" });
    const target = await later.timer({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY", dueAtSim: "2026-10-13T12:00:00-06:00" });
    const byKey = await unfreeze({ clockId: CLOCK, timerKey: timerRefKey(target), leadSec: 90 }, later.deps());
    expect(byKey.simNow).toBe(at("2026-10-13T11:58:30-06:00"));
    await expect(unfreeze({ clockId: CLOCK }, later.deps())).rejects.toMatchObject({ reason: "CLOCK_RUNNING" });
  });
});
