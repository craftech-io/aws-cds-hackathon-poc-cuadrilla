// Test kit of the timers and the demo clock (never imported by a Lambda): a memory connector on a
// movable real clock, the demo world's clock (`GLOBAL#isp-demo`, paused at 13/10 07:00), a Scheduler
// that records what it is asked for, and a dispatcher that records the timers sent to the queue.
import type { NewEntity } from "../domain/common";
import type { Clock as StoredClock } from "../domain/runtime";
import type { Timer, TimerHome } from "../domain/timers";
import { CLOCK, ISP, T0, installer, openCase, testConnector, workOrder } from "../connector/testing";
import type { Clock } from "../lib/clock";
import type { ClockDeps } from "../clock/state";
import type { DueTimer, TimerDispatcher } from "./dispatch";
import type { ScheduleSpec, SchedulerPort } from "./scheduler-client";
import { type TimerService, createTimerService } from "./timers";

/** The world's start: 13/10 07:00 America/Mexico_City (UTC−6). */
export const START_SIM = "2026-10-13T07:00:00-06:00";
export { CLOCK, ISP, T0 };

export class RecordingScheduler implements SchedulerPort {
  readonly live = new Map<string, ScheduleSpec>();
  readonly puts: ScheduleSpec[] = [];
  readonly deletes: string[] = [];

  async put(spec: ScheduleSpec): Promise<void> {
    this.puts.push(spec);
    this.live.set(spec.name, spec);
  }

  async delete(name: string): Promise<void> {
    this.deletes.push(name);
    this.live.delete(name);
  }
}

export class RecordingDispatcher implements TimerDispatcher {
  readonly sent: DueTimer[] = [];

  async dispatch(due: DueTimer): Promise<void> {
    this.sent.push(due);
  }

  /** `<kind>@<eventAtSim UTC>/<firedBy>` of every dispatch, in order. */
  summary(): string[] {
    return this.sent.map((due) => `${due.timer.kind}@${new Date(due.eventAtSim).toISOString()}/${due.firedBy}`);
  }
}

export interface TimeWorld extends ReturnType<typeof testConnector> {
  readonly scheduler: RecordingScheduler;
  readonly dispatcher: RecordingDispatcher;
  readonly realClock: Clock;
  readonly service: TimerService;
  deps(): ClockDeps;
  clock(clockId?: string): Promise<StoredClock>;
  /** Puts the world clock in RUNNING from `simNow` at the current real instant, for `windowMs`. */
  run(simNow: string, windowMs?: number): Promise<StoredClock>;
  /** A SCHEDULED timer written directly (no schedule, no dispatch). */
  timer(fields: Partial<NewEntity<typeof Timer>> & { readonly kind: Timer["kind"]; readonly timerId: string; readonly home: TimerHome; readonly dueAtSim: string }): Promise<Timer>;
}

/** The demo world with Rogelio, orders 24817 and 24818 and a case on 24818, paused at its start. */
export async function timeWorld(options: { readonly realStart?: string; readonly simStart?: string } = {}): Promise<TimeWorld> {
  const base = testConnector(options.realStart ?? T0);
  const scheduler = new RecordingScheduler();
  const dispatcher = new RecordingDispatcher();
  const realClock: Clock = { now: async () => base.now() };
  const deps = (): ClockDeps => ({ data: base.connector, scheduler, dispatcher, realClock });
  await base.connector.people.createPerson(installer());
  await base.connector.workOrders.createWorkOrder(workOrder());
  await base.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24818", workOrderNumber: "24818", onuSerial: "DEMO3F2C19A1" }));
  await base.connector.cases.createCase(openCase());
  await base.connector.runtime.createClock({ clockId: CLOCK, ispId: ISP, kind: "DEMO", mode: "PAUSED", offsetMs: 0, pausedSimNow: options.simStart ?? START_SIM, worldEpoch: 1 });
  const clock = async (clockId: string = CLOCK) => {
    const stored = await base.connector.runtime.getClock(clockId);
    if (stored === undefined) throw new Error(`no clock ${clockId}`);
    return stored;
  };
  return {
    ...base,
    scheduler,
    dispatcher,
    realClock,
    service: createTimerService(deps()),
    deps,
    clock,
    async run(simNow, windowMs = 30 * 60_000) {
      const current = await clock();
      const now = base.now().getTime();
      return base.connector.runtime.updateClock(CLOCK, { mode: "RUNNING", pausedSimNow: simNow, offsetMs: Date.parse(simNow) - now, runningUntilReal: new Date(now + windowMs).toISOString() }, current.version);
    },
    timer: (fields) => base.connector.timers.createTimer({ clockId: CLOCK, status: "SCHEDULED", ...fields }),
  };
}

export const ORDER_HOME: TimerHome = { kind: "WORK_ORDER", id: "wo-24817" };
export const CASE_HOME: TimerHome = { kind: "CASE", id: "case-01J9ZQX0000000000000000000" };
export const PERSON_HOME: TimerHome = { kind: "PERSON", id: "inst-rogelio" };
