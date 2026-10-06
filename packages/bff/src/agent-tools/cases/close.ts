// `close_installation` (docs/tool-catalog.md, target `cases`; docs/architecture.md §11): the agent in a
// turn, the installer's "Cerrar instalación" button (`caller CHANNEL`, run by the InstallerWorker as a
// `BUTTON_ACTION` with no turn) and the `QaDriver` close an order through here.
//
//   INSTALLED     every checklist item PASSED (with its evidence) or OVERRIDDEN, the ONU ONLINE and in
//                 range in a reading of the last 30 simulated minutes, and no SAFETY case open. Without
//                 a recent reading the tool reads the ONU itself, as the caller (`network/client.ts`),
//                 records it and decides with it. Anything missing → `NOT_COMPLETE` with `missing`:
//                 the agent tells the installer; from the button, the worker sends `closeNotComplete`
//                 (channels/whatsapp/button-actions.ts); for QA nobody does. Complete → the certificate
//                 writer (`CertificatePort`): PDF, `sha256`, deliveries queued; the order is CLOSED.
//   FAILED_VISIT  no certificate; the order records why and the dispatch learns it from the audit log.
//
// `force` is declared only so Cedar and `LAM-STRICT` refuse it (`CED-NO-FORCE-CLOSE`).
import { type ChecklistItem, ChecklistItem as ChecklistItemSchema, type OnuOperState, ToolError, fail } from "@cuadrilla/shared";
import type { NetworkReader } from "@cuadrilla/network-contract";
import { inChecklistOrder } from "../../copy/helpers";
import type { ChecklistEntry, OnuReading, WorkOrder } from "../../domain/work-orders";
import { implementTool } from "../common/context";
import { requireActiveWorkOrder } from "../common/scope";
import { acceptanceRangeOf, readingInRange } from "../orders/range";
import { worldTimeOf } from "../orders/context";
import type { CasesContext } from "./runtime";
import { closeInstallationTool } from "./schema";

/** A reading older than this (simulated) does not prove the ONU is online at the close. */
export const ONU_READING_MAX_AGE_MS = 30 * 60_000;

const OPEN_STATUSES: readonly WorkOrder["status"][] = ["SCHEDULED", "IN_PROGRESS"];
const PHOTO_ITEMS: ReadonlySet<ChecklistItem> = new Set<ChecklistItem>(["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"]);

/** Whether a checklist item counts for the close: passed with its evidence (photos), or validated by hand. */
function itemDone(entry: ChecklistEntry | undefined): boolean {
  if (entry === undefined) return false;
  if (entry.status === "OVERRIDDEN") return true;
  return entry.status === "PASSED" && (!PHOTO_ITEMS.has(entry.item) || entry.evidenceId !== undefined);
}

function recent(reading: OnuReading | undefined, atSim: string): reading is OnuReading {
  if (reading === undefined) return false;
  const age = Date.parse(atSim) - Date.parse(reading.observedAtSim);
  return age >= 0 && age <= ONU_READING_MAX_AGE_MS;
}

function readerOf(ctx: CasesContext): NetworkReader {
  return ctx.identity.kind === "HARNESS" ? "HARNESS" : ctx.identity.kind;
}

/** ONLINE and in range: the stored reading when it is recent, otherwise one of our own, recorded. */
async function onuReady(ctx: CasesContext, order: WorkOrder, atSim: string): Promise<boolean> {
  if (recent(order.lastOnuReading, atSim)) return order.lastOnuReading.operState === "ONLINE" && order.lastOnuReading.inRange;
  const outcome = await ctx.deps.network.getOnuStatus({ clockId: order.clockId, serial: order.onuSerial, caller: readerOf(ctx), atSim, logger: ctx.logger });
  if (outcome.kind === "UNAVAILABLE") throw new ToolError("UNAVAILABLE", "the network orchestrator cannot be read right now", "NETWORK_UNAVAILABLE");
  if (outcome.kind === "NOT_FOUND") return false;
  const zone = await ctx.deps.connector.isps.getZone(order.ispId, order.zoneId);
  const operState: OnuOperState = outcome.value.operState;
  const inRange = readingInRange(operState, outcome.value.rxPowerDbm, acceptanceRangeOf(order, zone));
  await ctx.deps.connector.workOrders.recordOnuReading(order.workOrderId, {
    operState,
    inRange,
    observedAtSim: atSim,
    source: "CLOSE",
    ...(outcome.value.rxPowerDbm === undefined ? {} : { rxPowerDbm: outcome.value.rxPowerDbm }),
    ...(outcome.value.txPowerDbm === undefined ? {} : { txPowerDbm: outcome.value.txPowerDbm }),
  });
  return inRange;
}

async function audit(ctx: CasesContext, order: WorkOrder, atSim: string, decision: "ACTION" | "DENY", action: string, ruleIds: string[], detail: Record<string, unknown>): Promise<void> {
  await ctx.deps.connector.audit.append({
    ispId: order.ispId,
    clockId: order.clockId,
    atSim,
    decision,
    action,
    ruleIds,
    actor: ctx.actor,
    ...(ctx.identity.kind === "HARNESS" ? { trigger: ctx.identity.session.trigger } : {}),
    refs: { workOrderId: order.workOrderId, ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }), ...(ctx.scope.eventId === undefined ? {} : { eventId: ctx.scope.eventId }) },
    detail,
  });
}

