// `advance_clock` and `force_case_timeout` (docs/architecture.md §8, docs/tool-catalog.md): how the
// console and the `QaDriver` move a world's simulated time.
//
//   advance(Δ)        Δ from 1 minute to 3 days ("+10 min", "+1 h")
//   advanceTo(iso)    forward only, at most 3 days ahead
//   advanceToNext()   to the `dueAtSim` of the next SCHEDULED timer of any kind
//   startDay()        "Iniciar el día": `advanceTo(07:30)` of the world's day (the next day's once past)
//   forceCaseTimeout  the pending CASE_TIMEOUT of a case is `FIRED (MANUAL)` at the world's now, without
//                     moving the clock, and sent to the installer's queue
//   fireTimer         the `QaDriver`'s `clock.fireTimer({timerKey})`: the same for any SCHEDULED timer
//
// A move keeps the mode (a paused world gets a new `pausedSimNow`, a running one a new `offsetMs`) with a
// write pinned to the clock's version, dispatches every timer that fell due, oldest first, as
// `firedBy CLOCK` at its own `dueAtSim`, and in a RUNNING world resynchronizes the schedules of the rest.
// The clock never goes back; only "Reiniciar demo" reloads a world (clock/reset.ts). From the console a
// move needs a quiet world (clock/busy.ts); the `QaDriver` passes no gate.
import { addCalendarDays } from "@cuadrilla/shared";
import { parseTimerRefKey } from "../connector/keys";
import type { Connector } from "../connector/ports";
import type { Clock as StoredClock } from "../domain/runtime";
import type { Timer } from "../domain/timers";
import { moveTo } from "../lib/clock";
import { localDateOf, zonedInstant } from "../services/business-hours/zoned-time";
import { keyOfTimer } from "../timers/dispatch";
import { dispatchTimer, refOf } from "../timers/timers";
import { assertWorldQuiet } from "./busy";
import { type ClockCaller, type ClockDeps, type ClockMoved, auditClock, currentClock, dispatchDue, invalid, resyncWorld, scheduledTimers, viewOf, writeClock } from "./state";

/** No single move goes further than this (docs/architecture.md §8). */
export const MAX_MOVE_MS = 3 * 24 * 60 * 60_000;

/** "Iniciar el día": the instant every installer's DAY_START is due (docs/seed-spec.md). */
export const DAY_START_TIME = "07:30";
export const DEFAULT_TIME_ZONE = "America/Mexico_City";

export type ClockTarget = { readonly byMinutes: number } | { readonly to: string } | { readonly next: true } | { readonly startDay: true };

export interface AdvanceDeps extends ClockDeps {
  readonly data: ClockDeps["data"] & Pick<Connector, "isps">;
}

const MOVE_NAMES = { byMinutes: "ADVANCE", to: "ADVANCE_TO", next: "ADVANCE_TO_NEXT", startDay: "START_DAY" } as const;

function moveName(target: ClockTarget): (typeof MOVE_NAMES)[keyof typeof MOVE_NAMES] {
  if ("byMinutes" in target) return MOVE_NAMES.byMinutes;
  if ("to" in target) return MOVE_NAMES.to;
  if ("next" in target) return MOVE_NAMES.next;
  return MOVE_NAMES.startDay;
}

async function startOfDay(clock: StoredClock, simNow: Date, deps: AdvanceDeps): Promise<number> {
  const timeZone = (await deps.data.isps.getSettings(clock.ispId))?.timezone ?? DEFAULT_TIME_ZONE;
  const today = localDateOf(simNow, timeZone);
  const at = zonedInstant(today, DAY_START_TIME, timeZone).getTime();
  return at >= simNow.getTime() ? at : zonedInstant(addCalendarDays(today, 1), DAY_START_TIME, timeZone).getTime();
}

async function targetOf(clock: StoredClock, target: ClockTarget, simNow: Date, deps: AdvanceDeps): Promise<Date> {
  const from = simNow.getTime();
  let to: number;
  if ("byMinutes" in target) {
    if (!Number.isInteger(target.byMinutes) || target.byMinutes <= 0) throw invalid("a move is a whole, positive number of minutes", "CLOCK_INVALID_MOVE");
    to = from + target.byMinutes * 60_000;
  } else if ("to" in target) {
    to = Date.parse(target.to);
    if (Number.isNaN(to)) throw invalid("the target is not an instant", "CLOCK_INVALID_MOVE");
    if (to < from) throw invalid("the clock never goes back", "CLOCK_BACKWARDS");
  } else if ("next" in target) {
    const [next] = await scheduledTimers(clock, deps);
    if (next === undefined) throw invalid("nothing is pending in this world", "CLOCK_NOTHING_PENDING");
    to = Math.max(from, Date.parse(next.dueAtSim));
  } else {
    to = await startOfDay(clock, simNow, deps);
  }
  if (to - from > MAX_MOVE_MS) throw invalid("a move goes at most 3 days ahead", "CLOCK_MOVE_TOO_LONG");
  return new Date(to);
}

