// `set_active_work_order` (docs/tool-catalog.md "Handlers de invocación directa", CONTEXT.md "Orden
// activa", FL-013): which order an installer's message is about. Code decides, never the model:
//
//   the stored active order is still pending today          → it stays
//   exactly one pending order today                          → it becomes active without asking
//   none pending                                             → no active order (the day's session)
//   several pending and none active                          → `ORDER_CHOICE`: an interactive list of
//                                                              the pending orders, one nonce per row
//
// The channel (`InboundWhatsApp`) and the worker resolve it before a turn; the installer's tap on a row
// (`CHOOSE_ORDER`) and `get_work_order` with a number of the installer's day call `chooseActiveWorkOrder`.
// Every change is `INSTSTATE#.activeWorkOrderId` with `AuditLog ACTION ACTIVE_WORK_ORDER_SET`. The list
// is built here and sent by the caller through the outbound pipeline (it issues the row nonces).
import { type CalendarDate, ToolError, type WaButtonAction } from "@cuadrilla/shared";
import { esMX } from "../copy/es-MX";
import type { ListRowText } from "../copy/types";
import type { Connector } from "../connector/ports";
import type { Actor } from "../domain/common";
import type { NonceObject } from "../domain/runtime";
import type { WorkOrder } from "../domain/work-orders";
import { windowText } from "../agent-tools/orders/time-text";
import type { Logger } from "../lib/log";
import { MEXICO_CITY_TIME_ZONE, localDateOf } from "../services/business-hours/zoned-time";

export const ACTIVE_WORK_ORDER_SET = "ACTIVE_WORK_ORDER_SET";
export const ACTIVE_WORK_ORDER_CLEARED = "ACTIVE_WORK_ORDER_CLEARED";

/** Orders the installer can still work on today: the ones a message can be about. */
export const PENDING_STATUSES: ReadonlySet<WorkOrder["status"]> = new Set<WorkOrder["status"]>(["SCHEDULED", "IN_PROGRESS", "RESCHEDULED"]);

/** WhatsApp lists take at most ten rows. */
export const ORDER_CHOICE_MAX_ROWS = 10;

export interface ActiveOrderDeps {
  readonly connector: Pick<Connector, "isps" | "people" | "workOrders" | "worlds" | "audit">;
  readonly logger: Logger;
}

export interface ActiveOrderRequest {
  readonly ispId: string;
  readonly clockId: string;
  readonly installerId: string;
  /** Simulated instant of the message (its local day is the day whose orders count). */
  readonly atSim: string;
  readonly actor: Actor;
  /** Message, event or turn the change belongs to (audit refs). */
  readonly refs?: { readonly messageId?: string; readonly eventId?: string; readonly turnId?: string };
}

/** A row of the `ORDER_CHOICE` list: the text and what its nonce means. */
export interface OrderChoiceRow extends ListRowText {
  readonly workOrderId: string;
  readonly action: Extract<WaButtonAction, "CHOOSE_ORDER">;
  readonly object: NonceObject;
}

/** The interactive list the caller sends as `ORDER_CHOICE` (one nonce per row). */
export interface OrderChoice {
  readonly kind: "ORDER_CHOICE";
  readonly body: string;
  readonly rows: readonly OrderChoiceRow[];
  readonly workOrderIds: readonly string[];
}

export type ActiveOrderResolution =
  | { readonly kind: "ACTIVE"; readonly workOrder: WorkOrder; readonly changed: boolean }
  | { readonly kind: "NONE" }
  | { readonly kind: "CHOICE"; readonly choice: OrderChoice };

const byWindow = (a: WorkOrder, b: WorkOrder): number => Date.parse(a.appointmentWindow.startSim) - Date.parse(b.appointmentWindow.startSim) || (a.workOrderNumber < b.workOrderNumber ? -1 : 1);

async function timeZoneOf(deps: ActiveOrderDeps, ispId: string): Promise<string> {
  return (await deps.connector.isps.getSettings(ispId))?.timezone ?? MEXICO_CITY_TIME_ZONE;
}

/** The installer's orders of `day` in the request's world, still assigned to them, by window. */
export async function installerDayOrders(deps: Pick<ActiveOrderDeps, "connector">, request: Pick<ActiveOrderRequest, "ispId" | "clockId" | "installerId">, day: CalendarDate): Promise<WorkOrder[]> {
  const orders = await deps.connector.workOrders.listInstallerDay(request.installerId, day);
  return orders.filter((order) => order.installerId === request.installerId && order.ispId === request.ispId && order.clockId === request.clockId).sort(byWindow);
}

async function pendingToday(deps: ActiveOrderDeps, request: ActiveOrderRequest): Promise<{ pending: WorkOrder[]; timeZone: string }> {
  const timeZone = await timeZoneOf(deps, request.ispId);
  const orders = await installerDayOrders(deps, request, localDateOf(new Date(request.atSim), timeZone));
  return { pending: orders.filter((order) => PENDING_STATUSES.has(order.status)), timeZone };
}

