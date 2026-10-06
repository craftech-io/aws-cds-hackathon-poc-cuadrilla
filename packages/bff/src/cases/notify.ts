// How one rung of the ladder is reached (docs/design-brief.md §5.8, `LAD-NOTIFY`, `LAD-PLANB`,
// `LAD-SKIP`, `LAD-ZONE-CHIEF`). A supervisor's rung tries the case template first; when the policy
// holds the template back as not approved (`CP-TEMPLATE-APPROVED`) it tries plan B, the same body as an
// interactive message with the same buttons, which the policy only lets through inside the
// supervisor's window ("TURNO"); when neither goes out the rung is skipped with its reason. The zone
// chief's rung is an email. The ladder never guesses a channel: it reads what the policy decided.
import type { Rung } from "@cuadrilla/shared";
import { renderTemplateBody } from "../copy/templates";
import type { Case, RungSkipReason } from "../domain/cases";
import type { Person } from "../domain/people";
import type { WorkOrder } from "../domain/work-orders";
import { caseLabelOf } from "../channels/whatsapp/routing";
import type { CaseButton, CaseDeps, CaseSendOutcome, CaseWhatsAppSend } from "./ports";

/** What a rung notification needs to know about the case. */
export interface RungContext {
  readonly caseItem: Case;
  readonly workOrder: WorkOrder;
  readonly installer: Person;
  /** `caseReason` (or the hazard) in words, built by code. */
  readonly reasonText: string;
  readonly atSim: string;
  /** Position of this attempt in the ladder: part of the deterministic message ids. */
  readonly step: number;
  /** A rung before this one was notified and did not answer: the backup gets `caso_reasignado`. */
  readonly reassigned: boolean;
}

export type RungAttempt =
  | { readonly outcome: "NOTIFIED"; readonly personId: string; readonly firstName: string; readonly channel: "TEMPLATE" | "INTERACTIVE" | "EMAIL"; readonly messageId: string }
  | { readonly outcome: "SKIPPED"; readonly personId?: string; readonly reason: RungSkipReason; readonly detail?: string };

/** Deterministic id of a message of a case (a redelivered event never sends twice). */
export function caseMessageId(caseId: string, ...parts: ReadonlyArray<string | number>): string {
  return [caseId, ...parts].join("-");
}

/** The buttons of a case request, as nonces bound to the case. */
export function caseRequestButtons(caseId: string): CaseButton[] {
  return [
    { action: "TAKE_CASE", object: { kind: "CASE", id: caseId } },
    { action: "DECLINE_CASE", object: { kind: "CASE", id: caseId } },
  ];
}

/** Why a denial skips a rung: the person opted out, is off the roster, or has no channel today. */
export function skipReasonOf(outcome: Extract<CaseSendOutcome, { readonly status: "DENIED" }>): RungSkipReason {
  switch (outcome.deniedBy) {
    case "CP-OPTOUT":
      return "OPTED_OUT";
    case "CP-ROSTER":
      return "OFF_ROSTER";
    case "CP-ALLOWLIST":
      return outcome.reason === "NOT_ALLOWLISTED" ? "OFF_ROSTER" : "NO_CHANNEL";
    default:
      return "NO_CHANNEL";
  }
}

function personOfRung(caseItem: Case, rung: Rung): string | undefined {
  if (rung === "PRIMARY") return caseItem.roster.primaryId;
  if (rung === "SECONDARY") return caseItem.roster.secondaryId;
  return caseItem.roster.zoneChiefId;
}

/** The template and its parameters for a supervisor's rung. */
function requestTemplate(ctx: RungContext): { readonly kind: CaseWhatsAppSend["kind"]; readonly templateName: "caso_escalado" | "caso_reasignado" | "alerta_seguridad"; readonly params: string[] } {
  const { caseItem, workOrder, installer, reasonText } = ctx;
  if (caseItem.kind === "SAFETY") return { kind: "SAFETY_ALERT", templateName: "alerta_seguridad", params: [workOrder.workOrderNumber, installer.firstName, reasonText] };
  return {
    kind: "CASE_REQUEST",
    templateName: ctx.reassigned ? "caso_reasignado" : "caso_escalado",
    params: [caseLabelOf(caseItem.caseId), installer.firstName, workOrder.workOrderNumber, reasonText],
  };
}

