// `apply_dispatch_event` (docs/tool-catalog.md; FL-014, FL-015): what the `InstallerWorker` runs for a
// `DISPATCH_EVENT` of `FeedEvents`, inside the group of the order's installer. Deterministic; the model
// never decides it. The event's `detail` is the dispatcher's, validated again here with the mock's own
// schema of its change (an invalid one is ignored):
//
//   RESCHEDULED  new window and simulated day (the day's index moves with it), status `RESCHEDULED`
//   REASSIGNED   the new installer (each one's day index moves), status `REASSIGNED`
//   CANCELLED    status `CANCELLED`
//
// A `CLOSED` order is never changed (`DISPATCH_AFTER_CLOSE`), nor a `CANCELLED` one
// (`DISPATCH_AFTER_CANCEL`); both are audited and have no effect. An order that leaves an installer's
// day (cancelled, reassigned, moved to another day) stops being that installer's active order. The
// status transition is written last, with the dispatcher's `eventId` in its history entry: a retry
// after a failure in between applies the same values again, and one after it finds the entry and
// does nothing. The outcome names the installers whose current simulated day the change touches; the
// worker gives each one a turn `WORK_ORDER_CHANGED` (the notice goes out only within the window).
import { WorkOrderCancelledDetail, WorkOrderReassignedDetail, WorkOrderRescheduledDetail } from "@cuadrilla/dispatch-mock/events";
import type { Connector } from "../connector/ports";
import type { Transition } from "../domain/common";
import type { WorkOrder } from "../domain/work-orders";
import { localDateOf } from "../services/business-hours/zoned-time";
import type { DispatchEvent } from "../worker/events";

/** What `apply_dispatch_event` needs of a `DISPATCH_EVENT` (worker/events.ts); its `detail` is validated here. */
export type DispatchToApply = Pick<DispatchEvent, "clockId" | "ispId" | "workOrderId" | "change" | "detail">;

/** The dispatcher's detail of each change, as the mock published it (`@cuadrilla/dispatch-mock/events`). */
function parsedChange(event: DispatchToApply) {
  switch (event.change) {
    case "RESCHEDULED": {
      const detail = WorkOrderRescheduledDetail.safeParse(event.detail);
      return detail.success ? ({ change: event.change, detail: detail.data } as const) : undefined;
    }
    case "REASSIGNED": {
      const detail = WorkOrderReassignedDetail.safeParse(event.detail);
      return detail.success ? ({ change: event.change, detail: detail.data } as const) : undefined;
    }
    case "CANCELLED": {
      const detail = WorkOrderCancelledDetail.safeParse(event.detail);
      return detail.success ? ({ change: event.change, detail: detail.data } as const) : undefined;
    }
  }
}

export interface ApplyDispatchDeps {
  readonly connector: Pick<Connector, "workOrders" | "worlds" | "audit">;
}

export interface ApplyDispatchContext {
  /** Simulated "now" of the order's world when the worker runs the event. */
  readonly simNow: Date;
  readonly timeZone: string;
}

export interface DispatchTurn {
  readonly installerId: string;
  readonly workOrderId: string;
}

export type ApplyDispatchOutcome =
  | { readonly status: "APPLIED"; readonly workOrder: WorkOrder; readonly turns: readonly DispatchTurn[] }
  | { readonly status: "IGNORED"; readonly reason: "INVALID_DETAIL" | "UNKNOWN_ORDER" | "ALREADY_APPLIED" | "DISPATCH_AFTER_CLOSE" | "DISPATCH_AFTER_CANCEL" };

/** Statuses a dispatcher may still change. */
const OPEN_STATUSES = ["SCHEDULED", "IN_PROGRESS", "FAILED_VISIT", "RESCHEDULED", "REASSIGNED"] as const;

/** The marker of the history entry that applied an event. */
export function dispatchMarker(eventId: string): string {
  return `dispatch:${eventId}`;
}

async function clearActive(installerId: string, order: WorkOrder, atSim: string, deps: ApplyDispatchDeps): Promise<void> {
  const state = await deps.connector.worlds.getInstallerState(installerId);
  if (state?.activeWorkOrderId === order.workOrderId) await deps.connector.worlds.setActiveWorkOrder(installerId, order.clockId, null, atSim);
}

type Change = NonNullable<ReturnType<typeof parsedChange>>;

