// Enums every edge shares: the "Tipos compartidos" of docs/tool-catalog.md, in the order the catalog
// writes them, plus the closed sets of docs/architecture.md that more than one package reads (the
// console, the BFF, the mocks, the seed and the scenario runner). `enums.test.ts` compares each one
// with the document it comes from, so a change on either side fails a test instead of drifting.
import { z } from "zod";

// ---- Channels and errors ------------------------------------------------------------------------

/** Channels the product writes on (docs/architecture-integrations.md): WhatsApp and SES outbound. */
export const SendChannel = z.enum(["EMAIL", "WHATSAPP"]);
export type SendChannel = z.infer<typeof SendChannel>;

/** Transport a WhatsApp message takes (ADR-0002, infra/channel-modes.ts); email is always live. */
export const WhatsAppTransport = z.enum(["live", "simulated"]);
export type WhatsAppTransport = z.infer<typeof WhatsAppTransport>;

/** Key of a channel in `ChannelModes` (infra/channel-modes.ts). */
export const ChannelName = z.enum(["email", "whatsapp"]);
export type ChannelName = z.infer<typeof ChannelName>;

export function channelNameOf(channel: SendChannel): ChannelName {
  return channel === "EMAIL" ? "email" : "whatsapp";
}

/** `code` of every tool failure (docs/tool-catalog.md, Convenciones). */
export const ErrorCode = z.enum([
  "NOT_FOUND",
  "FORBIDDEN",
  "INVALID",
  "CONFLICT",
  "UNAVAILABLE",
  "POLICY_DENIED",
  "DEFERRED",
  "BRIDGE_ACTIVE",
  "TEMPLATE_REQUIRED",
  "RECIPIENT_NOT_ALLOWED",
  "GROUNDING_FAIL",
  "NOT_COMPLETE",
  "ON_HOLD_SAFETY",
  "CAP_REACHED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Console roles, in precedence order (docs/architecture.md §10). */
export const ConsoleRole = z.enum(["SUPERVISOR", "GUEST", "OPS"]);
export type ConsoleRole = z.infer<typeof ConsoleRole>;

export const Weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
export type Weekday = z.infer<typeof Weekday>;

// ---- Tipos compartidos (docs/tool-catalog.md) ---------------------------------------------------

export const WorkOrderStatus = z.enum(["SCHEDULED", "IN_PROGRESS", "CLOSED", "FAILED_VISIT", "RESCHEDULED", "CANCELLED", "REASSIGNED"]);
export type WorkOrderStatus = z.infer<typeof WorkOrderStatus>;

/** Items of the closing checklist (manual §EVI-01), in the order the checklist shows them. */
export const ChecklistItem = z.enum(["ONU_ONLINE", "POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "CUSTOMER_OK"]);
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export const ChecklistItemStatus = z.enum(["PENDING", "IN_REVIEW", "PASSED", "REJECTED", "OVERRIDDEN"]);
export type ChecklistItemStatus = z.infer<typeof ChecklistItemStatus>;

export const OnuOperState = z.enum(["ONLINE", "OFFLINE", "LOS", "DYING_GASP", "NOT_PROVISIONED"]);
export type OnuOperState = z.infer<typeof OnuOperState>;

export const OpticalClass = z.enum(["B+", "C+"]);
export type OpticalClass = z.infer<typeof OpticalClass>;

export const Verdict = z.enum(["PASS", "REJECT", "UNSURE"]);
export type Verdict = z.infer<typeof Verdict>;

export const RejectReason = z.enum([
  "BLURRY",
  "GLARE",
  "CROPPED",
  "DARK",
  "WRONG_SUBJECT",
  "OUT_OF_RANGE_LOW",
  "OUT_OF_RANGE_HIGH",
  "WRONG_WAVELENGTH",
  "SERIAL_MISMATCH",
  "READING_MISMATCH",
  "DUPLICATE_EVIDENCE",
  "UNREADABLE",
]);
export type RejectReason = z.infer<typeof RejectReason>;

export const Symptom = z.enum(["NO_PON_LIGHT", "LOW_POWER", "NO_POWER", "NOT_PROVISIONED", "NO_BROWSING", "OTHER"]);
export type Symptom = z.infer<typeof Symptom>;

export const StepOutcome = z.enum(["PENDING", "FIXED", "NO_CHANGE", "WORSE"]);
export type StepOutcome = z.infer<typeof StepOutcome>;

export const CaseKind = z.enum(["ESCALATION", "SAFETY"]);
export type CaseKind = z.infer<typeof CaseKind>;

export const CaseReason = z.enum([
  "OUT_OF_MANUAL",
  "DIAGNOSIS_ATTEMPTS",
  "PHOTO_ATTEMPTS",
  "INSTALLER_ASKED",
  "NOT_PROVISIONED",
  "DENIED_TOPIC",
  "PROMPT_INJECTION",
  "SAFETY",
  "CERTIFICATE_UNDELIVERED",
  "OTHER",
]);
export type CaseReason = z.infer<typeof CaseReason>;

export const CaseStatus = z.enum(["OPEN", "TAKEN", "CLOSED"]);
export type CaseStatus = z.infer<typeof CaseStatus>;

/** Rungs of the escalation ladder, in the order a case climbs them (docs/design-brief.md §5.8). */
export const Rung = z.enum(["PRIMARY", "SECONDARY", "ZONE_CHIEF"]);
export type Rung = z.infer<typeof Rung>;

export const RungOutcome = z.enum(["NOTIFIED", "SKIPPED", "TIMED_OUT", "DECLINED", "TAKEN"]);
export type RungOutcome = z.infer<typeof RungOutcome>;

export const HazardCategory = z.enum(["ELECTRICAL", "POLE", "HEIGHT", "WEATHER", "ANIMAL", "THREAT", "OTHER"]);
export type HazardCategory = z.infer<typeof HazardCategory>;

export const MessageKind = z.enum([
  "DAY_START",
  "ORDERS_DETAIL",
  "REPLY",
  "SYSTEM_NOTICE",
  "ORDER_CHOICE",
  "SAFETY_INSTRUCTION",
  "CASE_NOTICE",
  "CASE_REQUEST",
  "SAFETY_ALERT",
  "CASE_BRIEF",
  "CASE_TAKEN_NOTICE",
  "RELAY",
  "SUPERVISOR_REPLY_TEMPLATE",
  "CERTIFICATE",
  "CERTIFICATE_EMAIL",
  "ZONE_CHIEF_ALERT",
  "READ_ACK",
  "VERDICT_REACTION",
]);
export type MessageKind = z.infer<typeof MessageKind>;

/** WhatsApp mode of a world (`Isps/SETTINGS.whatsappMode`, ADR-0002); `live` only for the live world. */
export const WhatsAppMode = z.enum(["simulated", "live"]);
export type WhatsAppMode = z.infer<typeof WhatsAppMode>;

/**
 * Scopes of the runtime kill switch `Runtime/KILL#<scope>` (ADR-0019): `SIGNUP` cuts only the own
 * sign-up (ADR-0025 §4); `ALL` stays above every other scope.
 */
export const KillScope = z.enum(["ALL", "SIMULATOR", "AGENT", "SIGNUP"]);
export type KillScope = z.infer<typeof KillScope>;

/** `BrandConfig.mode` (ADR-0018): the fictitious operator or co-branding with the design partner. */
export const BrandMode = z.enum(["neutral", "cobrand"]);
export type BrandMode = z.infer<typeof BrandMode>;

export const WaButtonAction = z.enum([
  "VIEW_ORDERS",
  "TAKE_CASE",
  "DECLINE_CASE",
  "CLOSE_CASE",
  "VIEW_REPLY",
  "CHOOSE_ORDER",
  "CHOOSE_CASE",
  "CHOOSE_ITEM",
  "CONSULT_SUPERVISOR",
  "NO_THANKS",
  "CUSTOMER_OK",
  "CLOSE_INSTALLATION",
]);
export type WaButtonAction = z.infer<typeof WaButtonAction>;

export const TurnTrigger = z.enum(["INSTALLER_MESSAGE", "ORDERS_REQUESTED", "CASE_CLOSED", "WORK_ORDER_CHANGED", "EVIDENCE_OVERRIDDEN"]);
export type TurnTrigger = z.infer<typeof TurnTrigger>;

export const TimerKind = z.enum(["DAY_START", "CASE_TIMEOUT", "DEFERRED_SEND", "CERT_RETRY"]);
export type TimerKind = z.infer<typeof TimerKind>;

/** Mode of a world's demo clock (ADR-0010): paused by default, real time with an offset for 30 min. */
export const ClockMode = z.enum(["RUNNING", "PAUSED"]);
export type ClockMode = z.infer<typeof ClockMode>;

// ---- Closed sets of docs/architecture.md that cross packages ------------------------------------

/** `Isp.kind` (docs/architecture.md §5): the operator of the demo, a guest's copy, a QA or an evaluation world. */
export const IspKind = z.enum(["DEMO", "GUEST", "QA", "EVAL"]);
export type IspKind = z.infer<typeof IspKind>;

/**
 * How a `GUEST` account was born (ADR-0024): invited by the operator (`guest-NN`), the operator's
 * rehearsal and the `QaDriver` (`TEST`), or the own sign-up with a verified email (`SIGNUP`, ADR-0025).
 * The origin changes only the account's birth, the world's lifecycle and its caps, never what it may do.
 */
export const GuestOrigin = z.enum(["INVITED", "TEST", "SIGNUP"]);
export type GuestOrigin = z.infer<typeof GuestOrigin>;

/**
 * State of a guest's world (`Runtime/GUESTACCOUNT#<userId>.status`, ADR-0025 §2-§3): being built, ready,
 * failed (retryable), without room under the cap of active sign-up worlds (retryable), or never to have
 * one: a third confirmed account of a person who already holds the two of ADR-0025 §3 (not retryable).
 */
export const GuestWorldStatus = z.enum(["PROVISIONING", "READY", "FAILED", "CAP_FULL", "PERSON_LIMIT"]);
export type GuestWorldStatus = z.infer<typeof GuestWorldStatus>;

/** People of an operator by role (`People` GSI2 `ispKindKey`, docs/architecture.md §5). */
export const PersonRole = z.enum(["INSTALLER", "SUPERVISOR", "ZONE_CHIEF", "CUSTOMER"]);
export type PersonRole = z.infer<typeof PersonRole>;

/** `AuditLog` decisions (docs/architecture.md §5). */
export const AuditDecision = z.enum(["ALLOW", "DENY", "DEFER", "ACTION", "VIOLATION"]);
export type AuditDecision = z.infer<typeof AuditDecision>;

/** The six `UTILITY` templates in `es_MX` (docs/architecture-integrations.md §4.5). */
export const TemplateName = z.enum(["ordenes_del_dia", "caso_escalado", "caso_reasignado", "alerta_seguridad", "respuesta_supervisor", "acta_instalacion"]);
export type TemplateName = z.infer<typeof TemplateName>;

/** Simulated state of a template in a world (`IspSettings.templateStatus`, docs/architecture.md §5). */
export const TemplateStatus = z.enum(["APPROVED", "PENDING", "REJECTED"]);
export type TemplateStatus = z.infer<typeof TemplateStatus>;

/** State of a `TIMER#` item and who fired it (docs/architecture.md §8). */
export const TimerStatus = z.enum(["SCHEDULED", "FIRED", "SKIPPED", "CANCELLED"]);
export type TimerStatus = z.infer<typeof TimerStatus>;

export const TimerFiredBy = z.enum(["SCHEDULER", "CLOCK", "MANUAL"]);
export type TimerFiredBy = z.infer<typeof TimerFiredBy>;

/** Categories of the manual, the prefix of every section id (`COM-04`; `search_procedures.category`). */
export const ManualCategory = z.enum(["GEN", "SEG", "INS", "MED", "DIAG", "EVI", "COM", "ESC", "CAL"]);
export type ManualCategory = z.infer<typeof ManualCategory>;

/** Checklist items proved by a photo: the ones `validate_install_photo` accepts. */
export const PhotoItem = ChecklistItem.extract(["POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO"]);
export type PhotoItem = z.infer<typeof PhotoItem>;
