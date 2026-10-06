// What every move of a world's demo clock shares (ADR-0010, docs/architecture.md §8): reading
// `Runtime/CLOCK#<clockId>` (a RUNNING world past its live window is written back as PAUSED at the
// instant it reached), writing a mode or time change pinned to the version it read (a concurrent move
// loses with CONFLICT), dispatching the timers that fell due in `dueAtSim` order, resynchronizing the
// schedules of a RUNNING world so none keeps a `dueAtReal` computed with an old `offsetMs`, and the
// `ACTION CLOCK_*` rows of the audit log.
import { ToolError } from "@cuadrilla/shared";
import type { Connector, DecisionInput } from "../connector/ports";
import type { Actor, JsonObject } from "../domain/common";
import type { Clock as StoredClock } from "../domain/runtime";
import type { Timer } from "../domain/timers";
import { type ClockPatch, isRunning, pauseAt, simNowOf } from "../lib/clock";
import { keyOfTimer } from "../timers/dispatch";
import { type TimerDeps, dispatchTimer, readWorldClock, syncSchedule } from "../timers/timers";

export interface ClockDeps extends TimerDeps {
  readonly data: Pick<Connector, "timers" | "runtime" | "workOrders" | "cases" | "audit" | "worlds">;
}

/** Who moves the clock; `gate` is the console's (`WORLD_BUSY`), absent for the `QaDriver`. */
export interface ClockCaller {
  readonly actor: Actor;
  readonly gate?: { readonly force: boolean };
}

/** A timer the clock sent to its installer's queue. */
export interface FiredRef {
  readonly timerKey: string;
  readonly kind: Timer["kind"];
  readonly dueAtSim: string;
}

export interface ClockMoved {
  readonly clockId: string;
  readonly mode: "PAUSED" | "RUNNING";
  readonly simNow: string;
  readonly worldEpoch: number;
  readonly fired: readonly FiredRef[];
  /** "Avanzar igual" was accepted for a busy world. */
  readonly forced: boolean;
}

export interface ClockView {
  readonly clock: StoredClock;
  readonly simNow: Date;
  readonly running: boolean;
}

export function viewOf(clock: StoredClock, realNow: Date): ClockView {
  const now = realNow.getTime();
  return { clock, simNow: simNowOf(clock, now), running: isRunning(clock, now) };
}

export function invalid(message: string, reason: string): ToolError {
  return new ToolError("INVALID", message, reason);
}

/**
 * Writes a transition pinned to the version of `clock`; CONFLICT when someone moved it in between. A
 * pause keeps the last `runningUntilReal`: a PAUSED clock never reads it (lib/clock.ts).
 */
export async function writeClock(clock: StoredClock, patch: ClockPatch, deps: { readonly data: Pick<Connector, "runtime"> }): Promise<StoredClock> {
  return deps.data.runtime.updateClock(
    clock.clockId,
    { mode: patch.mode, pausedSimNow: patch.pausedSimNow, offsetMs: patch.offsetMs, ...(patch.runningUntilReal === undefined ? {} : { runningUntilReal: patch.runningUntilReal }) },
    clock.version,
  );
}

/** The clock as it is now: a RUNNING world past `runningUntilReal` is written back as PAUSED first. */
export async function currentClock(clockId: string, deps: { readonly data: Pick<Connector, "runtime">; readonly realClock: ClockDeps["realClock"] }): Promise<StoredClock> {
  const clock = await readWorldClock(deps.data, clockId);
  const now = (await deps.realClock.now()).getTime();
  if (clock.mode !== "RUNNING" || isRunning(clock, now)) return clock;
  return writeClock(clock, pauseAt(clock, now), deps);
}

const byDue = (a: Timer, b: Timer): number => Date.parse(a.dueAtSim) - Date.parse(b.dueAtSim) || (keyOfTimer(a) < keyOfTimer(b) ? -1 : keyOfTimer(a) > keyOfTimer(b) ? 1 : 0);

/** Every SCHEDULED timer of the world (orders, cases and installers without orders), by due instant. */
export async function scheduledTimers(clock: StoredClock, deps: { readonly data: Pick<Connector, "timers"> }, uptoSim?: string): Promise<Timer[]> {
  const [indexed, people] = await Promise.all([deps.data.timers.listDueTimers(clock.clockId, uptoSim), deps.data.timers.listDuePersonTimers(clock.ispId, uptoSim)]);
  return [...indexed, ...people.filter((timer) => timer.clockId === clock.clockId)].sort(byDue);
}

/**
 * Dispatches every SCHEDULED timer due at or before `untilSim`, oldest first, as `firedBy CLOCK` at its
 * own `dueAtSim` (the policy decides at that simulated instant). A schedule it had is deleted first; the
 * timer stays SCHEDULED until the worker claims it, which keeps the world busy meanwhile.
 */
export async function dispatchDue(clock: StoredClock, untilSim: Date, deps: ClockDeps): Promise<FiredRef[]> {
  const fired: FiredRef[] = [];
  for (const timer of await scheduledTimers(clock, deps, untilSim.toISOString())) {
    if (timer.scheduleName !== undefined) await deps.scheduler.delete(timer.scheduleName);
    if (await dispatchTimer(timer, { firedBy: "CLOCK", eventAtSim: timer.dueAtSim, worldEpoch: clock.worldEpoch }, deps)) {
      fired.push({ timerKey: keyOfTimer(timer), kind: timer.kind, dueAtSim: timer.dueAtSim });
    }
  }
  return fired;
}

/**
 * Every SCHEDULED timer after `afterSim` gets what its world needs now (schedule created, moved or
 * deleted; nothing in a PAUSED world). Timers at or before `afterSim` were just dispatched by the clock.
 */
export async function resyncWorld(clock: StoredClock, afterSim: Date | undefined, deps: ClockDeps): Promise<number> {
  let changed = 0;
  for (const timer of await scheduledTimers(clock, deps)) {
    if (afterSim !== undefined && Date.parse(timer.dueAtSim) <= afterSim.getTime()) continue;
    if ((await syncSchedule(timer, clock, deps)).outcome !== "NONE") changed += 1;
  }
  return changed;
}

export interface ClockAudit {
  readonly clock: StoredClock;
  readonly action: string;
  readonly actor: Actor;
  readonly atSim: string;
  readonly detail: JsonObject;
  readonly reason?: string;
  readonly refs?: DecisionInput["refs"];
}

/** `ACTION CLOCK_*` / `WORLD_*` of one world. */
export async function auditClock(deps: { readonly data: Pick<Connector, "audit"> }, entry: ClockAudit): Promise<void> {
  await deps.data.audit.append({
    ispId: entry.clock.ispId,
    clockId: entry.clock.clockId,
    atSim: entry.atSim,
    decision: "ACTION",
    action: entry.action,
    actor: entry.actor,
    detail: entry.detail,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    ...(entry.refs === undefined ? {} : { refs: entry.refs }),
  });
}
