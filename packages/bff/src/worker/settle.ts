// Quiescence (docs/architecture.md §7, FL-085, FL-099): `Runtime/INSTSTATE#<installerId>.inFlight` and
// `Runtime/WORLDSTATE#<clockId>.inFlight` hold the ids of the events of the installer and of the world;
// every producer adds before `SendMessage` (worker/sink.ts) and the worker takes the event out when it
// is done, when it was already done, and when it is refused for good.
//
//   an attempt that fails and will be retried     the event stays in flight (the world is busy with it)
//   the last attempt (`receiveCount ≥ 5`)          out of both sets, `INSTSTATE#.processError`, audited
//                                                 `EVENT_DEAD_LETTERED`, then rethrown to the DLQ: an event
//                                                 in the DLQ never leaves a world busy forever
//   a throttled turn sent back to the queue        out of both sets in that attempt (docs/architecture.md §7)
//
// A world is quiet when nothing is in flight, no `TIMER#` that fell due is still `SCHEDULED` and no email
// waits for its first SES event (those older than 10 real minutes are `STALE` and no longer count): what
// the clock asks before it moves (`WORLD_BUSY`) and what `installer.settle` waits for.
import type { Connector } from "../connector/ports";
import type { Logger } from "../lib/log";
import { WORKER_ACTIONS, auditOnce, workerAudit } from "./audit";

export const DEAD_LETTER_METRIC = "EventDeadLettered";

export interface EventIdentity {
  readonly eventId: string;
  readonly clockId: string;
  readonly ispId?: string;
  readonly installerId: string;
}

/** The event is done (or refused for good): out of the installer's and the world's `inFlight`. */
export async function settleEvent(data: Pick<Connector, "worlds">, event: EventIdentity): Promise<void> {
  await data.worlds.clearInFlight(event.installerId, event.clockId, event.eventId);
}

/**
 * Last attempt of an event that failed: out of `inFlight`, `processError` and `EVENT_DEAD_LETTERED`, then the
 * caller rethrows. Best effort: a failure here is logged and never hides the event's own error.
 */
export async function deadLetter(
  data: Pick<Connector, "worlds" | "audit" | "runtime">,
  event: EventIdentity | undefined,
  failure: { readonly type: string; readonly message: string; readonly atReal: string },
  log: Logger,
): Promise<void> {
  log.error("metric", { metric: DEAD_LETTER_METRIC, value: 1, type: failure.type });
  if (event === undefined) return;
  try {
    await settleEvent(data, event);
    await data.worlds.setProcessError(event.installerId, event.clockId, { eventId: event.eventId, message: failure.message.slice(0, 500), atReal: failure.atReal });
    if (event.ispId !== undefined) {
      await auditOnce(workerAudit(data), { action: WORKER_ACTIONS.deadLettered, eventId: event.eventId, ispId: event.ispId, clockId: event.clockId, detail: { type: failure.type, installerId: event.installerId } });
    }
  } catch (error) {
    log.error("event.dead_letter_record_failed", { cause: error instanceof Error ? error.name : "unknown" });
  }
}

export type PendingKind = "EVENT" | "MAIL";

export interface PendingItem {
  readonly kind: PendingKind;
  /** An event id, `timer:<kind>` for a timer that fell due, or the mail id. */
  readonly detail: string;
  readonly sinceReal?: string;
}

export interface WorldQuiescence {
  readonly quiet: boolean;
  readonly pending: readonly PendingItem[];
}

/** What keeps a world busy at the world's simulated `simNow` (`WORLD_BUSY` lists it). */
export async function worldQuiescence(data: Pick<Connector, "worlds" | "timers">, clockId: string, simNow: string): Promise<WorldQuiescence> {
  const [state, timers, mail] = await Promise.all([data.worlds.getWorldState(clockId), data.timers.listDueTimers(clockId, simNow), data.worlds.listPendingMail(clockId)]);
  const pending: PendingItem[] = [
    ...(state?.inFlight ?? []).map((eventId): PendingItem => ({ kind: "EVENT", detail: eventId })),
    ...timers.filter((timer) => timer.status === "SCHEDULED").map((timer): PendingItem => ({ kind: "EVENT", detail: `timer:${timer.kind}` })),
    ...mail.open.map((item): PendingItem => ({ kind: "MAIL", detail: item.mailId, sinceReal: item.sentAtReal })),
  ];
  return { quiet: pending.length === 0, pending };
}
