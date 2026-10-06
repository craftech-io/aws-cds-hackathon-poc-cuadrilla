// The two modes of a world's clock (ADR-0010, docs/architecture.md §8):
//
//   setRunning(true)    "Reloj en vivo": RUNNING for 30 real minutes from the instant the world had;
//                       the schedules of the one-hour horizon are created in the same call
//   setRunning(false)   back to PAUSED at the instant reached; every schedule is deleted
//   unfreeze            the `QaDriver`'s test of the real Scheduler, in one write: with the world paused,
//                       `pausedSimNow = max(simNow, dueAtSim − leadSec)` of the next timer (or of the
//                       timer `timerKey` names), 120 s by default, never back; then RUNNING and the
//                       schedules. With nothing pending it simply runs from where it is (a case opened
//                       afterwards gets its 60-second demo timeout and its schedule)
//   freeze              PAUSED again, no schedule left
import { ToolError } from "@cuadrilla/shared";
import { parseTimerRefKey } from "../connector/keys";
import { RUNNING_WINDOW_MS, pauseAt, startRunning } from "../lib/clock";
import { keyOfTimer } from "../timers/dispatch";
import { type ClockCaller, type ClockDeps, type ClockMoved, auditClock, currentClock, resyncWorld, scheduledTimers, viewOf, writeClock } from "./state";

export const UNFREEZE_DEFAULT_LEAD_SEC = 120;
/** Longest lead the `QaDriver` may ask for: one live window. */
export const UNFREEZE_MAX_LEAD_SEC = RUNNING_WINDOW_MS / 1000;

/** "Reloj en vivo" on or off. */
export async function setRunning(input: { readonly clockId: string; readonly running: boolean; readonly caller: Pick<ClockCaller, "actor"> }, deps: ClockDeps): Promise<ClockMoved> {
  const stored = await currentClock(input.clockId, deps);
  const realNow = await deps.realClock.now();
  const wasRunning = viewOf(stored, realNow).running;
  const changes = input.running || wasRunning;
  const clock = changes ? await writeClock(stored, input.running ? startRunning(stored, realNow.getTime()) : pauseAt(stored, realNow.getTime()), deps) : stored;
  await resyncWorld(clock, undefined, deps);
  const view = viewOf(clock, realNow);
  await auditClock(deps, {
    clock,
    action: input.running ? "CLOCK_RUNNING" : "CLOCK_PAUSED",
    actor: input.caller.actor,
    atSim: view.simNow.toISOString(),
    detail: { runningUntilReal: view.running ? (clock.runningUntilReal ?? null) : null, wasRunning },
  });
  return { clockId: clock.clockId, mode: view.running ? "RUNNING" : "PAUSED", simNow: view.simNow.toISOString(), worldEpoch: clock.worldEpoch, fired: [], forced: false };
}

export type UnfreezeInput = { readonly clockId: string; readonly leadSec?: number; readonly timerKey?: string };

export interface Unfrozen {
  readonly simNow: string;
  readonly runningUntilReal: string;
  /** The timer the lead was measured against, if any was pending. */
  readonly timerKey?: string;
  readonly dueAtSim?: string;
  readonly dueAtReal?: string;
}

/** `clock.unfreeze({leadSec | timerKey})` of the `QaDriver`. */
export async function unfreeze(input: UnfreezeInput, deps: ClockDeps): Promise<Unfrozen> {
  const leadSec = input.leadSec ?? UNFREEZE_DEFAULT_LEAD_SEC;
  if (!Number.isInteger(leadSec) || leadSec < 0 || leadSec > UNFREEZE_MAX_LEAD_SEC) throw new ToolError("INVALID", `leadSec is a whole number from 0 to ${UNFREEZE_MAX_LEAD_SEC}`, "CLOCK_INVALID_MOVE");
  const stored = await currentClock(input.clockId, deps);
  const realNow = await deps.realClock.now();
  const view = viewOf(stored, realNow);
  if (view.running) throw new ToolError("CONFLICT", "the world is already running", "CLOCK_RUNNING");

  let target;
  if (input.timerKey === undefined) {
    [target] = await scheduledTimers(stored, deps);
  } else {
    const ref = parseTimerRefKey(input.timerKey);
    target = ref === undefined ? undefined : await deps.data.timers.getTimer(ref);
    if (target === undefined || target.status !== "SCHEDULED" || target.clockId !== stored.clockId) throw new ToolError("INVALID", "this timer is not pending in this world", "TIMER_NOT_PENDING");
  }
  const atSim = target === undefined ? view.simNow.getTime() : Math.max(view.simNow.getTime(), Date.parse(target.dueAtSim) - leadSec * 1000);
  const now = realNow.getTime();
  const runningUntilReal = new Date(now + RUNNING_WINDOW_MS).toISOString();
  const clock = await writeClock(stored, { mode: "RUNNING", pausedSimNow: new Date(atSim).toISOString(), offsetMs: atSim - now, runningUntilReal }, deps);
  await resyncWorld(clock, undefined, deps);
  await auditClock(deps, { clock, action: "CLOCK_UNFROZEN", actor: "QA", atSim: new Date(atSim).toISOString(), detail: { leadSec, fromSim: view.simNow.toISOString(), runningUntilReal } });
  if (target === undefined) return { simNow: new Date(atSim).toISOString(), runningUntilReal };
  return {
    simNow: new Date(atSim).toISOString(),
    runningUntilReal,
    timerKey: keyOfTimer(target),
    dueAtSim: target.dueAtSim,
    dueAtReal: new Date(Date.parse(target.dueAtSim) - clock.offsetMs).toISOString(),
  };
}

/** `clock.freeze` of the `QaDriver`: paused at the instant reached, every schedule deleted. */
export async function freeze(input: { readonly clockId: string }, deps: ClockDeps): Promise<{ readonly simNow: string }> {
  return { simNow: (await setRunning({ clockId: input.clockId, running: false, caller: { actor: "QA" } }, deps)).simNow };
}
