// `handle_safety` (docs/design-brief.md §5.9, ADR-0016): what happens when the classifier matches a
// message (`detectedBy LEXICON`) or the agent calls `report_safety_hazard` (`detectedBy AGENT`). Both
// paths run this handler, deterministic and never stopped by the kill switch:
//
//   1. the fixed instruction of manual §SEG-01 (`copy/es-MX.ts` `safetyInstruction`, `SAFE-FIXED-TEXT`)
//      to the installer at once, exempt from quiet hours; once per inbound message, so the agent's
//      report of a message the lexicon already caught does not repeat it; sent again only when a lost
//      invocation left it unconfirmed (a repeated instruction is acceptable, a missing one is not)
//   2. in parallel, `open_case(SAFETY)`: the `alerta_seguridad` template to the supervisor on duty and
//      the `ZONE_CHIEF_ALERT` email at the same time (`SAFE-PARALLEL`, cases/ladder.ts); a case a lost
//      invocation created without running its ladder gets it on the redelivery (cases/open.ts)
//   3. the order goes `onHoldSafety` until a supervisor closes the case (the agent guides no work on it)
//
// The model never writes the instruction. An installer with no order in progress still gets it; the
// case needs an order, so then only the instruction and the audit row remain. A report the model wrote
// (`report_safety_hazard`) reaches the case and the zone chief's email only after G2 and the fact check
// (`reportCheck`, the `SummaryCheck` of escalate_case), within `SAFETY_REPORT_CHECK_MS`: on a refusal,
// a failure or the deadline it is dropped for the fixed summary and audited `CASE_SUMMARY_REPLACED`.
// The instruction never waits on that check: it goes out in parallel with the case.
import type { HazardCategory } from "@cuadrilla/shared";
import { esMX } from "../copy/es-MX";
import type { Actor } from "../domain/common";
import type { WorkOrder } from "../domain/work-orders";
import { sha256Hex } from "../lib/crypto";
import { openCase } from "../cases/open";
import type { CaseDeps, SummaryCheck } from "../cases/ports";
import type { DecisionInput } from "../connector/ports";
import { cleanSummary, fixedSummary } from "../cases/summary";
import { withDeadline } from "../lib/deadline";
import { localDateOf } from "../services/business-hours/zoned-time";

export type SafetyDetector = "LEXICON" | "AGENT";

export interface SafetyReport {
  readonly ispId: string;
  readonly clockId: string;
  readonly installerId: string;
  /** The order of the turn or of the message; the installer's order in progress when absent. */
  readonly workOrderId?: string;
  readonly category: HazardCategory;
  readonly detectedBy: SafetyDetector;
  /** Lexicon entry that matched (`LEXICON` only). */
  readonly entryId?: string;
  readonly lexiconVersion?: string;
  /** The inbound message the hazard was reported in (one instruction per message). */
  readonly sourceMessageId?: string;
  readonly turnId?: string;
  /** What the installer reported (the agent's summary or the masked text); masked again here. */
  readonly report?: string;
  /** G2 and the fact check of a report the model wrote; without it the report is the installer's own masked text. */
  readonly reportCheck?: SummaryCheck;
  readonly atSim: string;
  readonly actor: Actor;
}

export interface SafetyOutcome {
  readonly instructionSent: boolean;
  readonly caseId?: string;
  /** A safety case of the order was already open: no new alert went out. */
  readonly existingCase: boolean;
  readonly workOrderId?: string;
}

const OPEN_STATUSES: ReadonlySet<WorkOrder["status"]> = new Set<WorkOrder["status"]>(["IN_PROGRESS", "SCHEDULED"]);

/** The open order the hazard belongs to: the one named, the installer's active one, or the one in progress today. */
async function orderOf(deps: CaseDeps, report: SafetyReport): Promise<WorkOrder | undefined> {
  const { workOrders, worlds, isps } = deps.connector;
  const named = report.workOrderId ?? (await worlds.getInstallerState(report.installerId))?.activeWorkOrderId;
  if (named !== undefined) {
    const order = await workOrders.getWorkOrder(named);
    if (order !== undefined && order.clockId === report.clockId && order.installerId === report.installerId && OPEN_STATUSES.has(order.status)) return order;
  }
  const settings = await isps.getSettings(report.ispId);
  const day = localDateOf(new Date(report.atSim), settings?.timezone ?? "America/Mexico_City");
  const orders = (await workOrders.listInstallerDay(report.installerId, day)).filter((order) => order.clockId === report.clockId && OPEN_STATUSES.has(order.status));
  return orders.find((order) => order.status === "IN_PROGRESS") ?? orders[0];
}

/** Deterministic id of the instruction for one inbound message (or one turn). */
function instructionId(report: SafetyReport): string {
  const anchor = report.sourceMessageId ?? report.turnId ?? report.atSim;
  return `safety-${sha256Hex(`${report.clockId}\n${report.installerId}\n${anchor}`).slice(0, 40)}`;
}

/**
 * The instruction under its deterministic id. A redelivered event asks again: the pipeline replays one
 * the transport confirmed and sends again one a lost invocation left unconfirmed (outbound/unconfirmed.ts),
 * so it is never skipped because it was only written `QUEUED`.
 */
