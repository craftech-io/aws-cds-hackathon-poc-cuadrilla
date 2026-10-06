// The installer events `FeedEvents` and `ChannelEvents` put on `InstallerEvents.fifo`. Their shape is
// the consumer's (worker/events.ts, validated by the producer, worker/sink.ts, and again by the
// `InstallerWorker`); this module only says how these producers fill them:
//
//   DISPATCH_EVENT  the dispatcher's change, applied once by `apply_dispatch_event` (feeds/apply-dispatch.ts)
//   EMAIL_EVENT     an SES event about an email of an order, applied once by `apply_email_event`
//
// (`TIMER` events are timers/dispatch.ts's, with the world's epoch in their id.) Only ids travel: no
// address, no body, no content. `eventId` is the `MessageDeduplicationId` and the key of the worker's
// `IDEMP#<type>#<eventId>`; each one derives from what makes the event the same event, so a
// redelivery of the same source enqueues the same id.
import { createHash } from "node:crypto";
import type { DispatchEventType } from "@cuadrilla/dispatch-mock/events";
import type { InstallerEventSink } from "../worker/ports";
import type { DispatchEvent } from "../worker/events";

/** The producer these entries enqueue through (worker/sink.ts `createEventSink`). */
export type QueueSink = InstallerEventSink;

/** `DISPATCH_EVENT.change` of each event type of the dispatcher. */
export const DISPATCH_CHANGE: Readonly<Record<DispatchEventType, DispatchEvent["change"]>> = {
  WorkOrderRescheduled: "RESCHEDULED",
  WorkOrderReassigned: "REASSIGNED",
  WorkOrderCancelled: "CANCELLED",
};

/** The dispatcher's own id (`evt_<ULID>`) is already unique per change. */
export function dispatchQueueEventId(dispatchEventId: string): string {
  return `dsp-${dispatchEventId}`;
}

/** One SES event: the email, the event type and its instant. */
export function sesEventId(providerMessageId: string, eventType: string, atReal: string): string {
  return `ses-${createHash("sha256").update(`${providerMessageId}\n${eventType}\n${atReal}`, "utf8").digest("hex").slice(0, 40)}`;
}
