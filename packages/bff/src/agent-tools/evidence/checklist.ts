// `get_checklist` and `update_checklist` (docs/tool-catalog.md, target `evidence`). The closing
// checklist of manual §EVI-01: five items, complete when each one is PASSED or validated by hand
// (OVERRIDDEN, a person in the console, ADR-0011). The agent can mark an item PASSED only with proof
// (`LAM-EVIDENCE`): for a photo, a PASS validation of the same order and item; for `ONU_ONLINE`, a
// `get_onu_status` of the same turn that was ONLINE and in range. `CUSTOMER_OK` is the installer's
// button and never the agent's; an item a person validated is never the agent's to undo.
import { type ChecklistItem, type ChecklistItemStatus, PhotoItem, ToolError } from "@cuadrilla/shared";
import { esMX } from "../../copy/es-MX";
import { inChecklistOrder } from "../../copy/helpers";
import type { ChecklistEntry, WorkOrder } from "../../domain/work-orders";
import { RUBRIC_VERSION } from "../../evidence/converse-request";
import { type ToolContext, implementTool } from "../common/context";
import { auditToolDenial } from "../common/denials";
import { requireActiveWorkOrder } from "../common/scope";
import { assertWorkable } from "./order-state";
import type { EvidenceToolRuntime } from "./runtime";
import { getChecklistTool, updateChecklistTool } from "./schema";

export const EVIDENCE_RULE = "LAM-EVIDENCE";
export const CHECKLIST_UPDATED_ACTION = "CHECKLIST_UPDATED";

const DONE: ReadonlySet<ChecklistItemStatus> = new Set<ChecklistItemStatus>(["PASSED", "OVERRIDDEN"]);

export function isChecklistComplete(entries: readonly Pick<ChecklistEntry, "status">[]): boolean {
  return entries.length > 0 && entries.every((entry) => DONE.has(entry.status));
}

