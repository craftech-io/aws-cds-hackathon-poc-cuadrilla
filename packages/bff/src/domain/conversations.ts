// `Conversations` table (docs/architecture.md §5): the WhatsApp thread of each person (messages in
// and out, their status events and the internal note of each agent turn) and the operator's outbox
// of every email sent, as it left. Inbound text is masked by the normalizer before it gets here.
import { z } from "zod";
import {
  AuditDecision,
  CaseId,
  ClockId,
  IsoInstant,
  IspId,
  MessageKind,
  PersonId,
  RuleId,
  TemplateName,
  TurnTrigger,
  WaButtonAction,
  WhatsAppTransport,
  WorkOrderId,
} from "@cuadrilla/shared";
import { EmailAddress, JsonObject, S3Key, Sha256Hex, TokenUsage, defineEntity } from "./common";

export const MessageDirection = z.enum(["IN", "OUT"]);
export type MessageDirection = z.infer<typeof MessageDirection>;

/** What a WhatsApp message carries, in either direction. */
export const MessageContent = z.enum(["TEXT", "VOICE", "IMAGE", "DOCUMENT", "BUTTON", "INTERACTIVE", "TEMPLATE", "REACTION", "READ_ACK", "STICKER", "OTHER"]);
export type MessageContent = z.infer<typeof MessageContent>;

export const MessageStatus = z.enum(["RECEIVED", "QUEUED", "SENT", "DELIVERED", "READ", "FAILED", "DEFERRED", "DENIED"]);
export type MessageStatus = z.infer<typeof MessageStatus>;

/** `AGENT` (through `send_whatsapp`), `SYSTEM` (fixed texts, ladder, bridge) or the person who wrote. */
export const MessageAuthor = z.string().regex(/^(?:AGENT|SYSTEM|PERSON:[A-Za-z0-9_-]{1,128})$/, "expected AGENT, SYSTEM or PERSON:<id>");
export type MessageAuthor = z.infer<typeof MessageAuthor>;

export const MessageMedia = z.object({
  kind: z.enum(["AUDIO", "IMAGE", "DOCUMENT"]),
  s3Key: S3Key,
  sha256: Sha256Hex.optional(),
  mime: z.string().min(1).max(100),
  bytes: z.int().min(0).optional(),
  durationSec: z.number().min(0).optional(),
});
export type MessageMedia = z.infer<typeof MessageMedia>;

export const Transcript = z.object({ text: z.string().max(4000), confidence: z.number().min(0).max(1) });
export type Transcript = z.infer<typeof Transcript>;

/** The policy decision a message went out (or was held) with. */
export const MessagePolicy = z.object({
  decision: AuditDecision,
  ruleIds: z.array(RuleId).default([]),
  decisionId: z.string().min(1).max(128).optional(),
});
export type MessagePolicy = z.infer<typeof MessagePolicy>;

export const Message = defineEntity("Message", {
  messageId: z.string().regex(/^[A-Za-z0-9_.:=+/-]{1,200}$/, "expected a message id"),
  personId: PersonId,
  ispId: IspId,
  clockId: ClockId,
  direction: MessageDirection,
  channel: z.literal("WHATSAPP"),
  content: MessageContent,
  /** Kind of an outbound message (docs/tool-catalog.md, `MessageKind`); inbound messages have none. */
  kind: MessageKind.optional(),
  workOrderId: WorkOrderId.optional(),
  caseId: CaseId.optional(),
  text: z.string().max(4096).optional(),
  templateName: TemplateName.optional(),
  templateParams: z.array(z.string().max(1024)).optional(),
  interactive: JsonObject.optional(),
  buttonAction: WaButtonAction.optional(),
  nonce: z.string().min(1).max(128).optional(),
  media: MessageMedia.optional(),
  transcript: Transcript.optional(),
  status: MessageStatus,
  policy: MessagePolicy.optional(),
  author: MessageAuthor,
  turnId: z.string().min(1).max(128).optional(),
  simulated: z.boolean(),
  transport: WhatsAppTransport.optional(),
  /** `wamid` of Meta or of the simulator (`wamid.SIM.…`): the key of WhatsApp statuses. */
  providerMessageId: z.string().min(1).max(256).optional(),
  sentAtSim: IsoInstant,
  sentAtReal: IsoInstant.optional(),
  refs: JsonObject.optional(),
});
export type Message = z.infer<typeof Message>;