async function notifySupervisor(deps: CaseDeps, ctx: RungContext, rung: Rung, person: Person): Promise<RungAttempt> {
  const { caseItem } = ctx;
  const { kind, templateName, params } = requestTemplate(ctx);
  const base = {
    clockId: caseItem.clockId,
    ispId: caseItem.ispId,
    personId: person.personId,
    kind,
    author: "SYSTEM",
    caseId: caseItem.caseId,
    workOrderId: caseItem.workOrderId,
    atSim: ctx.atSim,
    refs: { caseId: caseItem.caseId, rung },
  } as const;
  const buttons = caseRequestButtons(caseItem.caseId);
  const viaTemplate = await deps.outbound.sendWhatsApp({ ...base, form: "TEMPLATE", templateName, params, buttons, messageId: caseMessageId(caseItem.caseId, rung, ctx.step, "t") });
  if (viaTemplate.status !== "DENIED") return { outcome: "NOTIFIED", personId: person.personId, firstName: person.firstName, channel: "TEMPLATE", messageId: viaTemplate.messageId };
  if (viaTemplate.deniedBy !== "CP-TEMPLATE-APPROVED") return { outcome: "SKIPPED", personId: person.personId, reason: skipReasonOf(viaTemplate), detail: viaTemplate.deniedBy ?? "DENIED" };
  // Plan B: the same body, interactive, inside the supervisor's window.
  const text = renderTemplateBody(templateName, params);
  const viaPlanB = await deps.outbound.sendWhatsApp({ ...base, form: "INTERACTIVE", text, buttons, messageId: caseMessageId(caseItem.caseId, rung, ctx.step, "i") });
  if (viaPlanB.status !== "DENIED") return { outcome: "NOTIFIED", personId: person.personId, firstName: person.firstName, channel: "INTERACTIVE", messageId: viaPlanB.messageId };
  return { outcome: "SKIPPED", personId: person.personId, reason: skipReasonOf(viaPlanB), detail: `template not approved; plan B ${viaPlanB.deniedBy ?? "DENIED"}` };
}

/** The zone chief's email of a case; `SAFETY` is the alert sent from the start, `UNATTENDED` the last rung. */
export async function alertZoneChief(deps: CaseDeps, ctx: Omit<RungContext, "reassigned">, variant: "SAFETY" | "UNATTENDED"): Promise<RungAttempt> {
  const { caseItem } = ctx;
  const zoneChiefId = caseItem.roster.zoneChiefId;
  const zoneChief = zoneChiefId === undefined ? undefined : await deps.connector.people.getPerson(zoneChiefId);
  if (zoneChiefId === undefined || zoneChief === undefined || zoneChief.role !== "ZONE_CHIEF") return { outcome: "SKIPPED", reason: "NO_PERSON" };
  const sent = await deps.outbound.sendZoneChiefAlert({
    clockId: caseItem.clockId,
    ispId: caseItem.ispId,
    zoneChiefId,
    caseId: caseItem.caseId,
    workOrderId: caseItem.workOrderId,
    variant,
    reasonText: ctx.reasonText,
    summary: caseItem.summary,
    installerFirstName: ctx.installer.firstName,
    atSim: ctx.atSim,
    messageId: caseMessageId(caseItem.caseId, "ZONE_CHIEF", variant === "SAFETY" ? "safety" : ctx.step, "e"),
  });
  if (sent.status === "DENIED") return { outcome: "SKIPPED", personId: zoneChiefId, reason: skipReasonOf(sent), detail: sent.deniedBy ?? "DENIED" };
  return { outcome: "NOTIFIED", personId: zoneChiefId, firstName: zoneChief.firstName, channel: "EMAIL", messageId: sent.messageId };
}

/** Tries to reach the person of `rung`; never throws for a missing person or a closed channel. */
export async function notifyRung(deps: CaseDeps, ctx: RungContext, rung: Rung): Promise<RungAttempt> {
  if (rung === "ZONE_CHIEF") return alertZoneChief(deps, ctx, "UNATTENDED");
  const personId = personOfRung(ctx.caseItem, rung);
  if (personId === undefined) return { outcome: "SKIPPED", reason: "NO_PERSON" };
  const person = await deps.connector.people.getPerson(personId);
  if (person === undefined || person.role !== "SUPERVISOR" || person.clockId !== ctx.caseItem.clockId) return { outcome: "SKIPPED", personId, reason: "NO_PERSON" };
  return notifySupervisor(deps, ctx, rung, person);
}

/** A `CASE_NOTICE` to the installer of the case (text of copy/es-MX.ts). */
export async function noticeInstaller(deps: CaseDeps, caseItem: Case, text: string, atSim: string, tag: string): Promise<CaseSendOutcome> {
  return deps.outbound.sendWhatsApp({
    clockId: caseItem.clockId,
    ispId: caseItem.ispId,
    personId: caseItem.installerId,
    kind: "CASE_NOTICE",
    author: "SYSTEM",
    caseId: caseItem.caseId,
    workOrderId: caseItem.workOrderId,
    atSim,
    form: "TEXT",
    text,
    messageId: caseMessageId(caseItem.caseId, "notice", tag),
    refs: { caseId: caseItem.caseId },
  });
}
