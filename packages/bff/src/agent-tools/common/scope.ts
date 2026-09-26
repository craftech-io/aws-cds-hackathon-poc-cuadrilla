// `LAM-SCOPE` (docs/design-brief.md §5.6, docs/tool-catalog.md "Sesión"): the operator, the world,
// the installer and the order a call may touch come from the principal, never from the model. An id
// the model writes is accepted only when it names an order of the session's installer on the
// session's simulated day (a reassigned order stops being reachable, FL-015; another installer's
// order never is, FL-025). Anything else is `FORBIDDEN` with `AuditLog DENY LAM-SCOPE`, and an
// unknown number is refused exactly like a foreign one, so the answer never tells whether it exists.
// A direct caller is scoped to its operator and world, and to the subject it named.
import { type CalendarDate, ERROR_REASON, ToolError, WorkOrderId, WorkOrderNumber } from "@cuadrilla/shared";
import type { Case } from "../../domain/cases";
import type { WorkOrder } from "../../domain/work-orders";
import { MEXICO_CITY_TIME_ZONE, localDateOf } from "../../services/business-hours/zoned-time";
import type { ToolScope, ToolSubject } from "./context";
import { type DenialContext, auditToolDenial } from "./denials";

export const SCOPE_RULE = "LAM-SCOPE";

/** Reason of `NOT_FOUND` when a tool needs the active order and the turn has none. */
export const NO_ACTIVE_WORK_ORDER = "NO_ACTIVE_WORK_ORDER";

async function deny(ctx: DenialContext, reason: string, detail: Record<string, string>): Promise<never> {
  await auditToolDenial(ctx, { ruleIds: [SCOPE_RULE], reason, detail });
  throw new ToolError("FORBIDDEN", "that is outside the work of this session", ERROR_REASON.WORK_ORDER_NOT_IN_SESSION);
}

/** Simulated calendar day of the turn in the operator's zone; `undefined` for a direct caller. */
export async function sessionDay(ctx: DenialContext): Promise<CalendarDate | undefined> {
  if (ctx.scope.eventAtSim === undefined) return undefined;
  const settings = await ctx.deps.connector.isps.getSettings(ctx.scope.ispId);
  return localDateOf(new Date(ctx.scope.eventAtSim), settings?.timezone ?? MEXICO_CITY_TIME_ZONE);
}

function inWorld(scope: ToolScope, item: { readonly ispId: string; readonly clockId: string }): boolean {
  return item.ispId === scope.ispId && item.clockId === scope.clockId;
}

/**
 * The order a reference names (`24817` or `wo-24817`), if it is in scope. For the Harness: an order of
 * the session's installer on the session's day. For a caller: an order of its world (and of its
 * subject's installer, when it named one).
 */
export async function authorizeWorkOrder(ctx: DenialContext, ref: string): Promise<WorkOrder> {
  const { scope } = ctx;
  const byNumber = WorkOrderNumber.safeParse(ref).success;
  if (!byNumber && !WorkOrderId.safeParse(ref).success) throw new ToolError("INVALID", "expected a work order number such as 24817");
  if (ctx.identity.kind === "HARNESS") {
    const day = await sessionDay(ctx);
    if (scope.installerId === undefined || day === undefined) return deny(ctx, "the session has no installer day", { requestedRef: ref });
    const orders = await ctx.deps.connector.workOrders.listInstallerDay(scope.installerId, day);
    const match = orders.find((order) => (byNumber ? order.workOrderNumber === ref : order.workOrderId === ref) && inWorld(scope, order) && order.installerId === scope.installerId);
    return match ?? deny(ctx, "the work order is not one of the installer's orders of the day", { requestedRef: ref });
  }
  if (byNumber) throw new ToolError("INVALID", "a direct caller names the work order by id");
  const order = await ctx.deps.connector.workOrders.getWorkOrder(ref);
  if (order === undefined) throw new ToolError("NOT_FOUND", "no such work order");
  if (!inWorld(scope, order)) return deny(ctx, "the work order belongs to another operator or world", { requestedRef: ref });
  if (scope.installerId !== undefined && order.installerId !== scope.installerId) return deny(ctx, "the work order belongs to another installer", { requestedRef: ref });
  return order;
}

/** The active order of the turn (or the caller's subject), in scope; `NOT_FOUND` when there is none. */
export async function requireActiveWorkOrder(ctx: DenialContext): Promise<WorkOrder> {
  if (ctx.scope.workOrderId === undefined) throw new ToolError("NOT_FOUND", "there is no active work order", NO_ACTIVE_WORK_ORDER);
  return authorizeWorkOrder(ctx, ctx.scope.workOrderId);
}

/** Every order the model named (`refs.workOrderIds`), all in scope, in the given order. */
export async function authorizeWorkOrders(ctx: DenialContext, refs: readonly string[]): Promise<WorkOrder[]> {
  const orders: WorkOrder[] = [];
  for (const ref of new Set(refs)) orders.push(await authorizeWorkOrder(ctx, ref));
  return orders;
}

/** A case the model named, only if it belongs to an order in scope. */
export async function authorizeCase(ctx: DenialContext, caseId: string): Promise<Case> {
  const found = await ctx.deps.connector.cases.getCase(caseId);
  if (found === undefined) {
    if (ctx.identity.kind === "HARNESS") return deny(ctx, "the case is not one of the session's", { requestedCaseId: caseId });
    throw new ToolError("NOT_FOUND", "no such case");
  }
  if (!inWorld(ctx.scope, found)) return deny(ctx, "the case belongs to another operator or world", { requestedCaseId: caseId });
  await authorizeWorkOrder(ctx, found.workOrderId);
  return found;
}

/**
 * The scope of a direct call with its subject verified against the caller's world: the order (and
 * its installer) or the installer it names must exist there. Called by `createToolHandler` before
 * the tool runs, so every tool of a caller already sees a checked subject.
 */
export async function scopeWithSubject(ctx: DenialContext, subject: ToolSubject | undefined): Promise<ToolScope> {
  if (subject === undefined) return ctx.scope;
  let installerId = subject.installerId;
  if (installerId !== undefined) {
    const person = await ctx.deps.connector.people.getPerson(installerId);
    if (person === undefined) throw new ToolError("NOT_FOUND", "no such installer");
    if (!inWorld(ctx.scope, person) || person.role !== "INSTALLER") return deny(ctx, "the installer belongs to another operator or world", { requestedInstallerId: installerId });
  }
  const scoped = { ...ctx, scope: { ...ctx.scope, ...(installerId === undefined ? {} : { installerId }) } };
  if (subject.workOrderId === undefined) return scoped.scope;
  const order = await authorizeWorkOrder(scoped, subject.workOrderId);
  installerId ??= order.installerId;
  return { ...ctx.scope, installerId, workOrderId: order.workOrderId };
}
