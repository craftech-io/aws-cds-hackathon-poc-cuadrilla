// Events the dispatch mock publishes on the `Feeds` bus (docs/architecture-integrations.md §7): the
// single source of their shape for the producer (this package) and for the consumer (`FeedEvents`,
// which validates with `DispatchBusEvent`, resolves the order by operator and number, deduplicates by
// `eventId` and enqueues `DISPATCH_EVENT`). This module only depends on zod and @cuadrilla/shared, so a
// consumer can import `@cuadrilla/dispatch-mock/events` without the mock's AWS clients.
import { z } from "zod";
import { InstallerId, IspId, ULID_BODY, WorkOrderNumber } from "@cuadrilla/shared";

/** `Source` of every entry the mock puts on the bus; the rule to `FeedEvents` matches on it. */
export const DISPATCH_EVENT_SOURCE = "mock.dispatch";

/** `DetailType` of each event, one per control route of the mock. */
export const DispatchEventType = z.enum(["WorkOrderRescheduled", "WorkOrderReassigned", "WorkOrderCancelled"]);
export type DispatchEventType = z.infer<typeof DispatchEventType>;

/** `evt_` and a ULID (`evt_01K…`): unique per event, the deduplication key of `FeedEvents`. */
export const DispatchEventId = z.string().regex(new RegExp(`^evt_${ULID_BODY}$`), "expected evt_<ULID>");
export type DispatchEventId = z.infer<typeof DispatchEventId>;

/** ISO 8601 instant with its zone ("2026-10-13T10:40:00-06:00"); business dates are simulated. */
export const ZonedInstant = z.iso.datetime({ offset: true });
export type ZonedInstant = z.infer<typeof ZonedInstant>;

/** Longest appointment window the dispatcher hands out. */
export const MAX_WINDOW_HOURS = 12;

/** Appointment window agreed with the customer: `start` strictly before `end`, at most 12 h. */
export const AppointmentWindow = z
  .object({ start: ZonedInstant, end: ZonedInstant })
  .strict()
  .refine((window) => Date.parse(window.end) > Date.parse(window.start), { message: "end must be after start", path: ["end"] })
  .refine((window) => Date.parse(window.end) - Date.parse(window.start) <= MAX_WINDOW_HOURS * 3_600_000, {
    message: `a window lasts at most ${MAX_WINDOW_HOURS} h`,
    path: ["end"],
  });
export type AppointmentWindow = z.infer<typeof AppointmentWindow>;

/** Same instants, whatever offset each side was written with. */
export function sameWindow(a: AppointmentWindow, b: AppointmentWindow): boolean {
  return Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);
}

/** Why the dispatcher changed an order. */
export const DispatchReason = z.enum(["CUSTOMER_REQUEST", "FAILED_VISIT", "WORKLOAD_BALANCE", "INSTALLER_UNAVAILABLE", "OTHER"]);
export type DispatchReason = z.infer<typeof DispatchReason>;

const DetailBase = {
  eventId: DispatchEventId,
  ispId: IspId,
  workOrderNumber: WorkOrderNumber,
  reason: DispatchReason,
  /** Simulated instant of the world the order belongs to, given by the caller (the mock has no clock of its own). */
  occurredAtSim: ZonedInstant,
};

export const WorkOrderRescheduledDetail = z.object({ ...DetailBase, previousWindow: AppointmentWindow, newWindow: AppointmentWindow }).strict();
export type WorkOrderRescheduledDetail = z.infer<typeof WorkOrderRescheduledDetail>;

export const WorkOrderReassignedDetail = z
  .object({ ...DetailBase, previousInstallerId: InstallerId, newInstallerId: InstallerId })
  .strict()
  .refine((detail) => detail.previousInstallerId !== detail.newInstallerId, { message: "a reassignment changes the installer", path: ["newInstallerId"] });
export type WorkOrderReassignedDetail = z.infer<typeof WorkOrderReassignedDetail>;

export const WorkOrderCancelledDetail = z.object(DetailBase).strict();
export type WorkOrderCancelledDetail = z.infer<typeof WorkOrderCancelledDetail>;

/** An event as the mock emits it: its `DetailType` and its `Detail`. */
export const DispatchEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("WorkOrderRescheduled"), detail: WorkOrderRescheduledDetail }).strict(),
  z.object({ type: z.literal("WorkOrderReassigned"), detail: WorkOrderReassignedDetail }).strict(),
  z.object({ type: z.literal("WorkOrderCancelled"), detail: WorkOrderCancelledDetail }).strict(),
]);
export type DispatchEvent = z.infer<typeof DispatchEvent>;

// ---- As EventBridge delivers it to a Lambda target (the `FeedEvents` rule) ----------------------

// EventBridge adds `version`, `id`, `account`, `time`, `region` and `resources` around what the mock
// put; the envelope is loose on those, strict on the detail.
const busVariant = <T extends DispatchEventType, D extends z.ZodType>(type: T, detail: D) =>
  z.looseObject({ id: z.string().min(1), source: z.literal(DISPATCH_EVENT_SOURCE), "detail-type": z.literal(type), detail });

export const DispatchBusEvent = z.discriminatedUnion("detail-type", [
  busVariant("WorkOrderRescheduled", WorkOrderRescheduledDetail),
  busVariant("WorkOrderReassigned", WorkOrderReassignedDetail),
  busVariant("WorkOrderCancelled", WorkOrderCancelledDetail),
]);
export type DispatchBusEvent = z.infer<typeof DispatchBusEvent>;

/** Validates what the `Feeds` rule delivers and returns the event; throws a ZodError otherwise. */
export function parseDispatchBusEvent(raw: unknown): DispatchEvent {
  const envelope = DispatchBusEvent.parse(raw);
  return DispatchEvent.parse({ type: envelope["detail-type"], detail: envelope.detail });
}

export interface BusDelivery {
  /** EventBridge's own id of the delivery (not the `eventId` of the detail). */
  readonly id: string;
  /** Real instant EventBridge stamps on the entry. */
  readonly time: string;
  readonly account: string;
  readonly region: string;
}

/** The shape a Lambda target of the rule receives, for in-process flows and consumer tests. */
export function toBusEvent(event: DispatchEvent, delivery: BusDelivery): Record<string, unknown> {
  return {
    version: "0",
    id: delivery.id,
    "detail-type": event.type,
    source: DISPATCH_EVENT_SOURCE,
    account: delivery.account,
    time: delivery.time,
    region: delivery.region,
    resources: [],
    detail: event.detail,
  };
}
