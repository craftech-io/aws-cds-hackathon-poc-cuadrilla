// How a due timer leaves its world (ADR-0004, ADR-0017, docs/architecture.md §7-§8): as a `TIMER` event
// of `InstallerEvents.fifo` in the group of the installer it belongs to, so a timeout, a button and a
// message about the same order never run in parallel. The queue producer is the worker's sink
// (`inFlight` first, then `SendMessage`, `MessageDeduplicationId = eventId`); this module only names
// what it carries:
//
//   - `DueTimer`: the timer, its installer, how it fired and the simulated instant of what it triggers
//     (`dueAtSim` when the clock or a schedule reaches it, the world's now when it is forced);
//   - its event id, `tm-<40 hex>` of `<clockId>#e<epoch>#<timerKey>#<dueAtSim UTC>#v<version>`: the
//     schedule, "Avanzar" and a forced firing of one timer at one version are one event, a rescheduled
//     timer is always another, and a reset world never collides with its previous epoch (same keys,
//     same due instants, version 1 again: without the epoch the FIFO's deduplication and the worker's
//     `IDEMP#` would drop the new world's timers);
//   - the `TIMER` event itself (worker/events.ts), whose `firedBy` tells the worker's claim
//     (`TimerPort.fire`) how it fired; a forced firing's `eventAtSim` is the `firedAtSim` the clock
//     wrote when it marked the timer `FIRED (MANUAL)`.
import { type TimerFiredBy, ispIdOfClock } from "@cuadrilla/shared";
import { timerRefKey } from "../connector/keys";
import type { Connector } from "../connector/ports";
import type { Timer, TimerHome } from "../domain/timers";
import { sha256Hex } from "../lib/crypto";
import type { TimerEvent } from "../worker/events";

export interface DueTimer {
  readonly timer: Timer;
  /** `MessageGroupId` of the event (ADR-0017). */
  readonly installerId: string;
  readonly ispId: string;
  readonly worldEpoch: number;
  readonly firedBy: TimerFiredBy;
  /** Simulated instant of what the timer triggers. */
  readonly eventAtSim: string;
  /** Deduplication id of the `TIMER` event (`timerEventId`). */
  readonly eventId: string;
}

/** Where due timers go: the worker's queue sink in a Lambda, a recorder in tests. */
export interface TimerDispatcher {
  dispatch(due: DueTimer): Promise<void>;
}

/** The `<HOME>|<homeId>|<kind>|<timerId>` key of a timer (what a schedule and an event carry). */
export function keyOfTimer(timer: Pick<Timer, "home" | "kind" | "timerId">): string {
  return timerRefKey({ home: timer.home, kind: timer.kind, timerId: timer.timerId });
}

/** What makes two firings of a timer the same `TIMER` event (a schedule's payload carries all but the epoch). */
export interface TimerEventKey {
  readonly clockId: string;
  readonly worldEpoch: number;
  readonly timerKey: string;
  readonly dueAtSim: string;
  readonly version: number;
}

/** Id of the `TIMER` event of a timer at one version and due instant, in one epoch of its world. */
export function timerEventIdOf(key: TimerEventKey): string {
  const due = new Date(Date.parse(key.dueAtSim)).toISOString();
  return `tm-${sha256Hex(`${key.clockId}#e${key.worldEpoch}#${key.timerKey}#${due}#v${key.version}`).slice(0, 40)}`;
}

export function timerEventId(timer: Pick<Timer, "home" | "kind" | "timerId" | "clockId" | "dueAtSim" | "version">, worldEpoch: number): string {
  return timerEventIdOf({ clockId: timer.clockId, worldEpoch, timerKey: keyOfTimer(timer), dueAtSim: timer.dueAtSim, version: timer.version });
}

/** The `TIMER` event of `InstallerEvents.fifo` (worker/events.ts) a due timer travels as. */
export function timerQueueEventOf(due: DueTimer): TimerEvent {
  return {
    type: "TIMER",
    eventId: due.eventId,
    clockId: due.timer.clockId,
    ispId: due.ispId,
    installerId: due.installerId,
    timerKey: keyOfTimer(due.timer),
    dueAtSim: due.timer.dueAtSim,
    version: due.timer.version,
    firedBy: due.firedBy,
  };
}

/** The dispatcher over the installer queue's producer (feeds/installer-queue.ts, worker/sink.ts). */
export function queueTimerDispatcher(queue: { enqueue(event: TimerEvent): Promise<void> }): TimerDispatcher {
  return { dispatch: (due) => queue.enqueue(timerQueueEventOf(due)) };
}

/** The installer whose FIFO group processes a timer's events; `undefined` when its home is gone. */
export async function installerOfHome(data: Pick<Connector, "workOrders" | "cases">, home: TimerHome): Promise<string | undefined> {
  switch (home.kind) {
    case "WORK_ORDER":
      return (await data.workOrders.getWorkOrder(home.id))?.installerId;
    case "CASE":
      return (await data.cases.getCase(home.id))?.installerId;
    case "PERSON":
      return home.id;
  }
}

/** The `DueTimer` of a timer, or `undefined` when its order or case no longer exists (a reset world). */
export async function dueTimerOf(
  data: Pick<Connector, "workOrders" | "cases">,
  timer: Timer,
  firing: { readonly worldEpoch: number; readonly firedBy: TimerFiredBy; readonly eventAtSim: string },
): Promise<DueTimer | undefined> {
  const installerId = await installerOfHome(data, timer.home);
  if (installerId === undefined) return undefined;
  return {
    timer,
    installerId,
    ispId: ispIdOfClock(timer.clockId),
    worldEpoch: firing.worldEpoch,
    firedBy: firing.firedBy,
    eventAtSim: firing.eventAtSim,
    eventId: timerEventId(timer, firing.worldEpoch),
  };
}