async function audit(event: DispatchToApply, change: Change, decision: "ACTION" | "DENY", reason: string, detail: Record<string, string>, deps: ApplyDispatchDeps, atSim: string): Promise<void> {
  await deps.connector.audit.append({
    ispId: event.ispId,
    clockId: event.clockId,
    atSim,
    decision,
    action: "DISPATCH_EVENT",
    actor: "SYSTEM",
    reason,
    refs: { workOrderId: event.workOrderId, eventId: change.detail.eventId },
    detail: { change: change.change, dispatchReason: change.detail.reason, ...detail },
  });
}

/** Applies one dispatcher's event to its order. */
export async function applyDispatchEvent(event: DispatchToApply, context: ApplyDispatchContext, deps: ApplyDispatchDeps): Promise<ApplyDispatchOutcome> {
  const { workOrders } = deps.connector;
  const dispatch = parsedChange(event);
  if (dispatch === undefined) return { status: "IGNORED", reason: "INVALID_DETAIL" };
  const atSim = context.simNow.toISOString();
  const order = await workOrders.getWorkOrder(event.workOrderId);
  if (order === undefined || order.ispId !== event.ispId || order.workOrderNumber !== dispatch.detail.workOrderNumber) return { status: "IGNORED", reason: "UNKNOWN_ORDER" };
  const marker = dispatchMarker(dispatch.detail.eventId);
  if (order.history.some((entry) => entry.reason === marker || entry.reason?.startsWith(`${marker} `) === true)) return { status: "IGNORED", reason: "ALREADY_APPLIED" };
  if (order.status === "CLOSED" || order.status === "CANCELLED") {
    const reason = order.status === "CLOSED" ? "DISPATCH_AFTER_CLOSE" : "DISPATCH_AFTER_CANCEL";
    await audit(event, dispatch, "DENY", reason, { orderStatus: order.status }, deps, atSim);
    return { status: "IGNORED", reason };
  }
  const today = localDateOf(context.simNow, context.timeZone);
  const transition: Transition = { actor: "SYSTEM", atSim: dispatch.detail.occurredAtSim, reason: marker };
  const guard = { from: OPEN_STATUSES };
  let turns: DispatchTurn[] = [];
  let updated: WorkOrder;
  switch (dispatch.change) {
    case "RESCHEDULED": {
      const { newWindow } = dispatch.detail;
      const date = localDateOf(new Date(newWindow.start), context.timeZone);
      await workOrders.updateWorkOrder(order.workOrderId, { appointmentWindow: { startSim: newWindow.start, endSim: newWindow.end }, date });
      if (date !== order.date) await clearActive(order.installerId, order, atSim, deps);
      updated = await workOrders.setStatus(order.workOrderId, "RESCHEDULED", transition, guard);
      if (order.date === today || date === today) turns = [{ installerId: order.installerId, workOrderId: order.workOrderId }];
      await audit(event, dispatch, "ACTION", dispatch.change, { fromDate: order.date, toDate: date, fromStart: order.appointmentWindow.startSim, toStart: newWindow.start }, deps, atSim);
      break;
    }
    case "REASSIGNED": {
      const { newInstallerId } = dispatch.detail;
      // A retry after the owner was already written finds the new installer: the dispatcher names the previous one.
      const previous = order.installerId === newInstallerId ? dispatch.detail.previousInstallerId : order.installerId;
      await workOrders.updateWorkOrder(order.workOrderId, { installerId: newInstallerId });
      await clearActive(previous, order, atSim, deps);
      updated = await workOrders.setStatus(order.workOrderId, "REASSIGNED", { ...transition, reason: `${marker} ${previous}->${newInstallerId}` }, guard);
      if (order.date === today) turns = [previous, newInstallerId].map((installerId) => ({ installerId, workOrderId: order.workOrderId }));
      await audit(event, dispatch, "ACTION", dispatch.change, { fromInstallerId: previous, toInstallerId: newInstallerId }, deps, atSim);
      break;
    }
    case "CANCELLED": {
      await clearActive(order.installerId, order, atSim, deps);
      updated = await workOrders.setStatus(order.workOrderId, "CANCELLED", transition, guard);
      if (order.date === today) turns = [{ installerId: order.installerId, workOrderId: order.workOrderId }];
      await audit(event, dispatch, "ACTION", dispatch.change, { fromStatus: order.status }, deps, atSim);
      break;
    }
  }
  return { status: "APPLIED", workOrder: updated, turns };
}
