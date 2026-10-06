// Lambda entry of `ScheduleDispatch` (docs/architecture.md §8, infra/scheduler.ts): the target of every
// timer schedule of the stage's group, with input `{clockId, timerKey, dueAtSim, version}`. The input
// is validated with zod (agent-tools/common/ports.ts `ScheduleDispatchPayload`, the same schema the
// timer port writes); feeds/timer-dispatch.ts finds the timer and its installer and puts a `TIMER` on
// that installer's queue (worker/sink.ts: validated, `inFlight` first, then `SendMessage`). A
// malformed input or a timer that is not ours to fire is dropped and logged without its content; a
// failure to queue throws, so the Scheduler's retry policy delivers the schedule again. It links its
// tables and `InstallerEvents` only: no Scheduler permission.
import { ScheduleDispatchPayload } from "../agent-tools/common/ports";
import { connector } from "../connector/index";
import { stageQueueSink } from "../feeds/stage";
import { type ScheduleOutcome, type TimerDispatchDeps, dispatchSchedule } from "../feeds/timer-dispatch";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";

export interface ScheduleDispatchResult {
  readonly status: ScheduleOutcome | "INVALID";
}

export type ScheduleDispatchHandler = (event: unknown) => Promise<ScheduleDispatchResult>;

const newLogger = (): Logger => createLogger({ correlationId: newCorrelationId(), bindings: { component: "schedule-dispatch" } });

export function createScheduleDispatchHandler(depsFor: (log: Logger) => TimerDispatchDeps, newLog: () => Logger = newLogger): ScheduleDispatchHandler {
  return async (event) => {
    const log = newLog();
    const payload = ScheduleDispatchPayload.safeParse(event);
    if (!payload.success) {
      log.warn("schedule.invalid_input", { issues: payload.error.issues.length });
      return { status: "INVALID" };
    }
    const status = await dispatchSchedule(payload.data, depsFor(log));
    log.info("schedule.dispatched", { status, timerKey: payload.data.timerKey, clockId: payload.data.clockId, version: payload.data.version });
    return { status };
  };
}

function stageDeps(log: Logger): TimerDispatchDeps {
  const data = connector();
  return { connector: data, queue: stageQueueSink(data), logger: log };
}

export const handler: ScheduleDispatchHandler = createScheduleDispatchHandler(stageDeps);