async function gate(clock: StoredClock, caller: ClockCaller, deps: ClockDeps): Promise<boolean> {
  if (caller.gate === undefined) return false;
  return (await assertWorldQuiet({ clock, force: caller.gate.force, actor: caller.actor }, deps)).forced;
}

/** `advance`, `advanceTo`, `advanceToNext` or `startDay` of one world. */
export async function advanceClock(input: { readonly clockId: string; readonly target: ClockTarget; readonly caller: ClockCaller }, deps: AdvanceDeps): Promise<ClockMoved> {
  const stored = await currentClock(input.clockId, deps);
  const forced = await gate(stored, input.caller, deps);
  const realNow = await deps.realClock.now();
  const before = viewOf(stored, realNow);
  const to = await targetOf(stored, input.target, before.simNow, deps);
  const clock = to.getTime() === before.simNow.getTime() ? stored : await writeClock(stored, moveTo(stored, to, realNow.getTime()), deps);
  const fired = await dispatchDue(clock, to, deps);
  const after = viewOf(clock, realNow);
  if (after.running) await resyncWorld(clock, to, deps);
  await auditClock(deps, {
    clock,
    action: "CLOCK_ADVANCED",
    actor: input.caller.actor,
    atSim: to.toISOString(),
    detail: { fromSim: before.simNow.toISOString(), toSim: to.toISOString(), move: moveName(input.target), fired: fired.length, forced },
  });
  return { clockId: clock.clockId, mode: after.running ? "RUNNING" : "PAUSED", simNow: to.toISOString(), worldEpoch: clock.worldEpoch, fired, forced };
}

/**
 * Marks a SCHEDULED timer `FIRED (MANUAL)` at the world's now and sends it to its installer's queue with
 * the version it had, so the worker's claim (`TimerPort.fire`) reads it as this same firing.
 */
async function fireNow(clock: StoredClock, timer: Timer, caller: ClockCaller, forced: boolean, action: string, deps: ClockDeps): Promise<ClockMoved> {
  const view = viewOf(clock, await deps.realClock.now());
  const simNow = view.simNow.toISOString();
  if (timer.scheduleName !== undefined) await deps.scheduler.delete(timer.scheduleName);
  await deps.data.timers.setTimerStatus(refOf(timer), { status: "FIRED", firedBy: "MANUAL", firedAtSim: simNow }, timer.version);
  await dispatchTimer(timer, { firedBy: "MANUAL", eventAtSim: simNow, worldEpoch: clock.worldEpoch }, deps);
  const timerKey = keyOfTimer(timer);
  await auditClock(deps, {
    clock,
    action,
    actor: caller.actor,
    atSim: simNow,
    refs: { timerKey, ...(timer.home.kind === "CASE" ? { caseId: timer.home.id } : {}), ...(timer.home.kind === "WORK_ORDER" ? { workOrderId: timer.home.id } : {}) },
    detail: { kind: timer.kind, dueAtSim: timer.dueAtSim, forced },
  });
  return { clockId: clock.clockId, mode: view.running ? "RUNNING" : "PAUSED", simNow, worldEpoch: clock.worldEpoch, fired: [{ timerKey, kind: timer.kind, dueAtSim: timer.dueAtSim }], forced };
}

/** "Forzar vencimiento del caso": the pending CASE_TIMEOUT fires now (`eventAtSim = simNow`). */
export async function forceCaseTimeout(input: { readonly caseId: string; readonly caller: ClockCaller }, deps: ClockDeps): Promise<ClockMoved> {
  const caseItem = await deps.data.cases.requireCase(input.caseId);
  const clock = await currentClock(caseItem.clockId, deps);
  const forced = await gate(clock, input.caller, deps);
  const pending = (await deps.data.timers.listTimers({ kind: "CASE", id: caseItem.caseId })).filter((timer) => timer.kind === "CASE_TIMEOUT" && timer.status === "SCHEDULED");
  const [timer] = pending.sort((a, b) => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim));
  if (timer === undefined) throw invalid("this case has no pending timeout", "CASE_TIMEOUT_NOT_PENDING");
  return fireNow(clock, timer, input.caller, forced, "CLOCK_CASE_TIMEOUT_FORCED", deps);
}

/** `clock.fireTimer({timerKey})` of the `QaDriver`: one SCHEDULED timer fires now. */
export async function fireTimerNow(input: { readonly timerKey: string; readonly caller: ClockCaller }, deps: ClockDeps): Promise<ClockMoved> {
  const ref = parseTimerRefKey(input.timerKey);
  if (ref === undefined) throw invalid("not a timer key", "TIMER_KEY_INVALID");
  const timer = await deps.data.timers.getTimer(ref);
  if (timer === undefined || timer.status !== "SCHEDULED") throw invalid("this timer is not pending", "TIMER_NOT_PENDING");
  const clock = await currentClock(timer.clockId, deps);
  const forced = await gate(clock, input.caller, deps);
  return fireNow(clock, timer, input.caller, forced, "CLOCK_TIMER_FIRED", deps);
}
