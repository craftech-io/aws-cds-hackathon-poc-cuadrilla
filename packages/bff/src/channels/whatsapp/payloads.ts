// Inbound shapes of End User Messaging Social (docs/architecture-integrations.md §4.2), checked with
// zod at the edge. An event arrives as an SNS record whose `Message` is the EUM envelope; its
// `whatsAppWebhookEntry` is a JSON *string* with Meta's webhook entry, parsed only after the number
// filter of phone-filter.ts (never before). Unknown fields pass through (`loose`): Meta adds fields
// without notice, and the adapter reads only what it names here.
import { z } from "zod";

// ---- SNS record (Lambda event) ------------------------------------------------------------------

const MessageAttribute = z.object({ Type: z.string().max(64), Value: z.string().max(1024) }).loose();

/** `Records[].Sns` as Lambda delivers it (`SigningCertUrl`) or as SNS signs it over HTTP (`SigningCertURL`). */
export const SnsNotification = z
  .object({
    Type: z.string().max(64),
    MessageId: z.string().min(1).max(256),
    TopicArn: z.string().min(1).max(512),
    Subject: z.string().max(512).nullable().optional(),
    Message: z.string().min(2).max(262_144),
    Timestamp: z.string().min(1).max(64),
    SignatureVersion: z.string().min(1).max(32),
    Signature: z.string().min(1).max(4096),
    SigningCertUrl: z.string().max(2048).optional(),
    SigningCertURL: z.string().max(2048).optional(),
    MessageAttributes: z.record(z.string(), MessageAttribute).optional(),
  })
  .loose();
export type SnsNotification = z.infer<typeof SnsNotification>;

export const SnsRecord = z.object({ EventSource: z.string().max(64).optional(), Sns: SnsNotification }).loose();
export type SnsRecord = z.infer<typeof SnsRecord>;

export const SnsEvent = z.object({ Records: z.array(z.unknown()).min(1).max(100) }).loose();
export type SnsEvent = z.infer<typeof SnsEvent>;

/** Value of a string message attribute, or `undefined`. */
export function messageAttribute(sns: SnsNotification, name: string): string | undefined {
  return sns.MessageAttributes?.[name]?.Value;
}

// ---- EUM Social envelope (the SNS `Message`) ----------------------------------------------------

const MetaPhoneNumberRef = z.object({ metaPhoneNumberId: z.string().max(64), arn: z.string().max(512) }).loose();

export const EumEnvelope = z
  .object({
    context: z
      .object({
        MetaWabaIds: z.array(z.object({ wabaId: z.string().max(64), arn: z.string().max(512) }).loose()).optional(),
        MetaPhoneNumberIds: z.array(MetaPhoneNumberRef).max(20),
      })
      .loose(),
    whatsAppWebhookEntry: z.string().min(2).max(262_144),
    aws_account_id: z.string().max(32).optional(),
    message_timestamp: z.string().max(64).optional(),
    messageId: z.string().max(256).optional(),
  })
  .loose();
export type EumEnvelope = z.infer<typeof EumEnvelope>;

// ---- Meta webhook entry ------------------------------------------------------------------------

/** `wa_id` / `from`: the sender's number, digits only, no `+`. */
export const WaId = z.string().regex(/^\d{8,15}$/, "expected a WhatsApp id (digits only)");

/** Meta's `timestamp`: epoch seconds as a string. */
const MetaTimestamp = z.string().regex(/^\d{1,12}$/);

const MessageBase = {
  from: WaId,
  id: z.string().min(1).max(200),
  timestamp: MetaTimestamp,
  context: z.object({ id: z.string().max(200).optional(), from: z.string().max(32).optional() }).loose().optional(),
};

export const MediaRef = z
  .object({
    id: z.string().min(1).max(256),
    mime_type: z.string().min(1).max(100),
    sha256: z.string().max(128).optional(),
    caption: z.string().max(1024).optional(),
    voice: z.boolean().optional(),
  })
  .loose();
