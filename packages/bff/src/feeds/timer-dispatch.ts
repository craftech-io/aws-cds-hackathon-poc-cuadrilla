// What `ScheduleDispatch` does with a schedule that fired (docs/architecture.md §8, ADR-0004): every
// timer schedule of the stage's group targets it with `{clockId, timerKey, dueAtSim, version}`
// (agent-tools/common/ports.ts `ScheduleDispatchPayload`). It never fires the timer itself: it finds
// the timer and its installer and puts a `TIMER` on that installer's queue (timers/dispatch.ts: the
// same event, with the same id, that "Avanzar" produces for that timer, version and epoch), so a rung
// that expires never runs beside a turn of the same installer (ADR-0017). The worker fires it
// conditionally on the version and re-evaluates `dueAtSim` against the world clock (a world that paused
// in between re-arms it instead of firing).
//
// What is not ours to queue is dropped and logged, never retried: a timer (or a world, or the order or
// case it lives on) that no longer exists, one of another world, one no longer SCHEDULED, or one whose
// version moved on (a newer schedule exists). Only a failure to queue throws, so the Scheduler's
// retry policy delivers the schedule again. `ScheduleDispatch` holds no Scheduler permission: it reads.
import type { ScheduleDispatchPayload } from "../agent-tools/common/ports";
import { parseTimerRefKey } from "../connector/keys";
import type { Connector } from "../connector/ports";
import type { Timer } from "../domain/timers";
import type { Logger } from "../lib/log";
import { dueTimerOf, queueTimerDispatcher } from "../timers/dispatch";
import type { QueueSink } from "./queue-events";

export type ScheduleOutcome = "QUEUED" | "MISSING" | "OTHER_WORLD" | "NOT_SCHEDULED" | "STALE_VERSION";

export interface TimerDispatchDeps {
  readonly connector: Pick<Connector, "timers" | "workOrders" | "cases" | "runtime">;
  readonly queue: QueueSink;
  readonly logger: Logger;
}

function verdictOf(payload: ScheduleDispatchPayload, timer: Timer | undefined): Exclude<ScheduleOutcome, "QUEUED"> | undefined {
  if (timer === undefined) return "MISSING";
  if (timer.clockId !== payload.clockId) return "OTHER_WORLD";
  if (timer.status !== "SCHEDULED") return "NOT_SCHEDULED";
  if (timer.version !== payload.version) return "STALE_VERSION";
  return undefined;
}

async function timerOf(timerKey: string, connector: TimerDispatchDeps["connector"]): Promise<Timer | undefined> {
  const ref = parseTimerRefKey(timerKey);
  return ref === undefined ? undefined : connector.timers.getTimer(ref);
}

/** One fired schedule: `TIMER` on the installer's queue, or nothing (logged) when it is not ours to fire. */
export async function dispatchSchedule(payload: ScheduleDispatchPayload, deps: TimerDispatchDeps): Promise<ScheduleOutcome> {
  const { connector } = deps;
  const timer = await timerOf(payload.timerKey, connector);
  const ignore = (verdict: Exclude<ScheduleOutcome, "QUEUED">): ScheduleOutcome => {
    deps.logger.info("schedule.ignored", { verdict, timerKey: payload.timerKey, clockId: payload.clockId, version: payload.version, currentVersion: timer?.version });
    return verdict;
  };
  const verdict = verdictOf(payload, timer);
  if (verdict !== undefined || timer === undefined) return ignore(verdict ?? "MISSING");
  const clock = await connector.runtime.getClock(payload.clockId);
  if (clock === undefined) return ignore("MISSING");
  const due = await dueTimerOf(connector, timer, { worldEpoch: clock.worldEpoch, firedBy: "SCHEDULER", eventAtSim: timer.dueAtSim });
  if (due === undefined) return ignore("MISSING");
  await queueTimerDispatcher(deps.queue).dispatch(due);
  return "QUEUED";
}
