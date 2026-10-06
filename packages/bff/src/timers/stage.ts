// The timers of a Lambda of the stage (anything holding the capability TIMERS: the worker,
// `ScheduleDispatch`, the BFF's clock procedures, the tool targets that arm timers): the process-wide
// connector, the one Scheduler client (`Resource.Scheduler`) and real time. The dispatcher is the
// caller's queue sink (the worker's producer of `InstallerEvents.fifo`), so this module never imports
// SQS. Every client is created on first use: a paused world needs no schedule at all.
import { connector } from "../connector/index";
import { systemClock } from "../lib/clock";
import type { Logger } from "../lib/log";
import type { TimerDispatcher } from "./dispatch";
import { eventBridgeScheduler } from "./scheduler-client";
import { type TimerDeps, type TimerService, createTimerService } from "./timers";

/** Ports of the timers in a Lambda that links `Scheduler` and the demo's tables. */
export function stageTimerDeps(dispatcher: TimerDispatcher, log?: Logger): TimerDeps {
  return { data: connector(), scheduler: eventBridgeScheduler(), dispatcher, realClock: systemClock, ...(log === undefined ? {} : { log }) };
}

export function stageTimerService(dispatcher: TimerDispatcher, log?: Logger): TimerService {
  return createTimerService(stageTimerDeps(dispatcher, log));
}