function label(item: ChecklistItem): string {
  const text = esMX.checklistItem[item];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type Ctx = ToolContext<EvidenceToolRuntime>;

async function rubricHints(ctx: Ctx): Promise<Map<ChecklistItem, string>> {
  const hints = new Map<ChecklistItem, string>();
  for (const item of PhotoItem.options) {
    const rubric = await ctx.deps.connector.reference.getRubric(RUBRIC_VERSION, item);
    if (rubric !== undefined) hints.set(item, rubric.mustShow.join("; "));
  }
  return hints;
}

export const getChecklist = implementTool(getChecklistTool, async (_args, ctx: Ctx) => {
  const order = await requireActiveWorkOrder(ctx);
  const entries = await ctx.deps.connector.workOrders.listChecklist(order.workOrderId);
  const hints = await rubricHints(ctx);
  const byItem = new Map(entries.map((entry) => [entry.item, entry] as const));
  return {
    ok: true,
    items: inChecklistOrder([...byItem.keys()]).flatMap((item) => {
      const entry = byItem.get(item);
      if (entry === undefined) return [];
      const hint = hints.get(item);
      return [
        {
          item,
          label: label(item),
          status: entry.status,
          attempts: entry.attempts,
          ...(entry.lastRejectReason === undefined ? {} : { lastRejectReason: entry.lastRejectReason }),
          ...(hint === undefined ? {} : { rubricHint: hint }),
        },
      ];
    }),
    complete: isChecklistComplete(entries),
  };
});

/** `LAM-EVIDENCE` refused: `FORBIDDEN` with `AuditLog DENY`, the item unchanged. */
async function denyEvidence(ctx: Ctx, order: WorkOrder, item: ChecklistItem, reason: string, refs: Record<string, string> = {}): Promise<never> {
  await auditToolDenial(ctx, { ruleIds: [EVIDENCE_RULE], reason, refs: { workOrderId: order.workOrderId, item, ...refs } });
  throw new ToolError("FORBIDDEN", reason, EVIDENCE_RULE);
}

/** A `get_onu_status` of this turn that saw the ONU ONLINE and in range. */
async function onlineInRangeThisTurn(ctx: Ctx): Promise<boolean> {
  if (ctx.scope.turnId === undefined) return false;
  const results = await ctx.deps.connector.runtime.listTurnResults(ctx.scope.turnId, "get_onu_status");
  return results.some(({ output }) => output.ok === true && output.available !== false && output.operState === "ONLINE" && output.inRange === true);
}

interface Proof {
  readonly validationId?: string;
  readonly evidenceId?: string;
}

async function proofOf(ctx: Ctx, order: WorkOrder, item: Exclude<ChecklistItem, "CUSTOMER_OK">, validationId: string | undefined): Promise<Proof> {
  if (item === "ONU_ONLINE") {
    if (await onlineInRangeThisTurn(ctx)) return {};
    return denyEvidence(ctx, order, item, "no ONU reading of this turn was ONLINE and in range");
  }
  if (validationId === undefined) return denyEvidence(ctx, order, item, "a photo item needs the validationId of a PASS validation");
  const validation = await ctx.deps.connector.workOrders.getValidation(order.workOrderId, validationId);
  if (validation === undefined || validation.item !== item || validation.verdict !== "PASS") {
    return denyEvidence(ctx, order, item, "that validation is not a PASS of this order and item", { validationId });
  }
  return { validationId, ...(validation.evidenceId === undefined ? {} : { evidenceId: validation.evidenceId }) };
}

export const updateChecklist = implementTool(updateChecklistTool, async (args, ctx: Ctx) => {
  const order = await requireActiveWorkOrder(ctx);
  assertWorkable(order);
  const { connector } = ctx.deps;
  const current = await connector.workOrders.getChecklistItem(order.workOrderId, args.item);
  if (current === undefined) throw new ToolError("NOT_FOUND", "the order has no such checklist item");
  if (current.status === "OVERRIDDEN") {
    if (args.status === "PENDING") return denyEvidence(ctx, order, args.item, "a person validated this item by hand; only the console changes it");
    return { ok: true, item: args.item, status: current.status, complete: isChecklistComplete(await connector.workOrders.listChecklist(order.workOrderId)) };
  }
  const proof = args.status === "PASSED" ? await proofOf(ctx, order, args.item, args.validationId) : {};
  const atSim = ctx.scope.eventAtSim;
  const updated =
    current.status === args.status
      ? current
      : await connector.workOrders.updateChecklistItem(
          order.workOrderId,
          args.item,
          args.status === "PASSED"
            ? { status: "PASSED", validationId: proof.validationId ?? null, evidenceId: proof.evidenceId ?? null, ...(atSim === undefined ? {} : { updatedAtSim: atSim }) }
            : { status: "PENDING", ...(atSim === undefined ? {} : { updatedAtSim: atSim }) },
          { actor: ctx.actor, ...(atSim === undefined ? {} : { atSim }), reason: args.status === "PASSED" ? EVIDENCE_RULE : "agent" },
          { expectedVersion: current.version, expectedStatus: [current.status] },
        );
  await connector.audit.append({
    ispId: ctx.scope.ispId,
    clockId: ctx.scope.clockId,
    ...(atSim === undefined ? {} : { atSim }),
    ...(ctx.identity.kind === "HARNESS" ? { trigger: ctx.identity.session.trigger } : {}),
    decision: "ACTION",
    action: CHECKLIST_UPDATED_ACTION,
    ruleIds: args.status === "PASSED" ? [EVIDENCE_RULE] : [],
    actor: ctx.actor,
    refs: { workOrderId: order.workOrderId, item: args.item, ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }), ...(proof.validationId === undefined ? {} : { validationId: proof.validationId }) },
    detail: { from: current.status, to: updated.status },
  });
  return { ok: true, item: args.item, status: updated.status, complete: isChecklistComplete(await connector.workOrders.listChecklist(order.workOrderId)) };
});
