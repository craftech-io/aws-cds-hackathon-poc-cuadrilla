// `get_work_orders` and `get_work_order` (docs/tool-catalog.md, target `orders`): what the installer of
// the call has to do, read from the stored orders. Every id comes from the scope (`LAM-SCOPE`): the
// session's installer and day for the Harness, the subject a direct caller named. The customer appears
// by first name, street and neighborhood only; no phone, email or id of anyone leaves (PII column of
// the catalog). Every date goes out as text on the operator's wall clock (time-text.ts).
import { type CalendarDate, ChecklistItem, ToolError, addCalendarDays, ok } from "@cuadrilla/shared";
import { PENDING_STATUSES, chooseActiveWorkOrder, installerDayOrders } from "../../dayplan/active-order";
import type { Case } from "../../domain/cases";
import type { WorkOrder } from "../../domain/work-orders";
import { type ToolImplementation, implementTool } from "../common/context";
import { authorizeWorkOrder, requireActiveWorkOrder } from "../common/scope";
import { type OrdersContext, type OrdersRuntime, activeOrderRequestOf, requireInstallerId, worldTimeOf } from "./context";
import { acceptanceRangeOf, acceptanceRangeText } from "./range";
import { getWorkOrderTool, getWorkOrdersTool } from "./schema";
import { dayText, instantText, windowText } from "./time-text";
import { tipsOf } from "./tips";

/** ADR-0028: `recentWorkOrders` lists at most this many orders. */
export const RECENT_WORK_ORDERS = 10;
/** Days around today the recent orders are looked for (the installer's day index is by day). */
export const RECENT_DAYS_BACK = 7;
export const RECENT_DAYS_AHEAD = 3;

const OPEN_CASE = (caseItem: Case): boolean => caseItem.status !== "CLOSED";

async function orderSummary(ctx: OrdersContext, order: WorkOrder, timeZone: string) {
  const customer = await ctx.deps.connector.people.getCustomer(order.customerId);
  if (customer === undefined) throw new ToolError("UNAVAILABLE", "the order's customer could not be read", "CUSTOMER_MISSING");
  return {
    workOrderNumber: order.workOrderNumber,
    status: order.status,
    customerFirstName: customer.firstName,
    addressLine: customer.addressLine,
    neighborhood: customer.neighborhood,
    plan: order.plan,
    windowText: windowText(order.appointmentWindow, timeZone),
  };
}

/**
 * The installer's last ten orders of the world (ADR-0028): pending ones first, by appointment, then
 * the rest, the most recent first. Number, status and day only: nothing of the customer.
 */
async function recentWorkOrdersOf(ctx: OrdersContext, installerId: string, today: CalendarDate) {
  const days = Array.from({ length: RECENT_DAYS_BACK + RECENT_DAYS_AHEAD + 1 }, (_, index) => addCalendarDays(today, index - RECENT_DAYS_BACK));
  const request = { ispId: ctx.scope.ispId, clockId: ctx.scope.clockId, installerId };
  const orders = (await Promise.all(days.map((day) => installerDayOrders(ctx.deps, request, day)))).flat();
  const start = (order: WorkOrder): number => Date.parse(order.appointmentWindow.startSim);
  const open = orders.filter((order) => PENDING_STATUSES.has(order.status)).sort((a, b) => start(a) - start(b));
  const done = orders.filter((order) => !PENDING_STATUSES.has(order.status)).sort((a, b) => Date.parse(b.closedAtSim ?? b.appointmentWindow.endSim) - Date.parse(a.closedAtSim ?? a.appointmentWindow.endSim));
  return [...open, ...done].slice(0, RECENT_WORK_ORDERS).map((order) => ({
    workOrderNumber: order.workOrderNumber,
    status: order.status,
    dayText: dayText(order.date, today),
    open: PENDING_STATUSES.has(order.status),
  }));
}