export type MediaRef = z.infer<typeof MediaRef>;

export const TextMessage = z.object({ ...MessageBase, type: z.literal("text"), text: z.object({ body: z.string().max(4096) }).loose() }).loose();
export const ButtonMessage = z.object({ ...MessageBase, type: z.literal("button"), button: z.object({ payload: z.string().max(256), text: z.string().max(256) }).loose() }).loose();
const Reply = z.object({ id: z.string().min(1).max(256), title: z.string().max(256), description: z.string().max(256).optional() }).loose();
export const InteractiveMessage = z
  .object({
    ...MessageBase,
    type: z.literal("interactive"),
    interactive: z.union([
      z.object({ type: z.literal("button_reply"), button_reply: Reply }).loose(),
      z.object({ type: z.literal("list_reply"), list_reply: Reply }).loose(),
    ]),
  })
  .loose();
export const AudioMessage = z.object({ ...MessageBase, type: z.literal("audio"), audio: MediaRef }).loose();
export const ImageMessage = z.object({ ...MessageBase, type: z.literal("image"), image: MediaRef }).loose();
/** Anything else (document, video, sticker, reaction, location, contacts, …): a fixed reply, no content read. */
export const OtherMessage = z.object({ ...MessageBase, type: z.string().min(1).max(32) }).loose();

export const InboundMessage = z.union([TextMessage, ButtonMessage, InteractiveMessage, AudioMessage, ImageMessage, OtherMessage]);
export type InboundMessage = z.infer<typeof InboundMessage>;

const ErrorCode = z.union([z.number().int(), z.string().regex(/^\d{1,9}$/).transform(Number)]);

/** Both pricing models of Meta: per conversation (`CBP`) and per message (`PMP`, since 2025-07-01). */
export const Pricing = z
  .object({
    billable: z.boolean().optional(),
    pricing_model: z.enum(["CBP", "PMP"]),
    category: z.string().min(1).max(40),
    type: z.string().max(40).optional(),
  })
  .loose();
export type Pricing = z.infer<typeof Pricing>;

export const StatusUpdate = z
  .object({
    id: z.string().min(1).max(256),
    status: z.enum(["sent", "delivered", "read", "failed", "deleted"]),
    timestamp: MetaTimestamp,
    recipient_id: z.string().max(32).optional(),
    /** Optional: per-message pricing may come without a conversation. */
    conversation: z.object({ id: z.string().max(128), origin: z.object({ type: z.string().max(40) }).loose().optional() }).loose().optional(),
    pricing: Pricing.optional(),
    errors: z.array(z.object({ code: ErrorCode, title: z.string().max(200).optional() }).loose()).max(10).optional(),
  })
  .loose();
export type StatusUpdate = z.infer<typeof StatusUpdate>;

export const ChangeMetadata = z.object({ display_phone_number: z.string().max(32).optional(), phone_number_id: z.string().min(1).max(64) }).loose();

export const WebhookChange = z
  .object({
    field: z.string().max(64),
    value: z
      .object({
        messaging_product: z.string().max(32).optional(),
        metadata: ChangeMetadata.optional(),
        contacts: z.array(z.object({ wa_id: z.string().max(32) }).loose()).optional(),
        messages: z.array(InboundMessage).max(50).optional(),
        statuses: z.array(StatusUpdate).max(100).optional(),
      })
      .loose(),
  })
  .loose();
export type WebhookChange = z.infer<typeof WebhookChange>;

export const WebhookEntry = z.object({ id: z.string().max(64), changes: z.array(WebhookChange).min(1).max(20) }).loose();
export type WebhookEntry = z.infer<typeof WebhookEntry>;

/** JSON of a string, or `undefined` (a malformed body never throws). */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Meta's epoch-seconds `timestamp` as an ISO instant. */
export function metaTimestampToIso(seconds: string): string {
  const value = Number(seconds);
  if (!Number.isInteger(value) || value < 0) throw new RangeError("invalid Meta timestamp");
  return new Date(value * 1000).toISOString();
}
