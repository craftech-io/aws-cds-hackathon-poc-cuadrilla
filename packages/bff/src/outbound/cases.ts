// The pipeline as the cases module sees it (cases/ports.ts: `CaseOutbound`, `SummaryCheck`): every
// message of a case (the ladder's templates and plan B, the brief, the notices, the bridge) and the
// zone chief's email leave through `sendOutbound`, so the contact policy decides and the audit records
// them; the ladder reads the decision back (`deniedBy`) to choose plan B or skip a rung. The zone
// chief's email is rendered here with copy/es-MX-documents.ts and the stage's brand, with the console
// link of the case as its only URL. A summary the agent wrote passes G2 and the fact check first.
import { ToolError } from "@cuadrilla/shared";
import { zoneChiefSafetyAlert, zoneChiefUnattendedCase } from "../copy/es-MX-documents";
import type { CaseOutbound, CaseSendOutcome, CaseWhatsAppSend, SummaryCheck, SummaryCheckInput, ZoneChiefAlertSend } from "../cases/ports";
import type { Logger } from "../lib/log";
import { consoleCaseUrl } from "../policy/rules-content";
import { zonedParts } from "../services/business-hours/zoned-time";
import { checkText } from "./checks";
import type { OutboundDeps } from "./deps";
import { sendOutbound } from "./pipeline";
import type { OutboundCall, OutboundResult, WhatsAppSendInput } from "./types";

const BUCKET = { EVIDENCE: "Evidence", MEDIA: "Media" } as const;

function outcomeOf(result: OutboundResult): CaseSendOutcome {
  if (result.status === "SENT") return { status: "SENT", messageId: result.messageId };
  if (result.status === "DEFERRED") return { status: "DEFERRED", messageId: result.messageId, nextAllowedAt: result.nextAllowedAt };
  return {
    status: "DENIED",
    ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
    ...(result.decision?.deniedBy === undefined ? {} : { deniedBy: result.decision.deniedBy }),
    reason: result.decision?.reason ?? result.failure.error.reason ?? result.failure.error.code,
  };
}

function whatsAppInput(request: CaseWhatsAppSend): WhatsAppSendInput {
  const base = {
    channel: "WHATSAPP" as const,
    personId: request.personId,
    kind: request.kind,
    author: request.author,
    eventAtSim: request.atSim,
    messageId: request.messageId,
    ...(request.caseId === undefined ? {} : { caseId: request.caseId }),
    ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }),
    ...(request.notice === undefined ? {} : { notice: request.notice }),
    ...(request.inResponseToInbound === undefined ? {} : { inResponseToInbound: request.inResponseToInbound }),
    ...(request.refs === undefined ? {} : { refs: request.refs }),
  };
  switch (request.form) {
    case "TEXT":
      return { ...base, text: request.text };
    case "INTERACTIVE":
      return { ...base, text: request.text, buttons: request.buttons.map((button) => ({ action: button.action, object: button.object })) };
    case "TEMPLATE":
      return { ...base, template: { name: request.templateName, params: [...request.params], buttonObjects: request.buttons.map((button) => button.object) } };
    case "IMAGE":
      return { ...base, image: { media: { bucket: BUCKET[request.media.bucket], key: request.media.s3Key }, ...(request.caption === undefined ? {} : { caption: request.caption }) } };
  }
}

/** "13/10 15:10" in the world's zone. */
function atTextOf(atSim: string, timeZone: string): string {
  const parts = zonedParts(new Date(Date.parse(atSim)), timeZone);
  return `${parts.date.slice(8, 10)}/${parts.date.slice(5, 7)} ${parts.time}`;
}

async function renderZoneChiefAlert(deps: OutboundDeps, request: ZoneChiefAlertSend): Promise<{ readonly subject: string; readonly body: string }> {
  const { connector } = deps;
  const [workOrder, chief, settings] = await Promise.all([connector.workOrders.getWorkOrder(request.workOrderId), connector.people.getPerson(request.zoneChiefId), connector.isps.getSettings(request.ispId)]);
  if (workOrder === undefined || chief === undefined || settings === undefined) throw new ToolError("NOT_FOUND", "the order, the zone chief or the world of the alert is missing", "NO_RECIPIENT");
  const zone = workOrder.zoneId === undefined ? undefined : await connector.isps.getZone(request.ispId, workOrder.zoneId);
  const input = {
    brand: deps.brand(),
    workOrderNumber: workOrder.workOrderNumber,
    zoneName: zone?.name ?? workOrder.zoneId ?? "",
    zoneChiefFirstName: chief.firstName,
    installerFirstName: request.installerFirstName,
    reasonText: request.reasonText,
    summary: request.summary,
    caseUrl: consoleCaseUrl(request.caseId),
    atText: atTextOf(request.atSim, settings.timezone),
  };
  return request.variant === "SAFETY" ? zoneChiefSafetyAlert(input) : zoneChiefUnattendedCase(input);
}

export function createCaseOutbound(deps: OutboundDeps, logger: Logger): CaseOutbound {
  const call = (correlationId: string): OutboundCall => ({ actor: "WORKER", correlationId, log: logger });
  return {
    async sendWhatsApp(request) {
      return outcomeOf(await sendOutbound(deps, whatsAppInput(request), call(request.messageId)));
    },
    async sendZoneChiefAlert(request) {
      const { subject, body } = await renderZoneChiefAlert(deps, request);
      const result = await sendOutbound(
        deps,
        {
          channel: "EMAIL",
          kind: "ZONE_CHIEF_ALERT",
          toRole: "ZONE_CHIEF",
          author: "SYSTEM",
          workOrderId: request.workOrderId,
          caseId: request.caseId,
          zoneChiefId: request.zoneChiefId,
          eventAtSim: request.atSim,
          subject,
          text: body,
          messageId: request.messageId,
        },
        call(request.messageId),
      );
      return outcomeOf(result);
    },
  };
}

/** G2 and the deterministic fact check over a summary the agent wrote (`escalate_case`). */
export function createSummaryCheck(deps: OutboundDeps, logger: Logger): SummaryCheck {
  return {
    async verify(input: SummaryCheckInput) {
      const results = input.turnId === undefined ? [] : await deps.connector.runtime.listTurnResults(input.turnId);
      const outcome = await checkText(deps, { kind: "CASE_BRIEF", source: "MODEL", text: input.text, results });
      if (outcome.ok) return { ok: true };
      logger.warn("outbound.summary_refused", { workOrderId: input.workOrderId, checks: outcome.failures.map((failure) => failure.check), ...(outcome.g2 === undefined ? {} : { ...outcome.g2 }) });
      return { ok: false, reason: outcome.unavailable === true ? "UNAVAILABLE" : (outcome.g2?.reason ?? outcome.failures[0]?.check ?? "GROUNDING_FAIL") };
    },
  };
}
