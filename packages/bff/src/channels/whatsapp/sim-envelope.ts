// The simulated envelope (docs/architecture-integrations.md §4.3): the phone simulator and the
// QaDriver hand `InboundWhatsApp` exactly the SNS record of a live event (§4.2), with three
// differences that no live event can carry: the Meta id of the number is `sim-<clockId>`, the AWS id
// is the fictitious `SIMULATED_ORIGINATION_ID`, and the record is signed with an HMAC of the
// `sim-envelope` subkey over the world and the whole message instead of SNS's RSA signature. The
// world (`clockId`) is always the principal's, set by the server, never by the browser.
import { createHash } from "node:crypto";
import type { ClockId } from "@cuadrilla/shared";
import { type SecretKey, hmacSha256Base64Url, verifyHmacBase64Url } from "../../lib/crypto";
import { SIM_CLOCK_ATTRIBUTE, SIM_MEDIA_PREFIX, SIM_SIGNATURE_VERSION, SIMULATED_ORIGINATION_ID, WHATSAPP_ACCOUNT_ID, WHATSAPP_REGION, phoneNumberArn, simMetaPhoneNumberId } from "./config";
import { type SnsNotification, type SnsRecord, messageAttribute } from "./payloads";
import { waRecipient } from "./render";

/** What a simulated person sends: the same message types a phone produces. */
export type SimulatedContent =
  | { readonly type: "text"; readonly body: string }
  /** Quick reply of a template: the payload is the button's nonce. */
  | { readonly type: "button"; readonly payload: string; readonly text: string }
  /** Reply button or list row of an interactive message: the id is the nonce. */
  | { readonly type: "button_reply" | "list_reply"; readonly id: string; readonly title: string }
  | { readonly type: "voice"; readonly uploadId: string; readonly mimeType: string }
  | { readonly type: "photo"; readonly uploadId: string; readonly mimeType: string; readonly caption?: string }
  /** A type the channel does not read (sticker, video, document): only its kind travels. */
  | { readonly type: "other"; readonly kind: "sticker" | "video" | "document" | "location" };

export interface SimulatedEnvelopeInput {
  readonly clockId: ClockId;
  /** Registered phone of the chosen identity of the world (or the world's unknown number), E.164. */
  readonly from: string;
  /** `simulatorWamid(ulid)` or, from the QaDriver, `qaWamid(idempotencyKey)`. */
  readonly wamid: string;
  readonly content: SimulatedContent;
  /** Real instant the person sent it (the Meta `timestamp` is real time too). */
  readonly sentAtReal: Date;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function simulatorWamid(ulid: string): string {
  return `wamid.SIM.${ulid}`;
}

/** Deterministic id from the QaDriver's `idempotencyKey` (`runId/escenario/paso`): a retry is the same message. */
export function qaWamid(idempotencyKey: string): string {
  return `wamid.SIM.${sha256Hex(idempotencyKey)}`;
}

export function simMediaId(uploadId: string): string {
  return `${SIM_MEDIA_PREFIX}${uploadId}`;
}

/** The upload id of a simulated media id, or `undefined` for anything else. */
export function uploadIdOf(mediaId: string): string | undefined {
  if (!mediaId.startsWith(SIM_MEDIA_PREFIX)) return undefined;
  const uploadId = mediaId.slice(SIM_MEDIA_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,128}$/.test(uploadId) ? uploadId : undefined;
}

function messageOf(input: SimulatedEnvelopeInput): Record<string, unknown> {
  const common = { from: waRecipient(input.from), id: input.wamid, timestamp: String(Math.floor(input.sentAtReal.getTime() / 1000)) };
  const content = input.content;
  switch (content.type) {
    case "text":
      return { ...common, type: "text", text: { body: content.body } };
    case "button":
      return { ...common, type: "button", button: { payload: content.payload, text: content.text } };
    case "button_reply":
      return { ...common, type: "interactive", interactive: { type: "button_reply", button_reply: { id: content.id, title: content.title } } };
    case "list_reply":
      return { ...common, type: "interactive", interactive: { type: "list_reply", list_reply: { id: content.id, title: content.title } } };
    case "voice":
      return { ...common, type: "audio", audio: { id: simMediaId(content.uploadId), mime_type: content.mimeType, voice: true } };
    case "photo":
      return { ...common, type: "image", image: { id: simMediaId(content.uploadId), mime_type: content.mimeType, ...(content.caption === undefined ? {} : { caption: content.caption }) } };
    case "other":
      return { ...common, type: content.kind };
  }
}

/** Length-prefixed parts, so no separator inside a part (a clock id carries `#`) can shift the boundaries. */
function canonical(clockId: string, sns: Pick<SnsNotification, "MessageId" | "Timestamp" | "Message">): string {
  return [SIM_SIGNATURE_VERSION, clockId, sns.MessageId, sns.Timestamp, sns.Message].map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
}

/** The Lambda event `InboundWhatsApp` receives from the simulator (`lambda:Invoke`). */
export function buildSimulatedEvent(input: SimulatedEnvelopeInput, simEnvelopeKey: SecretKey): { readonly Records: readonly SnsRecord[] } {
  const metaId = simMetaPhoneNumberId(input.clockId);
  const entry = {
    id: "sim-waba",
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "simulator", phone_number_id: metaId },
          contacts: [{ wa_id: waRecipient(input.from) }],
          messages: [messageOf(input)],
        },
      },
    ],
  };
  const messageId = `sim-${sha256Hex(`${input.clockId}\n${input.wamid}`).slice(0, 32)}`;
  const timestamp = input.sentAtReal.toISOString();
  const body = JSON.stringify({
    context: {
      MetaWabaIds: [{ wabaId: "sim-waba", arn: `arn:aws:social-messaging:${WHATSAPP_REGION}:${WHATSAPP_ACCOUNT_ID}:waba/simulated` }],
      MetaPhoneNumberIds: [{ metaPhoneNumberId: metaId, arn: phoneNumberArn(SIMULATED_ORIGINATION_ID) }],
    },
    whatsAppWebhookEntry: JSON.stringify(entry),
    aws_account_id: WHATSAPP_ACCOUNT_ID,
    message_timestamp: timestamp,
    messageId,
  });
  const sns = {
    Type: "Notification",
    MessageId: messageId,
    TopicArn: "simulator",
    Message: body,
    Timestamp: timestamp,
    SignatureVersion: SIM_SIGNATURE_VERSION,
    MessageAttributes: { [SIM_CLOCK_ATTRIBUTE]: { Type: "String", Value: input.clockId } },
  };
  return { Records: [{ EventSource: "cuadrilla:simulator", Sns: { ...sns, Signature: hmacSha256Base64Url(simEnvelopeKey, canonical(input.clockId, sns)) } }] };
}

/** The world of a validly signed simulated envelope, or `undefined`. */
export function verifySimulatedEnvelope(sns: SnsNotification, simEnvelopeKey: SecretKey): string | undefined {
  if (sns.SignatureVersion !== SIM_SIGNATURE_VERSION || sns.Type !== "Notification") return undefined;
  const clockId = messageAttribute(sns, SIM_CLOCK_ATTRIBUTE);
  if (clockId === undefined || clockId === "") return undefined;
  return verifyHmacBase64Url(simEnvelopeKey, canonical(clockId, sns), sns.Signature) ? clockId : undefined;
}
