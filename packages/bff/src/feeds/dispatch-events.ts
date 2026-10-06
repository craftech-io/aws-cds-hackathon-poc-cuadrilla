// What `FeedEvents` does with an event of the `Feeds` bus (docs/architecture-integrations.md §7; FL-014,
// FL-015): the dispatch mock publishes `WorkOrderRescheduled`, `WorkOrderReassigned` and
// `WorkOrderCancelled` (`@cuadrilla/dispatch-mock/events`, the single source of their shape).
//
//   1. zod over the whole EventBridge event; anything else is dropped and logged, never retried
//   2. the order, by operator and number: numbers repeat across guest worlds, so the id is the one
//      of the operator's world (`wo-<number>` or `wo-<number>-<clockTag>`, docs/seed-spec.md §2) and
//      the stored order must say the same operator and number
//   3. deduplication by the dispatcher's `eventId` (`IDEMP#dispatch-event#<eventId>`); a failure to
//      queue gives the claim back, so EventBridge's redelivery queues it then
//   4. `DISPATCH_EVENT` on the group of the order's current installer: the change is applied once, by
//      the worker (feeds/apply-dispatch.ts), never beside a turn of that installer (ADR-0017)
import { DispatchBusEvent, DispatchEvent } from "@cuadrilla/dispatch-mock/events";
import { clockIdOfIsp, clockTagOf, workOrderId } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import type { WorkOrder } from "../domain/work-orders";
import type { Logger } from "../lib/log";
import { DISPATCH_CHANGE, type QueueSink, dispatchQueueEventId } from "./queue-events";

export type DispatchAcceptOutcome = "QUEUED" | "DUPLICATE" | "UNKNOWN_ORDER" | "INVALID";

export interface DispatchFeedDeps {
  readonly connector: Pick<Connector, "workOrders" | "runtime">;
  readonly queue: QueueSink;
  readonly logger: Logger;
}

/** Idempotency source of the dispatcher's events. */
export const DISPATCH_IDEMPOTENCY = "dispatch-event";

/** The order a dispatcher's event names, in the operator's own world; `undefined` when there is none. */
export async function resolveDispatchOrder(ispId: string, workOrderNumber: string, workOrders: Pick<Connector["workOrders"], "getWorkOrder">): Promise<WorkOrder | undefined> {
  let id: string;
  try {
    id = workOrderId(workOrderNumber, clockTagOf(clockIdOfIsp(ispId)));
  } catch {
    return undefined;
  }
  const order = await workOrders.getWorkOrder(id);
  return order !== undefined && order.ispId === ispId && order.workOrderNumber === workOrderNumber ? order : undefined;
}

/** The validated event; `undefined` (with the number of issues logged, never the content) otherwise. */
function parseFeedEvent(raw: unknown, logger: Logger): DispatchEvent | undefined {
  const envelope = DispatchBusEvent.safeParse(raw);
  const event = envelope.success ? DispatchEvent.safeParse({ type: envelope.data["detail-type"], detail: envelope.data.detail }) : undefined;
  if (event?.success !== true) {
    logger.warn("feed_events.invalid_event", { issues: envelope.success ? (event?.error?.issues.length ?? 0) : envelope.error.issues.length });
    return undefined;
  }
  return event.data;
}

/** One event of the `Feeds` bus. Throws only when a dependency failed (EventBridge retries). */
export async function acceptDispatchEvent(raw: unknown, deps: DispatchFeedDeps): Promise<DispatchAcceptOutcome> {
  const event = parseFeedEvent(raw, deps.logger);
  if (event === undefined) return "INVALID";
  const { detail } = event;
  const fields = { type: event.type, eventId: detail.eventId, ispId: detail.ispId, workOrderNumber: detail.workOrderNumber };
  const order = await resolveDispatchOrder(detail.ispId, detail.workOrderNumber, deps.connector.workOrders);
  if (order === undefined) {
    deps.logger.warn("feed_events.unknown_order", fields);
    return "UNKNOWN_ORDER";
  }
  if (!(await deps.connector.runtime.claimIdempotency(DISPATCH_IDEMPOTENCY, detail.eventId))) {
    deps.logger.info("feed_events.duplicate", fields);
    return "DUPLICATE";
  }
  try {
    await deps.queue.enqueue({
      type: "DISPATCH_EVENT",
      eventId: dispatchQueueEventId(detail.eventId),
      clockId: order.clockId,
      ispId: order.ispId,
      installerId: order.installerId,
      workOrderId: order.workOrderId,
      change: DISPATCH_CHANGE[event.type],
      occurredAtSim: detail.occurredAtSim,
      detail,
    });
  } catch (error) {
    await deps.connector.runtime.releaseIdempotency(DISPATCH_IDEMPOTENCY, detail.eventId).catch((releaseError: unknown) => deps.logger.warn("feed_events.claim_not_released", { ...fields, error: releaseError }));
    throw error;
  }
  deps.logger.info("feed_events.queued", { ...fields, workOrderId: order.workOrderId });
  return "QUEUED";
}
