// The cases side of ports other modules declared, so they open cases and close orders through the same
// code as the tools:
//
//   WorkOrderActions (channels/whatsapp/ports.ts)   the InstallerWorker's `BUTTON_ACTION`s: "Consultar a
//                                                   mi supervisor" opens `OUT_OF_MANUAL` with a summary
//                                                   built by code (FL-031); "Cerrar instalación" runs
//                                                   `close_installation` with `caller CHANNEL` (FL-047,
//                                                   FL-050). "Cliente conforme" is services/' own.
//   NotProvisionedCases (agent-tools/orders)        the second `NOT_PROVISIONED` reading in a row (FL-022)
//   PhotoAttemptsCasePort (evidence/ports.ts)       the third rejected photo of an item (FL-042)
import { ChecklistItem } from "@cuadrilla/shared";
import { esMX } from "../../copy/es-MX";
import type { CloseOutcome, WorkOrderActions } from "../../channels/whatsapp/ports";
import { openCase } from "../../cases/open";
import type { CaseDeps } from "../../cases/ports";
import { cleanSummary, fixedSummary } from "../../cases/summary";
import type { PhotoAttemptsCasePort } from "../../evidence/ports";
import type { ToolHandler } from "../common/handler";
import type { NotProvisionedCases } from "../orders/context";

/** Longest question a consult summary quotes. */
const QUESTION_MAX = 300;

export type CaseButtonActions = Pick<WorkOrderActions, "openConsultCase" | "closeInstallation">;

/** The two buttons of an installer that belong to cases, for the InstallerWorker. */
export function caseButtonActions(deps: CaseDeps, casesTools: Pick<ToolHandler, "invoke">): CaseButtonActions {
  return {
    async openConsultCase(input) {
      const workOrder = await deps.connector.workOrders.requireWorkOrder(input.workOrderId);
      const summary = fixedSummary({
        reason: "OUT_OF_MANUAL",
        reasonText: esMX.caseReason({ reason: "OUT_OF_MANUAL" }),
        workOrder,
        citations: input.citations,
        ...(input.question === undefined ? {} : { question: cleanSummary(input.question, QUESTION_MAX) }),
      });
      await openCase(deps, { workOrderId: workOrder.workOrderId, reason: "OUT_OF_MANUAL", summary, atSim: input.atSim, actor: "CHANNEL" });
    },
    async closeInstallation(input): Promise<CloseOutcome> {
      const response = await casesTools.invoke(
        "close_installation",
        { caller: { kind: "CHANNEL", ispId: input.ispId, clockId: input.clockId, eventId: input.eventId }, outcome: "INSTALLED" },
        { subject: { installerId: input.personId, workOrderId: input.workOrderId }, correlationId: input.eventId },
      );
      if (response.ok) return { ok: true };
      if (response.error.code !== "NOT_COMPLETE") return { ok: false, code: "FAILED" };
      const missing = ChecklistItem.array().safeParse(response.missing);
      return { ok: false, code: "NOT_COMPLETE", missing: missing.success ? missing.data : [] };
    },
  };
}

/** `open_case(NOT_PROVISIONED)` for `get_onu_status`, idempotent by order and reason. */
export function notProvisionedCases(deps: CaseDeps): NotProvisionedCases {
  return {
    async open(request) {
      const workOrder = await deps.connector.workOrders.requireWorkOrder(request.workOrderId);
      const summary = fixedSummary({ reason: "NOT_PROVISIONED", reasonText: esMX.caseReason({ reason: "NOT_PROVISIONED" }), workOrder });
      const opened = await openCase(deps, { workOrderId: workOrder.workOrderId, reason: "NOT_PROVISIONED", summary, atSim: request.atSim, actor: request.actor });
      return { caseId: opened.caseItem.caseId, reason: opened.caseItem.reason };
    },
  };
}

/** `open_case(PHOTO_ATTEMPTS)` for the validator, idempotent by order and reason, with the rejected photos first. */
export function photoAttemptsCases(deps: CaseDeps): PhotoAttemptsCasePort {
  return {
    async openPhotoAttemptsCase(request) {
      const workOrder = await deps.connector.workOrders.requireWorkOrder(request.workOrderId);
      const summary = fixedSummary({ reason: "PHOTO_ATTEMPTS", reasonText: esMX.caseReason({ reason: "PHOTO_ATTEMPTS", item: request.item }), workOrder });
      const opened = await openCase(deps, { workOrderId: workOrder.workOrderId, reason: "PHOTO_ATTEMPTS", summary, atSim: request.atSim, actor: "SYSTEM", evidenceIds: request.evidenceIds });
      return { caseId: opened.caseItem.caseId, reason: "PHOTO_ATTEMPTS" };
    },
  };
}