/** What keeps the order from closing as installed: items missing and whether it is on hold for safety. */
async function readiness(ctx: CasesContext, order: WorkOrder, atSim: string): Promise<{ missing: ChecklistItem[]; onHold: boolean }> {
  const { workOrders, cases } = ctx.deps.connector;
  const [checklist, orderCases] = await Promise.all([workOrders.listChecklist(order.workOrderId), cases.listCasesOfWorkOrder(order.workOrderId)]);
  const onHold = order.onHoldSafety || orderCases.some((item) => item.kind === "SAFETY" && item.status !== "CLOSED");
  const byItem = new Map(checklist.map((entry) => [entry.item, entry] as const));
  const missing = ChecklistItemSchema.options.filter((item) => !itemDone(byItem.get(item)));
  if (!onHold && !missing.includes("ONU_ONLINE") && !(await onuReady(ctx, order, atSim))) missing.push("ONU_ONLINE");
  return { missing: inChecklistOrder(missing), onHold };
}

async function failedVisit(ctx: CasesContext, order: WorkOrder, atSim: string, reason: NonNullable<WorkOrder["failedReason"]>) {
  const { workOrders } = ctx.deps.connector;
  await workOrders.setStatus(order.workOrderId, "FAILED_VISIT", { actor: ctx.actor, atSim, reason }, { from: OPEN_STATUSES });
  await workOrders.updateWorkOrder(order.workOrderId, { failedReason: reason, closedAtSim: atSim });
  await audit(ctx, order, atSim, "ACTION", "VISIT_FAILED", [], { failedReason: reason, notifyDispatch: true });
  return { ok: true as const, status: "FAILED_VISIT" as const, deliveries: [] };
}

export const closeInstallation = implementTool(closeInstallationTool, async (args, ctx: CasesContext) => {
  const order = await requireActiveWorkOrder(ctx);
  const atSim = (await worldTimeOf(ctx)).now.toISOString();
  const { workOrders } = ctx.deps.connector;
  if (order.status === "CLOSED") {
    const certificate = await workOrders.getCertificate(order.workOrderId);
    return { ok: true, status: "CLOSED" as const, deliveries: [], ...(certificate?.sha256 === undefined ? {} : { certificateId: certificate.certificateId, sha256: certificate.sha256 }) };
  }
  if (order.status === "FAILED_VISIT") return { ok: true, status: "FAILED_VISIT" as const, deliveries: [] };
  if (!OPEN_STATUSES.includes(order.status)) throw new ToolError("CONFLICT", `the order is ${order.status} and cannot be closed`, "ORDER_NOT_OPEN");
  if (args.outcome === "FAILED_VISIT") {
    if (args.failedReason === undefined) throw new ToolError("INVALID", "a failed visit needs failedReason", "FAILED_REASON_REQUIRED");
    return failedVisit(ctx, order, atSim, args.failedReason);
  }

  const { missing, onHold } = await readiness(ctx, order, atSim);
  if (onHold || missing.length > 0) {
    await audit(ctx, order, atSim, "DENY", "CLOSE_INSTALLATION", onHold ? ["CP-CERT-EVIDENCE", "SAFE-HOLD"] : ["CP-CERT-EVIDENCE"], { missing, onHold, via: ctx.identity.kind });
    const message = onHold ? "the order is on hold for safety until a supervisor closes its case" : `missing: ${missing.join(", ")}`;
    return { ...fail("NOT_COMPLETE", message, onHold ? "ON_HOLD_SAFETY" : "CHECKLIST_INCOMPLETE"), missing };
  }

  const closedBy = ctx.identity.kind === "HARNESS" ? "HARNESS" : ctx.identity.kind === "CHANNEL" ? "CHANNEL" : "QA";
  const issued = await ctx.deps.certificates.issue({
    workOrderId: order.workOrderId,
    ispId: order.ispId,
    clockId: order.clockId,
    closedBy,
    closedAtSim: atSim,
    correlationId: ctx.correlationId,
    ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }),
  });
  const after = await workOrders.requireWorkOrder(order.workOrderId);
  if (after.status !== "CLOSED") {
    await workOrders.setStatus(order.workOrderId, "CLOSED", { actor: ctx.actor, atSim, reason: "INSTALLED" }, { from: OPEN_STATUSES });
    await workOrders.updateWorkOrder(order.workOrderId, { closedAtSim: atSim });
  }
  await audit(ctx, order, atSim, "ACTION", "INSTALLATION_CLOSED", ["CP-CERT-EVIDENCE"], { certificateId: issued.certificateId, via: ctx.identity.kind });
  return { ok: true, status: "CLOSED" as const, certificateId: issued.certificateId, sha256: issued.sha256, deliveries: issued.deliveries };
});
