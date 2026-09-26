// SES events of the configuration set, delivered by EventBridge (docs/architecture-integrations.md §2):
// `Send`, `Delivery`, `Bounce`, `Complaint`, `Reject`, `DeliveryDelay` and `Rendering Failure`; no
// `Open` nor `Click`. Three steps, all pure but the last:
//
//   parse     zod over the event; only events of our configuration set that carry our `EmailTags`
//             (another app's event, or a type we do not track, is ignored, never an error);
//   state     the outbox status it moves the email to, never backwards (a late `Send` after a
//             `Delivery` changes nothing; a `Complaint` after a `Delivery` does), and the effect the
//             worker applies once, when the status actually changed:
//
//               Delivery                     DELIVERED   alert: ALERT_DELIVERED (SafetyAlertLatency)
//               Bounce Transient, Delay      DELAYED     certificate: SCHEDULE_CERT_RETRY (+5 min, once)
//               Bounce Permanent, Complaint  BOUNCED /   certificate: CERTIFICATE_UNDELIVERED (a case in
//                                            COMPLAINED  the console only); alert: ALERT_UNDELIVERED;
//                                                        the address never receives again (outbound.ts)
//               Reject, Rendering Failure    FAILED      ALARM
//
//   apply     the outbox row gets the status and the event; the first event about the recipient
//             (anything but `Send`) closes `Runtime/PENDING#<clockId>` · `MAIL#<mailId>`.
import { z } from "zod";
import { IspId, WorkOrderId, clockIdOfIsp } from "@cuadrilla/shared";
import type { ConversationsPort, WorldRuntimePort } from "../../connector/ports-runtime";
import { EmailKind, type EmailEventType, type EmailStatus, type OutboundEmail } from "../../domain/conversations";
import type { DeliveryStatus } from "../../domain/work-orders";
import { MailId } from "./request";

const Stamp = z.string().max(64).optional();

const SesDetail = z.object({
  eventType: z.string().max(64),
  mail: z.object({
    timestamp: Stamp,
    messageId: z.string().min(1).max(256),
    tags: z.record(z.string(), z.array(z.string())).default({}),
  }),
  delivery: z.object({ timestamp: Stamp }).optional(),
  bounce: z.object({ bounceType: z.string().max(32), bounceSubType: z.string().max(64).optional(), timestamp: Stamp }).optional(),
  complaint: z.object({ timestamp: Stamp, complaintFeedbackType: z.string().max(64).optional() }).optional(),
  reject: z.object({ reason: z.string().max(200).optional() }).optional(),
  deliveryDelay: z.object({ timestamp: Stamp, delayType: z.string().max(64).optional() }).optional(),
  failure: z.object({ errorMessage: z.string().max(2000).optional() }).optional(),
});

export const SesEventBridgeEvent = z.object({ source: z.literal("aws.ses"), "detail-type": z.string().max(64), time: z.string().max(64), detail: SesDetail });
export type SesEventBridgeEvent = z.infer<typeof SesEventBridgeEvent>;

const TRACKED: Readonly<Record<string, EmailEventType>> = {
  Send: "SEND",
  Delivery: "DELIVERY",
  Bounce: "BOUNCE",
  Complaint: "COMPLAINT",
  Reject: "REJECT",
  DeliveryDelay: "DELIVERY_DELAY",
  "Rendering Failure": "RENDERING_FAILURE",
  RenderingFailure: "RENDERING_FAILURE",
};

export const BounceType = z.enum(["Permanent", "Transient", "Undetermined"]);
export type BounceType = z.infer<typeof BounceType>;

/** One SES event about one of our emails, from its tags. */
export interface EmailEventRecord {
  readonly type: EmailEventType;
  readonly providerMessageId: string;
  readonly atReal: string;
  readonly bounceType?: BounceType;
  readonly ispId: string;
  readonly clockId: string;
  readonly mailId: string;
  readonly kind: EmailKind;
  /** Routes `EMAIL_EVENT` to the queue of the order's installer. */
  readonly workOrderId?: string;
  /** Bounce subtype, delay type or reject reason (no address, no content). */
  readonly detail?: string;
}

export type EmailEventParse = { readonly ok: true; readonly record: EmailEventRecord } | { readonly ok: false; readonly ignored: "MALFORMED" | "UNTRACKED_TYPE" | "FOREIGN_CONFIGURATION_SET" | "FOREIGN_TAGS" };

const OurTags = z.object({ ispId: IspId, mailId: MailId, kind: EmailKind, workOrderId: WorkOrderId.optional() });

function instantOf(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const ms = candidate === undefined ? Number.NaN : Date.parse(candidate);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return undefined;
}

function detailOf(detail: z.infer<typeof SesDetail>): string | undefined {
  const value = detail.bounce?.bounceSubType ?? detail.deliveryDelay?.delayType ?? detail.complaint?.complaintFeedbackType ?? detail.reject?.reason;
  return value?.slice(0, 200);
}

