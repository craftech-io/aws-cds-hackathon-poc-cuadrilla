// Timers (ADR-0004, docs/architecture.md §8): everything that has to happen at a simulated instant is a
// `TIMER#<kind>#<timerId>` in the partition of its order, case or installer, in the world's due index
// while it is `SCHEDULED`, with at most one EventBridge Scheduler schedule (timers/schedule.ts). This
// module implements `TimerPort` (agent-tools/common/ports.ts) for every producer (the ladder's
// CASE_TIMEOUT, the pipeline's DEFERRED_SEND, the certificate's CERT_RETRY, the day plan's DAY_START):
//
//   arm         creates the timer (an existing one is returned unchanged) and gives it what its world
//               needs now: a schedule, nothing, or an immediate dispatch when it is already due
//   reschedule  a new `dueAtSim` (version + 1) and the schedule moved with it
//   cancel      `CANCELLED`, its schedule deleted
//   locate      the timer a schedule or a clock move names, with its installer (the FIFO group)
//   fire        the consumer's claim, conditional on the version: a schedule that arrives before the
//               world reaches `dueAtSim` (a paused world, Scheduler precision) re-arms it (`NOT_DUE`),
//               a firing of another version or of a timer no longer SCHEDULED is `STALE`, and the
//               same firing delivered twice (a retried queue event) is `FIRED` again so its action,
//               idempotent by kind, can finish
//
// Every write is pinned to the version read. Naming a schedule bumps the version too, so the schedule
// is written after the name and carries the version that names it.
import { ConnectorError, type TimerFiredBy } from "@cuadrilla/shared";
import { ArmTimerRequest, type FireTimerOutcome, FireTimerRequest, type LocatedTimer, type TimerPort } from "../agent-tools/common/ports";
import { parseTimerRefKey } from "../connector/keys";
import type { Connector, TimerRef } from "../connector/ports";
import type { Clock as StoredClock } from "../domain/runtime";
import type { Timer } from "../domain/timers";
import { type Clock, simNowOf } from "../lib/clock";
import type { Logger } from "../lib/log";
import { type TimerDispatcher, dueTimerOf, installerOfHome, keyOfTimer } from "./dispatch";
import { schedulePlan, scheduleNameOf } from "./schedule";
import type { SchedulerPort } from "./scheduler-client";

export interface TimerDeps {
  readonly data: Pick<Connector, "timers" | "runtime" | "workOrders" | "cases">;
  readonly scheduler: SchedulerPort;
  readonly dispatcher: TimerDispatcher;
  /** Real time: the RUNNING mode and the schedules are measured against it. */
  readonly realClock: Clock;
  readonly log?: Logger;
}

const isConflict = (error: unknown): boolean => error instanceof ConnectorError && error.code === "CONFLICT";

export function refOf(timer: Pick<Timer, "home" | "kind" | "timerId">): TimerRef {
  return { home: timer.home, kind: timer.kind, timerId: timer.timerId };
}

/** The stored clock of a world; NOT_FOUND when the world does not exist. */
export async function readWorldClock(data: Pick<Connector, "runtime">, clockId: string): Promise<StoredClock> {
  const clock = await data.runtime.getClock(clockId);
  if (clock === undefined) throw new ConnectorError("NOT_FOUND", `clock "${clockId}" does not exist`, "Runtime");
  return clock;
}

/** Sends a timer to its installer's queue; `false` when its order or case is gone. */
export async function dispatchTimer(timer: Timer, firing: { readonly firedBy: TimerFiredBy; readonly eventAtSim: string; readonly worldEpoch: number }, deps: TimerDeps): Promise<boolean> {
  const due = await dueTimerOf(deps.data, timer, firing);
  if (due === undefined) {
    deps.log?.warn("timer.home_missing", { timerKey: keyOfTimer(timer), clockId: timer.clockId });
    return false;
  }
  await deps.dispatcher.dispatch(due);
  return true;
}

/** Deletes a timer's schedule and forgets its name (version + 1); a timer that moved on keeps its state. */
async function forgetSchedule(timer: Timer, deps: TimerDeps): Promise<Timer> {
  if (timer.scheduleName === undefined) return timer;
  await deps.scheduler.delete(timer.scheduleName);
  try {
    return await deps.data.timers.setScheduleName(refOf(timer), null, timer.version);
  } catch (error) {
    if (!isConflict(error)) throw error;
    return (await deps.data.timers.getTimer(refOf(timer))) ?? timer;
  }
}

export type SyncOutcome = "NONE" | "SCHEDULED" | "UNSCHEDULED" | "DISPATCHED";

/**
 * Puts the real schedule of a SCHEDULED timer where its world needs it now: created or moved inside
 * the horizon of a RUNNING world, deleted outside it or in a PAUSED one, or the timer dispatched when
 * it is already due. Answers the timer as stored afterwards.
 */
export async function syncSchedule(timer: Timer, clock: StoredClock, deps: TimerDeps): Promise<{ readonly outcome: SyncOutcome; readonly timer: Timer }> {
  if (timer.status !== "SCHEDULED") return { outcome: "NONE", timer };
  const plan = schedulePlan(timer.dueAtSim, clock, (await deps.realClock.now()).getTime());
  if (plan.kind === "NONE") {
    if (timer.scheduleName === undefined) return { outcome: "NONE", timer };
    return { outcome: "UNSCHEDULED", timer: await forgetSchedule(timer, deps) };
  }
  if (plan.kind === "DIRECT") {
    const current = await forgetSchedule(timer, deps);
    const sent = await dispatchTimer(current, { firedBy: plan.firedBy, eventAtSim: current.dueAtSim, worldEpoch: clock.worldEpoch }, deps);
    return { outcome: sent ? "DISPATCHED" : "NONE", timer: current };
  }
  const name = scheduleNameOf(timer.clockId, refOf(timer));
  const named = timer.scheduleName === name ? timer : await deps.data.timers.setScheduleName(refOf(timer), name, timer.version);
  await deps.scheduler.put({ name, at: plan.at, input: { clockId: named.clockId, timerKey: keyOfTimer(named), dueAtSim: named.dueAtSim, version: named.version } });
  return { outcome: "SCHEDULED", timer: named };
}

