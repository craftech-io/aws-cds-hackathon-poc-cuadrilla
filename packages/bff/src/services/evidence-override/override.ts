// `override_evidence` (docs/tool-catalog.md; FL-044; ADR-0011): the manual validation of a photo item a
// supervisor makes in the console, with a reason. It is always a person's decision: no tool of the
// agent can do it (`CED-NO-OVERRIDE`, `LAM-STRICT`, `LAM-EVIDENCE`), and the console's procedure asks
// for a sign-in of the last 15 minutes before calling this (`recentLoginProcedure`).
//
//   - only `SUPERVISOR` and `GUEST` (and the QaDriver's `usr-qa-*` principal in its worlds); `OPS` sees
//     and never validates
//   - only a photo item `REJECTED` or `IN_REVIEW` of an order still open; the write is conditional on
//     the status and the version read, so a validation racing the override is never overwritten
//   - the item becomes `OVERRIDDEN` with `override {userId, reason, atSim}` (reason masked) and a dated
//     history; `ACTION EVIDENCE_OVERRIDDEN` names the user; the certificate later says "validado
//     manualmente por <nombre>"
//   - `AGENT_TURN(EVIDENCE_OVERRIDDEN)` on the installer's queue: the agent tells the installer what is left
import { z } from "zod";
import { ConnectorError, PhotoItem, ToolError, WorkOrderId, type WorkOrderStatus } from "@cuadrilla/shared";
import { NonEmptyText } from "../../domain/common";
import { maskText } from "../../lib/mask";
import { type InstallerQueue, consoleEventId } from "../case-console/queue";
import { ACTING_ROLES, type ServiceDeps, inWorld, openCall, parseInput, recordDecision, worldNow } from "../people/direct-call";

export interface OverrideDeps extends ServiceDeps {
  readonly queue: InstallerQueue;
}

export const OverrideEvidenceInput = z
  .object({
    workOrderId: WorkOrderId,
    item: PhotoItem,
    reason: NonEmptyText.min(3).max(500),
  })
  .strict();
export type OverrideEvidenceInput = z.input<typeof OverrideEvidenceInput>;

/** Orders whose evidence can still change (also the "Cliente conforme" button's). */
export const OPEN_ORDER_STATUSES: ReadonlySet<WorkOrderStatus> = new Set<WorkOrderStatus>(["SCHEDULED", "IN_PROGRESS", "RESCHEDULED"]);

export const OVERRIDE_REASON = {
  NO_USER: "NO_USER",
  ORDER_NOT_OPEN: "ORDER_NOT_OPEN",
  ITEM_NOT_REVIEWABLE: "ITEM_NOT_REVIEWABLE",
  ITEM_CHANGED: "ITEM_CHANGED",
} as const;

export interface OverrideResult {
  readonly workOrderId: string;
  readonly item: PhotoItem;
  readonly status: "OVERRIDDEN";
  readonly overriddenBy: string;
  readonly atSim: string;
  /** The `AGENT_TURN(EVIDENCE_OVERRIDDEN)` queued for the installer. */
  readonly eventId: string;
}

export async function overrideEvidence(deps: OverrideDeps, caller: unknown, raw: unknown): Promise<OverrideResult> {
  const call = openCall(caller, { callers: ["CONSOLE", "QA"], consoleRoles: ACTING_ROLES });
  const input = parseInput(OverrideEvidenceInput, raw);
  const userId = call.caller.userId;
  if (userId === undefined) throw new ToolError("INVALID", "a manual validation names the person who made it", OVERRIDE_REASON.NO_USER);
  const { atSim } = await worldNow(deps, call);
  const order = inWorld(call, await deps.connector.workOrders.getWorkOrder(input.workOrderId), "work order");
  if (!OPEN_ORDER_STATUSES.has(order.status)) throw new ToolError("CONFLICT", "the order is no longer open", OVERRIDE_REASON.ORDER_NOT_OPEN);
  const entry = await deps.connector.workOrders.getChecklistItem(order.workOrderId, input.item);
  if (entry === undefined) throw new ToolError("NOT_FOUND", "checklist item not found");
  if (entry.status !== "REJECTED" && entry.status !== "IN_REVIEW") {
    throw new ToolError("CONFLICT", "only a rejected item or one in review is validated by hand", OVERRIDE_REASON.ITEM_NOT_REVIEWABLE);
  }

  const reason = maskText(input.reason);
  try {
    await deps.connector.workOrders.updateChecklistItem(
      order.workOrderId,
      input.item,
      { status: "OVERRIDDEN", override: { userId, reason, atSim }, updatedAtSim: atSim },
      { actor: call.actor, atSim, reason: "manual validation" },
      { expectedVersion: entry.version, expectedStatus: ["REJECTED", "IN_REVIEW"] },
    );
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "CONFLICT") throw new ToolError("CONFLICT", "the item changed while it was being validated", OVERRIDE_REASON.ITEM_CHANGED);
    throw error;
  }
  await recordDecision(deps, call, {
    decision: "ACTION",
    action: "EVIDENCE_OVERRIDDEN",
    atSim,
    refs: { workOrderId: order.workOrderId, item: input.item },
    detail: { userId, from: entry.status },
  });
  const eventId = consoleEventId("override", call.clockId, order.workOrderId, input.item, entry.version);
  await deps.queue.enqueue({
    type: "AGENT_TURN",
    trigger: "EVIDENCE_OVERRIDDEN",
    eventId,
    clockId: call.clockId,
    ispId: call.ispId,
    installerId: order.installerId,
    workOrderId: order.workOrderId,
    eventAtSim: atSim,
  });
  return { workOrderId: order.workOrderId, item: input.item, status: "OVERRIDDEN", overriddenBy: userId, atSim, eventId };
}