async function audit(deps: ActiveOrderDeps, request: ActiveOrderRequest, action: string, workOrderId: string, reason: string): Promise<void> {
  try {
    await deps.connector.audit.append({
      ispId: request.ispId,
      clockId: request.clockId,
      atSim: request.atSim,
      decision: "ACTION",
      action,
      actor: request.actor,
      reason,
      refs: { workOrderId, installerId: request.installerId, ...request.refs },
    });
  } catch (error) {
    deps.logger.error("active_order.audit_failed", { action, workOrderId, error });
  }
}

/** Makes `order` the installer's active order (no-op when it already is); `true` when it changed. */
export async function activateWorkOrder(deps: ActiveOrderDeps, request: ActiveOrderRequest, order: WorkOrder, reason: string): Promise<boolean> {
  const state = await deps.connector.worlds.getInstallerState(request.installerId);
  if (state?.activeWorkOrderId === order.workOrderId) return false;
  await deps.connector.worlds.setActiveWorkOrder(request.installerId, request.clockId, order.workOrderId, request.atSim);
  await audit(deps, request, ACTIVE_WORK_ORDER_SET, order.workOrderId, reason);
  deps.logger.info("active_order.set", { workOrderId: order.workOrderId, reason });
  return true;
}

/** The deterministic list of the pending orders: "OT 24817 · 09:00 a 11:00 · Las Lomitas". */
export async function buildOrderChoice(deps: Pick<ActiveOrderDeps, "connector">, pending: readonly WorkOrder[], timeZone: string): Promise<OrderChoice> {
  const shown = [...pending].sort(byWindow).slice(0, ORDER_CHOICE_MAX_ROWS);
  const rows = await Promise.all(
    shown.map(async (order): Promise<OrderChoiceRow> => {
      const customer = await deps.connector.people.getCustomer(order.customerId);
      const text = esMX.orderChoiceRow({ workOrderNumber: order.workOrderNumber, windowText: windowText(order.appointmentWindow, timeZone), neighborhood: customer?.neighborhood ?? "" });
      return { ...text, workOrderId: order.workOrderId, action: "CHOOSE_ORDER", object: { kind: "WORK_ORDER", id: order.workOrderId } };
    }),
  );
  return { kind: "ORDER_CHOICE", body: esMX.orderChoicePrompt, rows, workOrderIds: rows.map((row) => row.workOrderId) };
}

/** Resolves the active order before a turn (FL-013); never asks the model. */
export async function resolveActiveWorkOrder(deps: ActiveOrderDeps, request: ActiveOrderRequest): Promise<ActiveOrderResolution> {
  const [{ pending, timeZone }, state] = await Promise.all([pendingToday(deps, request), deps.connector.worlds.getInstallerState(request.installerId)]);
  const current = state?.activeWorkOrderId;
  const stillPending = pending.find((order) => order.workOrderId === current);
  if (stillPending !== undefined) return { kind: "ACTIVE", workOrder: stillPending, changed: false };
  if (current !== undefined) {
    // The stored order was closed, cancelled or reassigned: the installer no longer works on it.
    await deps.connector.worlds.setActiveWorkOrder(request.installerId, request.clockId, null);
    await audit(deps, request, ACTIVE_WORK_ORDER_CLEARED, current, "NOT_PENDING");
  }
  const [only, ...others] = pending;
  if (only === undefined) return { kind: "NONE" };
  if (others.length === 0) {
    await activateWorkOrder(deps, request, only, "ONLY_PENDING_ORDER");
    return { kind: "ACTIVE", workOrder: only, changed: true };
  }
  return { kind: "CHOICE", choice: await buildOrderChoice(deps, pending, timeZone) };
}

/**
 * The installer chose an order (a `CHOOSE_ORDER` row, or `get_work_order` with a number of their day):
 * only a pending order of their day in this world; anything else is `FORBIDDEN` or `CONFLICT`.
 */
export async function chooseActiveWorkOrder(deps: ActiveOrderDeps, request: ActiveOrderRequest & { readonly workOrderId: string }, reason = "CHOSEN"): Promise<WorkOrder> {
  const timeZone = await timeZoneOf(deps, request.ispId);
  const orders = await installerDayOrders(deps, request, localDateOf(new Date(request.atSim), timeZone));
  const order = orders.find((candidate) => candidate.workOrderId === request.workOrderId);
  if (order === undefined) throw new ToolError("FORBIDDEN", "that is not one of the installer's orders of the day", "WORK_ORDER_NOT_IN_DAY");
  if (!PENDING_STATUSES.has(order.status)) throw new ToolError("CONFLICT", "that order is no longer pending", "WORK_ORDER_NOT_PENDING");
  await activateWorkOrder(deps, request, order, reason);
  return order;
}