/** The same firing delivered again: the timer left SCHEDULED by exactly this request's version and source. */
function isReplay(timer: Timer, request: FireTimerRequest): boolean {
  return timer.status === "FIRED" && request.version !== undefined && timer.version === request.version + 1 && timer.firedBy === request.firedBy && timer.firedAtSim !== undefined;
}

function staleOrReplay(timer: Timer, request: FireTimerRequest): FireTimerOutcome {
  if (isReplay(timer, request)) return { status: "FIRED", timer, eventAtSim: timer.firedAtSim as string };
  if (timer.status !== "SCHEDULED") return { status: "STALE", timer, reason: "NOT_SCHEDULED" };
  return { status: "STALE", timer, reason: "VERSION" };
}

export interface TimerService extends TimerPort {
  /** `arm` with the outcome of the schedule (tests, the clock's resync). */
  armWithOutcome(request: ArmTimerRequest): Promise<{ readonly timer: Timer; readonly outcome: SyncOutcome | "EXISTING" }>;
}

/** The `TimerPort` of the stage (and of the tests, over memory and fakes). */
export function createTimerService(deps: TimerDeps): TimerService {
  const { timers } = deps.data;

  async function armWithOutcome(input: ArmTimerRequest) {
    const request = ArmTimerRequest.parse(input);
    const clock = await readWorldClock(deps.data, request.clockId);
    let created: Timer;
    try {
      created = await timers.createTimer({
        timerId: request.timerId,
        kind: request.kind,
        home: request.home,
        clockId: request.clockId,
        dueAtSim: request.dueAtSim,
        status: "SCHEDULED",
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        payload: request.payload ?? {},
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const existing = await timers.getTimer({ home: request.home, kind: request.kind, timerId: request.timerId });
      if (existing === undefined) throw error;
      return { timer: existing, outcome: "EXISTING" as const };
    }
    return syncSchedule(created, clock, deps);
  }

  async function requireTimer(ref: TimerRef): Promise<Timer> {
    const timer = await timers.getTimer(ref);
    if (timer === undefined) throw new ConnectorError("NOT_FOUND", `timer ${ref.kind}#${ref.timerId} not found`, "Timers");
    return timer;
  }

  return {
    armWithOutcome,

    async arm(request) {
      return (await armWithOutcome(request)).timer;
    },

    async reschedule(ref, dueAtSim, options = {}) {
      const current = await requireTimer(ref);
      const moved = await timers.rescheduleTimer(ref, dueAtSim, current.version, options);
      return (await syncSchedule(moved, await readWorldClock(deps.data, moved.clockId), deps)).timer;
    },

    async cancel(ref, reason) {
      const current = await timers.getTimer(ref);
      if (current === undefined || current.status !== "SCHEDULED") return current;
      if (current.scheduleName !== undefined) await deps.scheduler.delete(current.scheduleName);
      try {
        return await timers.setTimerStatus(ref, { status: "CANCELLED", reason }, current.version);
      } catch (error) {
        if (!isConflict(error)) throw error;
        return timers.getTimer(ref);
      }
    },

    async locate(timerKey): Promise<LocatedTimer | undefined> {
      const ref = parseTimerRefKey(timerKey);
      if (ref === undefined) return undefined;
      const timer = await timers.getTimer(ref);
      if (timer === undefined) return undefined;
      const installerId = await installerOfHome(deps.data, timer.home);
      return installerId === undefined ? undefined : { timer, installerId };
    },

    async fire(input) {
      const request = FireTimerRequest.parse(input);
      const ref = parseTimerRefKey(request.timerKey);
      if (ref === undefined) return { status: "MISSING" };
      const timer = await timers.getTimer(ref);
      if (timer === undefined) return { status: "MISSING" };
      if (timer.status !== "SCHEDULED" || (request.version !== undefined && request.version !== timer.version)) return staleOrReplay(timer, request);

      const clock = await readWorldClock(deps.data, timer.clockId);
      const simNow = simNowOf(clock, (await deps.realClock.now()).getTime());
      if (request.firedBy !== "MANUAL" && Date.parse(timer.dueAtSim) > simNow.getTime()) {
        deps.log?.info("timer.not_due", { timerKey: request.timerKey, firedBy: request.firedBy });
        return { status: "NOT_DUE", timer: (await syncSchedule(timer, clock, deps)).timer };
      }
      const eventAtSim = request.eventAtSim ?? (request.firedBy === "MANUAL" ? simNow.toISOString() : timer.dueAtSim);
      if (timer.scheduleName !== undefined && request.firedBy !== "SCHEDULER") await deps.scheduler.delete(timer.scheduleName);
      try {
        const fired = await timers.setTimerStatus(ref, { status: "FIRED", firedBy: request.firedBy, firedAtSim: eventAtSim }, timer.version);
        return { status: "FIRED", timer: fired, eventAtSim };
      } catch (error) {
        if (!isConflict(error)) throw error;
        const now = await timers.getTimer(ref);
        return now === undefined ? { status: "MISSING" } : staleOrReplay(now, { ...request, version: timer.version });
      }
    },
  };
}
