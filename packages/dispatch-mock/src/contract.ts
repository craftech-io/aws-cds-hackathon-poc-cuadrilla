// HTTP contract of the dispatch mock (`DispatchMock`, Function URL with AWS_IAM, invoked by `Bff` and
// `QaDriver`; docs/architecture-integrations.md §7). It simulates the external system that assigns
// work orders: it owns its `Dispatch` rows, answers the master data of an order and, on the three
// control routes, changes the order and publishes the matching event on the `Feeds` bus. Callers
// validate responses with these schemas; the mock validates requests with them.
import { z } from "zod";
import { CustomerId, InstallerId, IspId, ToolFailureSchema, WorkOrderId, WorkOrderNumber, WorkOrderStatus } from "@cuadrilla/shared";
import { AppointmentWindow, DispatchEventId, DispatchEventType, DispatchReason, ZonedInstant } from "./events";

export const DispatchRouteName = z.enum(["getWorkOrder", "reschedule", "reassign", "cancel", "health"]);
export type DispatchRouteName = z.infer<typeof DispatchRouteName>;

export interface DispatchRoute {
  readonly name: DispatchRouteName;
  readonly method: "GET" | "POST";
  readonly path: string;
}

/** The routes of §7, in the order the table lists them. */
export const DISPATCH_ROUTES: readonly DispatchRoute[] = [
  { name: "getWorkOrder", method: "GET", path: "/v1/work-orders/{number}" },
  { name: "reschedule", method: "POST", path: "/v1/work-orders/{number}/reschedule" },
  { name: "reassign", method: "POST", path: "/v1/work-orders/{number}/reassign" },
  { name: "cancel", method: "POST", path: "/v1/work-orders/{number}/cancel" },
  { name: "health", method: "GET", path: "/v1/health" },
];

/** The three control routes and the event each one publishes. */
export const DispatchAction = z.enum(["reschedule", "reassign", "cancel"]);
export type DispatchAction = z.infer<typeof DispatchAction>;

export const EVENT_TYPE_OF_ACTION: Readonly<Record<DispatchAction, DispatchEventType>> = {
  reschedule: "WorkOrderRescheduled",
  reassign: "WorkOrderReassigned",
  cancel: "WorkOrderCancelled",
};

/** Query parameter that names the operator of the order on `GET` (`?isp=<ispId>`). */
export const ISP_QUERY_PARAM = "isp";

/** Path of an order, or of one of its control routes, for a client. */
export function workOrderPath(workOrderNumber: string, action?: DispatchAction): string {
  const base = `/v1/work-orders/${WorkOrderNumber.parse(workOrderNumber)}`;
  return action === undefined ? base : `${base}/${DispatchAction.parse(action)}`;
}

/**
 * Key that makes a control call safe to repeat (the `QaDriver` sends `runId/scenario/step`, the BFF
 * one per console action). The same key on the same order never changes it twice: the mock publishes
 * the stored event again, with the same `eventId`, as an at-least-once bus would.
 */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/, "expected 1-200 characters of [A-Za-z0-9._:/#-]");
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

const CommandBase = {
  ispId: IspId,
  reason: DispatchReason,
  /** Simulated now of the order's world; the caller reads it from the world clock. */
  occurredAtSim: ZonedInstant,
  idempotencyKey: IdempotencyKey,
};

export const RescheduleRequest = z.object({ ...CommandBase, newWindow: AppointmentWindow }).strict();
export type RescheduleRequest = z.infer<typeof RescheduleRequest>;

export const ReassignRequest = z.object({ ...CommandBase, newInstallerId: InstallerId }).strict();
export type ReassignRequest = z.infer<typeof ReassignRequest>;

export const CancelRequest = z.object(CommandBase).strict();
export type CancelRequest = z.infer<typeof CancelRequest>;

/** Status of an order in the dispatcher: it knows nothing of the product's own states (`CLOSED`…). */
export const DispatchOrderStatus = WorkOrderStatus.extract(["SCHEDULED", "RESCHEDULED", "REASSIGNED", "CANCELLED"]);
export type DispatchOrderStatus = z.infer<typeof DispatchOrderStatus>;

export const DispatchEventSummary = z
  .object({ eventId: DispatchEventId, type: DispatchEventType, reason: DispatchReason, occurredAtSim: ZonedInstant })
  .strict();
export type DispatchEventSummary = z.infer<typeof DispatchEventSummary>;

/** Master data of an order in the dispatcher: the `META` row holds it and `GET` answers it. */
export const ORDER_MASTER_FIELDS = {
  ispId: IspId,
  workOrderNumber: WorkOrderNumber,
  workOrderId: WorkOrderId,
  installerId: InstallerId,
  customerId: CustomerId.optional(),
  plan: z.string().min(1).max(40).optional(),
  appointmentWindow: AppointmentWindow,
  status: DispatchOrderStatus,
};

/** `GET /v1/work-orders/{number}?isp=<ispId>`: the master data and the order's events, oldest first. */
export const DispatchOrderView = z
  .object({ ...ORDER_MASTER_FIELDS, version: z.number().int().min(1), events: z.array(DispatchEventSummary) })
  .strict();
export type DispatchOrderView = z.infer<typeof DispatchOrderView>;

/** Answer of a control route: the event it published and the order after it. */
export const DispatchCommandResult = z
  .object({
    ok: z.literal(true),
    eventId: DispatchEventId,
    type: DispatchEventType,
    /** True when the idempotency key had already been applied and the stored event was published again. */
    replayed: z.boolean(),
    order: DispatchOrderView,
  })
  .strict();
export type DispatchCommandResult = z.infer<typeof DispatchCommandResult>;

export const DispatchHealth = z.object({ ok: z.literal(true), service: z.literal("dispatch-mock") }).strict();
export type DispatchHealth = z.infer<typeof DispatchHealth>;

/** Every non-2xx answer: the same `{ ok: false, error: { code, message, reason? } }` envelope as the tools. */
export const DispatchErrorBody = ToolFailureSchema;
export type DispatchErrorBody = z.infer<typeof DispatchErrorBody>;

/** Detail codes of a `CONFLICT` answer. */
export const CONFLICT_REASON = {
  ORDER_CANCELLED: "ORDER_CANCELLED",
  UNCHANGED: "UNCHANGED",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  VERSION_CONFLICT: "VERSION_CONFLICT",
} as const;
export type ConflictReason = (typeof CONFLICT_REASON)[keyof typeof CONFLICT_REASON];