export const getWorkOrders: ToolImplementation<OrdersRuntime> = implementTool(getWorkOrdersTool, async (args, ctx: OrdersContext) => {
  const installerId = requireInstallerId(ctx);
  const { now, timeZone, today } = await worldTimeOf(ctx);
  const day = args.day === "TOMORROW" ? addCalendarDays(today, 1) : today;
  const request = { ispId: ctx.scope.ispId, clockId: ctx.scope.clockId, installerId };
  const [person, orders, state, recentWorkOrders] = await Promise.all([
    ctx.deps.connector.people.getPerson(installerId),
    installerDayOrders(ctx.deps, request, day),
    ctx.deps.connector.worlds.getInstallerState(installerId),
    recentWorkOrdersOf(ctx, installerId, today),
  ]);
  if (person === undefined) throw new ToolError("NOT_FOUND", "the installer could not be read", "INSTALLER_MISSING");
  const workOrders = await Promise.all(
    orders.map(async (order) => ({
      ...(await orderSummary(ctx, order, timeZone)),
      isActive: state?.activeWorkOrderId === order.workOrderId,
      openCase: (await ctx.deps.connector.cases.listCasesOfWorkOrder(order.workOrderId)).some(OPEN_CASE),
    })),
  );
  return ok({ installerFirstName: person.firstName, dayText: dayText(day, today), workOrders, recentWorkOrders, nowSimText: instantText(now, timeZone) });
});

/** The order `get_work_order` reads: the number the model named (made active for the Harness) or the active one. */
async function orderOfCall(ctx: OrdersContext, workOrderNumber: string | undefined, atSim: string): Promise<WorkOrder> {
  if (workOrderNumber === undefined) return requireActiveWorkOrder(ctx);
  const order = await authorizeWorkOrder(ctx, workOrderNumber);
  // "Si llega workOrderNumber y es del instalador y del día, la vuelve activa" (set_active_work_order);
  // a closed or cancelled order of the day is read as it is, without becoming active.
  if (ctx.identity.kind === "HARNESS" && order.workOrderId !== ctx.scope.workOrderId && PENDING_STATUSES.has(order.status)) {
    return chooseActiveWorkOrder({ connector: ctx.deps.connector, logger: ctx.logger }, { ...activeOrderRequestOf(ctx, order.installerId, atSim), workOrderId: order.workOrderId }, "NAMED_BY_AGENT");
  }
  return order;
}

export const getWorkOrder: ToolImplementation<OrdersRuntime> = implementTool(getWorkOrderTool, async (args, ctx: OrdersContext) => {
  const { now, timeZone } = await worldTimeOf(ctx);
  const order = await orderOfCall(ctx, args.workOrderNumber, now.toISOString());
  const { connector } = ctx.deps;
  const [summary, zone, checklist, cases, steps, profile] = await Promise.all([
    orderSummary(ctx, order, timeZone),
    connector.isps.getZone(order.ispId, order.zoneId),
    connector.workOrders.listChecklist(order.workOrderId),
    connector.cases.listCasesOfWorkOrder(order.workOrderId),
    connector.workOrders.listSteps(order.workOrderId),
    connector.people.getProfile(order.installerId),
  ]);
  const range = acceptanceRangeOf(order, zone);
  const openCase = cases.filter(OPEN_CASE).at(-1);
  const takenBy = openCase?.takenBy === undefined ? undefined : await connector.people.getPerson(openCase.takenBy);
  const byItem = new Map(checklist.map((entry) => [entry.item, entry]));
  return ok({
    workOrder: {
      ...summary,
      onuSerial: order.onuSerial,
      onuModel: order.onuModel,
      oltPort: order.oltPort,
      opticalClass: order.opticalClass,
      acceptanceRange: { ...range, text: acceptanceRangeText(range, order.opticalClass) },
      onHoldSafety: order.onHoldSafety,
    },
    checklist: ChecklistItem.options.flatMap((item) => {
      const entry = byItem.get(item);
      return entry === undefined ? [] : [{ item, status: entry.status, attempts: entry.attempts }];
    }),
    ...(openCase === undefined
      ? {}
      : {
          openCase: {
            caseId: openCase.caseId,
            reason: openCase.reason,
            status: openCase.status,
            rung: openCase.rung,
            ...(takenBy === undefined ? {} : { takenByFirstName: takenBy.firstName }),
          },
        }),
    troubleshooting: steps.map((step) => ({ symptom: step.symptom, stepRef: step.stepRef, outcome: step.outcome })),
    facts: { tips: tipsOf(profile, now.toISOString()) },
  });
});
