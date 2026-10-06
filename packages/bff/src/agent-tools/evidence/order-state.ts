// What every evidence change asks of the order and of time. Only an order still being worked on
// takes evidence: a closed, cancelled or reassigned one answers CONFLICT, and an order held for a
// safety case answers ON_HOLD_SAFETY until a supervisor closes the case (docs/design-brief.md §5.9).
// Business time is the world's (ADR-0010): the turn's simulated instant for the Harness, the world
// clock for a direct caller.
import { ToolError, type WorkOrderStatus } from "@cuadrilla/shared";
import type { WorkOrder } from "../../domain/work-orders";
import { worldClock } from "../../lib/clock";
import type { ToolContext } from "../common/context";

const WORKABLE: ReadonlySet<WorkOrderStatus> = new Set<WorkOrderStatus>(["SCHEDULED", "IN_PROGRESS"]);

export function assertWorkable(order: Pick<WorkOrder, "status" | "onHoldSafety">): void {
  if (!WORKABLE.has(order.status)) throw new ToolError("CONFLICT", `the work order is ${order.status.toLowerCase().replace("_", " ")}`, "ORDER_NOT_OPEN");
  if (order.onHoldSafety) throw new ToolError("ON_HOLD_SAFETY", "the work order is on hold until the supervisor closes the safety case", "ON_HOLD_SAFETY");
}

/** The simulated instant of the call. */
export async function businessNow(ctx: Pick<ToolContext, "scope" | "deps">): Promise<string> {
  if (ctx.scope.eventAtSim !== undefined) return ctx.scope.eventAtSim;
  const clock = worldClock(ctx.scope.clockId, { readClock: (clockId) => ctx.deps.connector.runtime.getClock(clockId), realClock: ctx.deps.realClock });
  return (await clock.now()).toISOString();
}