async function sendInstruction(deps: CaseDeps, report: SafetyReport, workOrderId: string | undefined): Promise<boolean> {
  const messageId = instructionId(report);
  const sent = await deps.outbound.sendWhatsApp({
    clockId: report.clockId,
    ispId: report.ispId,
    personId: report.installerId,
    kind: "SAFETY_INSTRUCTION",
    author: "SYSTEM",
    atSim: report.atSim,
    form: "TEXT",
    text: esMX.safetyInstruction,
    inResponseToInbound: report.sourceMessageId !== undefined,
    messageId,
    ...(workOrderId === undefined ? {} : { workOrderId }),
    refs: { detectedBy: report.detectedBy, ...(report.sourceMessageId === undefined ? {} : { sourceMessageId: report.sourceMessageId }) },
  });
  if (sent.status === "DENIED") deps.logger.error("safety.instruction.denied", { installerId: report.installerId, deniedBy: sent.deniedBy, reason: sent.reason });
  return sent.status !== "DENIED";
}

/** The longest the case waits for the check of a model-written report before it opens with the fixed summary. */
export const SAFETY_REPORT_CHECK_MS = 4_000;

/** The masked report, or `undefined` when a model-written one did not pass its check in time (audited). */
async function checkedReport(deps: CaseDeps, report: SafetyReport, order: WorkOrder): Promise<string | undefined> {
  const masked = report.report === undefined ? undefined : cleanSummary(report.report, 300);
  if (masked === undefined || report.reportCheck === undefined) return masked;
  const check = report.reportCheck;
  const input = { ispId: report.ispId, clockId: report.clockId, workOrderId: order.workOrderId, text: masked, ...(report.turnId === undefined ? {} : { turnId: report.turnId }) };
  const outcome = await withDeadline("safety.report_check", SAFETY_REPORT_CHECK_MS, () => check.verify(input)).catch(() => ({ ok: false, reason: "UNAVAILABLE" }));
  if (outcome.ok) return masked;
  deps.logger.info("case.summary.replaced", { workOrderId: order.workOrderId, reason: outcome.reason ?? "REFUSED" });
  await deps.connector.audit.append({
    ispId: report.ispId,
    clockId: report.clockId,
    atSim: report.atSim,
    decision: "DENY",
    action: "CASE_SUMMARY_REPLACED",
    ruleIds: ["G2"],
    actor: report.actor,
    refs: { workOrderId: order.workOrderId, ...(report.turnId === undefined ? {} : { turnId: report.turnId }) },
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  return undefined;
}

async function openSafetyCase(deps: CaseDeps, report: SafetyReport, order: WorkOrder): Promise<{ caseId: string; existing: boolean }> {
  const reported = await checkedReport(deps, report, order);
  const summary = fixedSummary({ reason: "SAFETY", reasonText: esMX.hazard[report.category], workOrder: order, ...(reported === undefined ? {} : { report: reported }) });
  const opened = await openCase(deps, { workOrderId: order.workOrderId, reason: "SAFETY", summary, atSim: report.atSim, actor: report.actor, hazardCategory: report.category });
  return { caseId: opened.caseItem.caseId, existing: opened.existing };
}

/** Runs the safety response for one report; the instruction and the case go out in parallel. */
export async function handleSafety(deps: CaseDeps, report: SafetyReport): Promise<SafetyOutcome> {
  const order = await orderOf(deps, report);
  const [instructionSent, opened] = await Promise.all([
    sendInstruction(deps, report, order?.workOrderId),
    order === undefined ? Promise.resolve(undefined) : openSafetyCase(deps, report, order),
  ]);
  if (order !== undefined && !order.onHoldSafety) {
    await deps.connector.workOrders.setOnHoldSafety(order.workOrderId, true, { actor: report.actor, atSim: report.atSim, reason: `safety ${report.category}` });
  }
  // Once per message and detector: a redelivered event runs this handler again (worker/inbound.ts).
  const auditMark = { source: "AUDIT:SAFETY_DETECTED", id: `${report.detectedBy}#${instructionId(report)}` };
  if (await deps.connector.runtime.claimIdempotency(auditMark.source, auditMark.id)) {
    await deps.connector.audit.append(detectedRow(report, instructionSent, order, opened)).catch(async (error: unknown) => {
      await deps.connector.runtime.releaseIdempotency(auditMark.source, auditMark.id);
      throw error;
    });
  }
  return {
    instructionSent,
    existingCase: opened?.existing ?? false,
    ...(opened === undefined ? {} : { caseId: opened.caseId }),
    ...(order === undefined ? {} : { workOrderId: order.workOrderId }),
  };
}

/** The `SAFETY_DETECTED` audit row of one report. */
function detectedRow(report: SafetyReport, instructionSent: boolean, order: WorkOrder | undefined, opened: { readonly caseId: string } | undefined): DecisionInput {
  return {
    ispId: report.ispId,
    clockId: report.clockId,
    atSim: report.atSim,
    decision: "ACTION",
    action: "SAFETY_DETECTED",
    ruleIds: report.detectedBy === "LEXICON" ? ["SAFE-LEXICON", "SAFE-FIXED-TEXT"] : ["SAFE-AGENT", "SAFE-FIXED-TEXT"],
    actor: report.actor,
    ...(report.sourceMessageId === undefined ? {} : { messageId: report.sourceMessageId }),
    refs: {
      ...(order === undefined ? {} : { workOrderId: order.workOrderId }),
      ...(opened === undefined ? {} : { caseId: opened.caseId }),
      ...(report.turnId === undefined ? {} : { turnId: report.turnId }),
    },
    detail: {
      detectedBy: report.detectedBy,
      category: report.category,
      instructionSent,
      ...(report.entryId === undefined ? {} : { entryId: report.entryId }),
      ...(report.lexiconVersion === undefined ? {} : { lexiconVersion: report.lexiconVersion }),
      ...(order === undefined ? { noOrder: true } : {}),
    },
  };
}