/** Only events of `configurationSetName` with our tags become records; nothing here throws. */
export function parseSesEvent(event: unknown, configurationSetName: string): EmailEventParse {
  const parsed = SesEventBridgeEvent.safeParse(event);
  if (!parsed.success) return { ok: false, ignored: "MALFORMED" };
  const { detail, time } = parsed.data;
  const type = TRACKED[detail.eventType];
  if (type === undefined) return { ok: false, ignored: "UNTRACKED_TYPE" };
  const tags = detail.mail.tags;
  if (tags["ses:configuration-set"]?.[0] !== configurationSetName) return { ok: false, ignored: "FOREIGN_CONFIGURATION_SET" };
  const ours = OurTags.safeParse({ ispId: tags.ispId?.[0], mailId: tags.mailId?.[0], kind: tags.kind?.[0], workOrderId: tags.workOrderId?.[0] });
  if (!ours.success) return { ok: false, ignored: "FOREIGN_TAGS" };
  const bounceType = detail.bounce === undefined ? undefined : BounceType.catch("Undetermined").parse(detail.bounce.bounceType);
  const atReal = instantOf(detail.delivery?.timestamp, detail.bounce?.timestamp, detail.complaint?.timestamp, detail.deliveryDelay?.timestamp, time) ?? new Date(0).toISOString();
  const extra = detailOf(detail);
  return {
    ok: true,
    record: {
      type,
      providerMessageId: detail.mail.messageId,
      atReal,
      ...(bounceType === undefined ? {} : { bounceType }),
      ispId: ours.data.ispId,
      clockId: clockIdOfIsp(ours.data.ispId),
      mailId: ours.data.mailId,
      kind: ours.data.kind,
      ...(ours.data.workOrderId === undefined ? {} : { workOrderId: ours.data.workOrderId }),
      ...(extra === undefined ? {} : { detail: extra }),
    },
  };
}

// ---- State ---------------------------------------------------------------------------------------

/** The status an event says the email reached. */
export function statusOfEvent(type: EmailEventType, bounceType?: BounceType): EmailStatus {
  switch (type) {
    case "SEND":
      return "SENT";
    case "DELIVERY":
      return "DELIVERED";
    case "BOUNCE":
      return bounceType === "Permanent" ? "BOUNCED" : "DELAYED";
    case "DELIVERY_DELAY":
      return "DELAYED";
    case "COMPLAINT":
      return "COMPLAINED";
    case "REJECT":
    case "RENDERING_FAILURE":
      return "FAILED";
  }
}

const RANK: Readonly<Record<EmailStatus, number>> = { QUEUED: 0, SENT: 1, DELAYED: 2, DELIVERED: 3, BOUNCED: 4, COMPLAINED: 4, FAILED: 4, DENIED: 4 };

/** Statuses only move forward; outcomes (bounce, complaint, failure) are final. */
export function nextStatus(current: EmailStatus, incoming: EmailStatus): EmailStatus {
  return RANK[incoming] > RANK[current] ? incoming : current;
}

export type EmailEventEffect = "NONE" | "ALERT_DELIVERED" | "SCHEDULE_CERT_RETRY" | "CERTIFICATE_UNDELIVERED" | "ALERT_UNDELIVERED" | "ALARM";

/** What the worker does after the status changed to `status` (`apply_email_event`). */
export function effectOf(kind: EmailKind, status: EmailStatus): EmailEventEffect {
  const certificate = kind === "CERTIFICATE_EMAIL";
  switch (status) {
    case "DELIVERED":
      return certificate ? "NONE" : "ALERT_DELIVERED";
    case "DELAYED":
      return certificate ? "SCHEDULE_CERT_RETRY" : "NONE";
    case "BOUNCED":
    case "COMPLAINED":
      return certificate ? "CERTIFICATE_UNDELIVERED" : "ALERT_UNDELIVERED";
    case "FAILED":
      return "ALARM";
    default:
      return "NONE";
  }
}

// ---- Apply ---------------------------------------------------------------------------------------

export type EmailEventOutcome =
  | { readonly applied: false; readonly reason: "UNKNOWN_MAIL" | "OTHER_MESSAGE" }
  | {
      readonly applied: true;
      readonly mail: OutboundEmail;
      readonly previous: EmailStatus;
      readonly status: EmailStatus;
      readonly changed: boolean;
      readonly effect: EmailEventEffect;
      /** `Certificate.deliveries[…].status` of a certificate email. */
      readonly deliveryStatus: DeliveryStatus;
      /** From the send to the delivery, real time (a delivered alert: `SafetyAlertLatency`). */
      readonly deliveryLatencyMs?: number;
    };

/** Moves the outbox row and closes the world's pending mark; the caller applies `effect`. */
export async function applyEmailEvent(deps: { readonly conversations: ConversationsPort; readonly worlds: Pick<WorldRuntimePort, "closePendingMail"> }, record: EmailEventRecord): Promise<EmailEventOutcome> {
  const mail = await deps.conversations.findMail(record.ispId, record.mailId);
  if (mail === undefined) return { applied: false, reason: "UNKNOWN_MAIL" };
  if (mail.providerMessageId !== undefined && mail.providerMessageId !== record.providerMessageId) return { applied: false, reason: "OTHER_MESSAGE" };
  const status = nextStatus(mail.status, statusOfEvent(record.type, record.bounceType));
  const changed = status !== mail.status;
  const updated = await deps.conversations.updateMail(
    { ispId: mail.ispId, sentAtSim: mail.sentAtSim, mailId: mail.mailId },
    { ...(changed ? { status } : {}), ...(mail.providerMessageId === undefined ? { providerMessageId: record.providerMessageId } : {}), event: { type: record.type, atReal: record.atReal, ...(record.detail === undefined ? {} : { detail: record.detail }) } },
  );
  if (record.type !== "SEND") await deps.worlds.closePendingMail(mail.clockId, mail.mailId, record.type);
  const effect = changed ? effectOf(mail.kind, status) : "NONE";
  const latency = status === "DELIVERED" && changed ? Date.parse(record.atReal) - Date.parse(mail.sentAtReal) : undefined;
  return { applied: true, mail: updated, previous: mail.status, status, changed, effect, deliveryStatus: status, ...(latency === undefined || latency < 0 ? {} : { deliveryLatencyMs: latency }) };
}