/** A WhatsApp status (`sent`, `delivered`, `read`, `failed`) or a reaction/ack of a message. */
export const MessageEvent = defineEntity("MessageEvent", {
  eventId: z.string().min(1).max(200),
  personId: PersonId,
  clockId: ClockId,
  messageId: z.string().min(1).max(200),
  status: z.enum(["SENT", "DELIVERED", "READ", "FAILED", "DELETED"]),
  atReal: IsoInstant,
  atSim: IsoInstant.optional(),
  errorCode: z.string().max(32).optional(),
  errorTitle: z.string().max(200).optional(),
  pricing: z.object({ model: z.string().max(16).optional(), category: z.string().max(32).optional(), billable: z.boolean().optional() }).optional(),
});
export type MessageEvent = z.infer<typeof MessageEvent>;

/** The final text of an agent turn: an internal note, never sent (ADR-0014). */
export const TurnNote = defineEntity("TurnNote", {
  turnId: z.string().min(1).max(128),
  personId: PersonId,
  clockId: ClockId,
  workOrderId: WorkOrderId.optional(),
  trigger: TurnTrigger,
  note: z.string().max(4000),
  stopReason: z.string().max(64).optional(),
  usage: TokenUsage.optional(),
  latencyMs: z.int().min(0).optional(),
  agentMode: z.enum(["REAL", "SCRIPTED"]).default("REAL"),
  atSim: IsoInstant,
});
export type TurnNote = z.infer<typeof TurnNote>;

export const EmailKind = MessageKind.extract(["CERTIFICATE_EMAIL", "ZONE_CHIEF_ALERT"]);
export type EmailKind = z.infer<typeof EmailKind>;

export const EmailStatus = z.enum(["QUEUED", "SENT", "DELIVERED", "DELAYED", "BOUNCED", "COMPLAINED", "FAILED", "DENIED"]);
export type EmailStatus = z.infer<typeof EmailStatus>;

export const EmailEventType = z.enum(["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY", "RENDERING_FAILURE"]);
export type EmailEventType = z.infer<typeof EmailEventType>;

export const EmailEvent = z.object({ type: EmailEventType, atReal: IsoInstant, detail: z.string().max(200).optional() });
export type EmailEvent = z.infer<typeof EmailEvent>;

export const EmailAttachment = z.object({
  s3Key: S3Key,
  fileName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  contentType: z.literal("application/pdf"),
  sha256: Sha256Hex.optional(),
});
export type EmailAttachment = z.infer<typeof EmailAttachment>;

/** One email of the outbox (`OUTBOX#<ispId>`), with the body as it left and its SES events. */
export const OutboundEmail = defineEntity("OutboundEmail", {
  mailId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  ispId: IspId,
  clockId: ClockId,
  kind: EmailKind,
  toRole: z.enum(["CUSTOMER", "OPS_MAILBOX", "ZONE_CHIEF"]),
  to: EmailAddress,
  from: z.string().min(3).max(320),
  subject: z.string().min(1).max(998),
  bodyText: z.string().max(20_000),
  workOrderId: WorkOrderId.optional(),
  caseId: CaseId.optional(),
  attachment: EmailAttachment.optional(),
  providerMessageId: z.string().min(1).max(256).optional(),
  status: EmailStatus,
  events: z.array(EmailEvent).default([]),
  sentAtSim: IsoInstant,
  sentAtReal: IsoInstant,
});
export type OutboundEmail = z.infer<typeof OutboundEmail>;
