import { describe, expect, it } from "vitest";
import { timerRefKey } from "../connector/keys";
import { CASE_HOME, CLOCK, ORDER_HOME, PERSON_HOME, START_SIM, type TimeWorld, timeWorld } from "../timers/testing";
import { type ClockTarget, advanceClock, fireTimerNow, forceCaseTimeout } from "./advance";
import { FORCE_AFTER_MS, WorldBusyError } from "./busy";
import { setRunning } from "./modes";
import { currentClock } from "./state";

const at = (iso: string): string => new Date(iso).toISOString();
const QA = { actor: "QA" as const };
const CONSOLE = { actor: "USER:usr-sup-adriana" as const, gate: { force: false } };

function advance(world: TimeWorld, target: ClockTarget, caller: Parameters<typeof advanceClock>[0]["caller"] = QA) {
  return advanceClock({ clockId: CLOCK, target, caller }, { ...world.deps(), data: world.connector });
}

describe("advance_clock: one case per timer kind [FL-060] [FL-084]", () => {
  it("[FL-084] DAY_START: 'Iniciar el día' goes to 07:30 and dispatches every day start in order at its own dueAtSim", async () => {
    const world = await timeWorld();
    await world.timer({ home: PERSON_HOME, kind: "DAY_START", timerId: "inst-rogelio-2026-10-13", dueAtSim: "2026-10-13T07:30:00-06:00" });
    await world.timer({ home: { kind: "WORK_ORDER", id: "wo-24818" }, kind: "DAY_START", timerId: "early", dueAtSim: "2026-10-13T07:15:00-06:00" });
    const moved = await advance(world, { startDay: true });
    expect(moved).toMatchObject({ simNow: at("2026-10-13T07:30:00-06:00"), mode: "PAUSED", forced: false });
    expect(world.dispatcher.summary()).toEqual([`DAY_START@${at("2026-10-13T07:15:00-06:00")}/CLOCK`, `DAY_START@${at("2026-10-13T07:30:00-06:00")}/CLOCK`]);
    expect(world.dispatcher.sent.every((due) => due.installerId === "inst-rogelio" && due.worldEpoch === 1)).toBe(true);
    expect((await world.clock()).pausedSimNow).toBe(at("2026-10-13T07:30:00-06:00"));
    const audit = await world.connector.audit.listByMonth("isp-demo", "2026-10");
    expect(audit.find((row) => row.action === "CLOCK_ADVANCED")?.detail).toMatchObject({ move: "START_DAY", fired: 2 });
  });

  it("[FL-060] CASE_TIMEOUT: +10 min after the rung was notified dispatches the timeout at its dueAtSim", async () => {
    const world = await timeWorld({ simStart: "2026-10-13T11:50:00-06:00" });
    await world.timer({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY", dueAtSim: "2026-10-13T12:00:00-06:00", payload: { rungVersion: 0 } });
    await advance(world, { byMinutes: 5 });
    expect(world.dispatcher.sent).toHaveLength(0);
    await advance(world, { byMinutes: 5 });
    expect(world.dispatcher.summary()).toEqual([`CASE_TIMEOUT@${at("2026-10-13T12:00:00-06:00")}/CLOCK`]);
    expect(world.dispatcher.sent[0]?.timer.payload).toEqual({ rungVersion: 0 });
  });

  it("[FL-060] CASE_TIMEOUT: 'Forzar vencimiento' marks it FIRED (MANUAL) at simNow and the worker's claim is that firing", async () => {
    const world = await timeWorld({ simStart: "2026-10-13T11:52:00-06:00" });
    const timer = await world.timer({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY", dueAtSim: "2026-10-13T12:00:00-06:00" });
    const moved = await forceCaseTimeout({ caseId: CASE_HOME.id, caller: CONSOLE }, world.deps());
    expect(moved.simNow).toBe(at("2026-10-13T11:52:00-06:00"));
    expect(await world.connector.timers.getTimer({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY" })).toMatchObject({ status: "FIRED", firedBy: "MANUAL", firedAtSim: at("2026-10-13T11:52:00-06:00") });
    const due = world.dispatcher.sent[0];
    expect(due).toMatchObject({ firedBy: "MANUAL", eventAtSim: at("2026-10-13T11:52:00-06:00"), timer: { version: timer.version } });
    expect(await world.service.fire({ timerKey: timerRefKey(timer), version: due?.timer.version, firedBy: "MANUAL", eventAtSim: due?.eventAtSim })).toMatchObject({ status: "FIRED", eventAtSim: at("2026-10-13T11:52:00-06:00") });
    await expect(forceCaseTimeout({ caseId: CASE_HOME.id, caller: CONSOLE }, world.deps())).rejects.toMatchObject({ reason: "CASE_TIMEOUT_NOT_PENDING" });
    expect((await world.connector.audit.listByMonth("isp-demo", "2026-10")).map((row) => row.action)).toContain("CLOCK_CASE_TIMEOUT_FORCED");
  });

  it("[FL-073] DEFERRED_SEND: 'Avanzar al próximo evento' goes to its nextAllowedAt", async () => {
    const world = await timeWorld({ simStart: "2026-10-13T22:00:00-06:00" });
    await world.timer({ home: ORDER_HOME, kind: "DEFERRED_SEND", timerId: "msg-quiet", dueAtSim: "2026-10-14T07:00:00-06:00" });
    expect((await advance(world, { next: true })).simNow).toBe(at("2026-10-14T07:00:00-06:00"));
    expect(world.dispatcher.summary()).toEqual([`DEFERRED_SEND@${at("2026-10-14T07:00:00-06:00")}/CLOCK`]);
  });

  it("[FL-084] CERT_RETRY: +5 min dispatches the single resend; QA fires one timer now with clock.fireTimer", async () => {
    const world = await timeWorld({ simStart: "2026-10-13T10:40:00-06:00" });
    await world.timer({ home: ORDER_HOME, kind: "CERT_RETRY", timerId: "cert-1", dueAtSim: "2026-10-13T10:45:00-06:00" });
    const later = await world.timer({ home: { kind: "WORK_ORDER", id: "wo-24818" }, kind: "CERT_RETRY", timerId: "cert-2", dueAtSim: "2026-10-13T16:00:00-06:00" });
    await advance(world, { byMinutes: 5 });
    expect(world.dispatcher.summary()).toEqual([`CERT_RETRY@${at("2026-10-13T10:45:00-06:00")}/CLOCK`]);
    await fireTimerNow({ timerKey: timerRefKey(later), caller: QA }, world.deps());
    expect(world.dispatcher.summary()[1]).toBe(`CERT_RETRY@${at("2026-10-13T10:45:00-06:00")}/MANUAL`);
  });

  it("[FL-084] the clock never goes back, moves at most 3 days and only its own world", async () => {
    const world = await timeWorld();
    await world.connector.runtime.createClock({ clockId: "qa-812-1-sc-06", ispId: "isp-qa-812-1-sc-06", kind: "QA", mode: "PAUSED", offsetMs: 0, pausedSimNow: START_SIM, worldEpoch: 1 });
    await expect(advance(world, { to: "2026-10-13T06:00:00-06:00" })).rejects.toMatchObject({ code: "INVALID", reason: "CLOCK_BACKWARDS" });
    await expect(advance(world, { byMinutes: 3 * 24 * 60 + 1 })).rejects.toMatchObject({ reason: "CLOCK_MOVE_TOO_LONG" });
    await expect(advance(world, { next: true })).rejects.toMatchObject({ reason: "CLOCK_NOTHING_PENDING" });
    await advance(world, { byMinutes: 60 });
    expect(at((await world.clock("qa-812-1-sc-06")).pausedSimNow)).toBe(at(START_SIM));
  });
});

describe("live clock [FL-084]", () => {
  it("[FL-084] 'Reloj en vivo' schedules the horizon, an advance resyncs it, and after 30 minutes the world pauses itself", async () => {
    const world = await timeWorld();
    await world.timer({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY", dueAtSim: "2026-10-13T07:20:00-06:00" });
    await world.timer({ home: ORDER_HOME, kind: "DAY_START", timerId: "far", dueAtSim: "2026-10-13T09:30:00-06:00" });
    const running = await setRunning({ clockId: CLOCK, running: true, caller: QA }, world.deps());
    expect(running.mode).toBe("RUNNING");
    expect(world.scheduler.puts.map((spec) => spec.at.toISOString())).toEqual(["2026-10-13T13:20:00.000Z"]);
    await advance(world, { byMinutes: 10 });
    // The offset moved 10 minutes: the same schedule now fires 10 real minutes earlier.
    expect(world.scheduler.puts.at(-1)?.at.toISOString()).toBe("2026-10-13T13:10:00.000Z");
    world.advance(31 * 60_000);
    const paused = await currentClock(CLOCK, world.deps());
    expect(paused).toMatchObject({ mode: "PAUSED" });
    expect(new Date(paused.pausedSimNow).toISOString()).toBe("2026-10-13T13:40:00.000Z");
    await setRunning({ clockId: CLOCK, running: false, caller: QA }, world.deps());
    expect(world.scheduler.live.size).toBe(0);
  });
});

describe("busy world [FL-085]", () => {
  it("[FL-085] the console's moves answer WORLD_BUSY with the pending list; 'Avanzar igual' after 5 minutes is audited", async () => {
    const world = await timeWorld({ simStart: "2026-10-13T11:52:00-06:00" });
    await world.timer({ home: CASE_HOME, kind: "CASE_TIMEOUT", timerId: "PRIMARY", dueAtSim: "2026-10-13T12:00:00-06:00" });
    await world.connector.worlds.markInFlight("inst-rogelio", CLOCK, "TRANSCRIBE:wa-in-0123456789abcdef");
    await world.connector.worlds.markWorldInFlight(CLOCK, "wa-in-fedcba9876543210");
    await world.connector.worlds.addPendingMail(CLOCK, "mail-1");

    const busy = await advance(world, { byMinutes: 10 }, CONSOLE).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(WorldBusyError);
    expect((busy as WorldBusyError).reason).toBe("WORLD_BUSY");
    expect((busy as WorldBusyError).pending.map((item) => item.kind).sort()).toEqual(["MAIL", "TRANSCRIBE", "TURN"]);
    await expect(forceCaseTimeout({ caseId: CASE_HOME.id, caller: CONSOLE }, world.deps())).rejects.toBeInstanceOf(WorldBusyError);
    expect(at((await world.clock()).pausedSimNow)).toBe(at("2026-10-13T11:52:00-06:00"));

    // Forcing before five minutes is still a refusal; after them the move goes and is audited.
    await expect(advance(world, { byMinutes: 10 }, { ...CONSOLE, gate: { force: true } })).rejects.toBeInstanceOf(WorldBusyError);
    world.advance(FORCE_AFTER_MS);
    const forced = await advance(world, { byMinutes: 10 }, { ...CONSOLE, gate: { force: true } });
    expect(forced.forced).toBe(true);
    expect((await world.connector.audit.listByMonth("isp-demo", "2026-10")).map((row) => row.action)).toEqual(expect.arrayContaining(["CLOCK_FORCED", "CLOCK_ADVANCED"]));
  });

  it("[FL-085] a due timer nobody sent keeps the world busy; the QaDriver passes no gate", async () => {
    const world = await timeWorld();
    await world.timer({ home: ORDER_HOME, kind: "DAY_START", timerId: "lost", dueAtSim: "2026-10-13T06:00:00-06:00" });
    const busy = await advance(world, { byMinutes: 1 }, CONSOLE).catch((error: unknown) => error);
    expect((busy as WorldBusyError).pending).toEqual([expect.objectContaining({ kind: "EVENT", detail: "TIMER DAY_START" })]);
    const moved = await advance(world, { byMinutes: 1 });
    expect(moved.fired.map((ref) => ref.kind)).toEqual(["DAY_START"]);
  });
});
