// Rows of the `Dispatch` table, owned by the mock (docs/architecture.md §5): the order
// (`DWO#<ispId>#<workOrderNumber>` / `META`) and its events (`EVT#<ts>`). The seed and the world
// factory write the `META` rows of every world (and delete them with the world); the mock only
// updates them and appends events. Both sides validate with these schemas.
import { z } from "zod";
import { ClockId, IspId, WorkOrderNumber, clockIdOfIsp, workOrderNumberOf } from "@cuadrilla/shared";
import { IdempotencyKey, ORDER_MASTER_FIELDS, type DispatchOrderView } from "./contract";
import {
  DispatchEvent,
  DispatchEventId,
  WorkOrderCancelledDetail,
  WorkOrderReassignedDetail,
  WorkOrderRescheduledDetail,
  ZonedInstant,
} from "./events";

export const DISPATCH_META_SK = "META";
export const DISPATCH_EVENT_SK_PREFIX = "EVT#";

/** Partition of an order: `DWO#isp-demo#24817`. Work order numbers repeat across judge worlds, operators do not. */
export function dispatchOrderPk(ispId: string, workOrderNumber: string): string {
  return `DWO#${IspId.parse(ispId)}#${WorkOrderNumber.parse(workOrderNumber)}`;
}

/** `EVT#<occurredAtSim in UTC>#<eventId>`: events sort by simulated time and never collide. */
export function dispatchEventSk(occurredAtSim: string, eventId: string): string {
  return `${DISPATCH_EVENT_SK_PREFIX}${new Date(ZonedInstant.parse(occurredAtSim)).toISOString()}#${DispatchEventId.parse(eventId)}`;
}

// zod runs an object's refinements even when a field failed; a derived key that cannot be computed
// then adds nothing (the field already carries its issue).
function derived(compute: () => string): string | undefined {
  try {
    return compute();
  } catch {
    return undefined;
  }
}

function mismatch(actual: unknown, compute: () => string): boolean {
  const expected = derived(compute);
  return expected !== undefined && actual !== expected;
}

// Attributes every item carries (docs/architecture.md §5). `createdAt`/`updatedAt` are real time;
// `expiresAt` is the TTL in epoch seconds (QA, evaluation and judge worlds).
const ItemBase = {
  PK: z.string().startsWith("DWO#"),
  createdAt: ZonedInstant,
  updatedAt: ZonedInstant,
  version: z.number().int().min(1),
  clockId: ClockId,
  synthetic: z.literal(true).optional(),
  world: z.string().min(1).max(16).optional(),
  runId: z.string().min(1).max(128).optional(),
  expiresAt: z.number().int().positive().optional(),
};

export const DispatchOrderItem = z
  .object({
    ...ItemBase,
    SK: z.literal(DISPATCH_META_SK),
    entity: z.literal("DispatchOrder"),
    ...ORDER_MASTER_FIELDS,
    lastEventId: DispatchEventId.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (mismatch(item.PK, () => dispatchOrderPk(item.ispId, item.workOrderNumber))) issue("PK", "PK is not DWO#<ispId>#<workOrderNumber>");
    if (mismatch(item.clockId, () => clockIdOfIsp(item.ispId))) issue("clockId", "clockId is not the clock of the operator");
    if (mismatch(item.workOrderNumber, () => workOrderNumberOf(item.workOrderId))) issue("workOrderId", "workOrderId does not carry the work order number");
  });
export type DispatchOrderItem = z.infer<typeof DispatchOrderItem>;

const EventItemBase = {
  ...ItemBase,
  SK: z.string().startsWith(DISPATCH_EVENT_SK_PREFIX),
  entity: z.literal("DispatchEvent"),
  /** The key of the control call that produced the event (a repeat publishes this event again). */
  idempotencyKey: IdempotencyKey,
};

export const DispatchEventItem = z
  .discriminatedUnion("type", [
    z.object({ ...EventItemBase, type: z.literal("WorkOrderRescheduled"), detail: WorkOrderRescheduledDetail }).strict(),
    z.object({ ...EventItemBase, type: z.literal("WorkOrderReassigned"), detail: WorkOrderReassignedDetail }).strict(),
    z.object({ ...EventItemBase, type: z.literal("WorkOrderCancelled"), detail: WorkOrderCancelledDetail }).strict(),
  ])
  .superRefine((item, ctx) => {
    if (mismatch(item.PK, () => dispatchOrderPk(item.detail.ispId, item.detail.workOrderNumber))) {
      ctx.addIssue({ code: "custom", path: ["PK"], message: "the event belongs to another order" });
    }
    if (mismatch(item.SK, () => dispatchEventSk(item.detail.occurredAtSim, item.detail.eventId))) {
      ctx.addIssue({ code: "custom", path: ["SK"], message: "SK is not EVT#<occurredAtSim>#<eventId>" });
    }
  });
export type DispatchEventItem = z.infer<typeof DispatchEventItem>;

/** The bus event a stored event item stands for. */
export function eventOfItem(item: DispatchEventItem): DispatchEvent {
  return DispatchEvent.parse({ type: item.type, detail: item.detail });
}

/** What `GET` answers: the master data of the order and its events, oldest first. */
export function orderView(order: DispatchOrderItem, events: readonly DispatchEventItem[]): DispatchOrderView {
  return {
    ispId: order.ispId,
    workOrderNumber: order.workOrderNumber,
    workOrderId: order.workOrderId,
    installerId: order.installerId,
    ...(order.customerId === undefined ? {} : { customerId: order.customerId }),
    ...(order.plan === undefined ? {} : { plan: order.plan }),
    appointmentWindow: order.appointmentWindow,
    status: order.status,
    version: order.version,
    events: [...events]
      .sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0))
      .map((event) => ({ eventId: event.detail.eventId, type: event.type, reason: event.detail.reason, occurredAtSim: event.detail.occurredAtSim })),
  };
}
