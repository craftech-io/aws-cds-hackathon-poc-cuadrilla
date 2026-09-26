// Fixed values of the WhatsApp adapter (docs/architecture-integrations.md §4, ADR-0002). End User
// Messaging Social names our number two ways and they are never interchangeable:
//
//   AWS id   `phone-number-id-<32 hex>` (secret WhatsAppPhoneNumberId): sends, media and IAM
//   Meta id  numeric (secret WhatsAppMetaPhoneNumberId): the only value an inbound event is compared with
//
// The phone simulator uses the same envelope with `sim-<clockId>` as the Meta id and the fixed AWS id
// below, so a simulated event can never pass as a live one and vice versa.

/** Cloud API version of every `SendWhatsAppMessage` (the payload is Meta's JSON, versioned by Meta). */
export const META_API_VERSION = "v20.0";

/** Region and account of the app (docs/architecture.md §1): the ARN of our number is built from them. */
export const WHATSAPP_REGION = "us-east-1";
export const WHATSAPP_ACCOUNT_ID = "776805327629";

/** The only host a live SNS event's `SigningCertURL` may point at (docs/architecture-integrations.md §4.4). */
export const SNS_SIGNING_HOST = `sns.${WHATSAPP_REGION}.amazonaws.com`;

/** Signature version of a live SNS event (SHA256withRSA); version 1 (SHA1) is refused. */
export const SNS_SIGNATURE_VERSION = "2";

/** Signature version of a simulated envelope: HMAC-SHA256 with the `sim-envelope` subkey. */
export const SIM_SIGNATURE_VERSION = "sim-envelope-1";

/** Message attribute that carries the world of a simulated envelope (it is also inside the signature). */
export const SIM_CLOCK_ATTRIBUTE = "sim-clock-id";

/** Attribute the QaDriver puts on a foreign event it publishes (FL-095): discarded always. */
export const QA_FOREIGN_ATTRIBUTE = "qa-foreign";

/** Fictitious AWS id of the simulated number: the valid pattern, never a real number. */
export const SIMULATED_ORIGINATION_ID = "phone-number-id-00000000000000000000000000000000";

const AWS_PHONE_NUMBER_ID = /^phone-number-id-([0-9a-f]{32})$/;

/** Meta id of the number in a simulated envelope: one per world. */
export function simMetaPhoneNumberId(clockId: string): string {
  return `sim-${clockId}`;
}

/**
 * ARN of our number from its AWS id: `…:phone-number-id/<32 hex>`, without the `phone-number-id-`
 * prefix (the form of `GetLinkedWhatsAppBusinessAccount.phoneNumbers[].arn`).
 */
export function phoneNumberArn(awsPhoneNumberId: string): string {
  const hex = AWS_PHONE_NUMBER_ID.exec(awsPhoneNumberId)?.[1];
  if (hex === undefined) throw new RangeError("expected the AWS id of the number (phone-number-id-<32 hex>), never the Meta id");
  return `arn:aws:social-messaging:${WHATSAPP_REGION}:${WHATSAPP_ACCOUNT_ID}:phone-number-id/${hex}`;
}

const MIB = 1024 * 1024;

/** Media an inbound message may carry (docs/architecture-integrations.md §4.1 and §4.3). */
export const MEDIA_LIMITS = {
  /** Voice notes: 16 MB (their duration, ≤ 120 s, is checked by the transcription). */
  audioBytes: 16 * MIB,
  /** Photos from WhatsApp: 3.75 MB. */
  imageBytes: 3.75 * MIB,
  /** Photos uploaded to the simulator: 3.5 MB (the presigned POST enforces it too). */
  simulatorImageBytes: 3.5 * MIB,
} as const;

/** Content types accepted as a voice note: WhatsApp and Polly send Ogg/Opus; browsers record WebM or MP4. */
export const LIVE_AUDIO_TYPES: readonly string[] = ["audio/ogg"];
export const SIMULATOR_AUDIO_TYPES: readonly string[] = ["audio/ogg", "audio/webm", "audio/mp4"];
export const IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png"];

/** Prefix of the media id of a simulated message: `sim-media:<uploadId>` (the key comes from `UPLOAD#`). */
export const SIM_MEDIA_PREFIX = "sim-media:";

/** Replies to unknown numbers in live mode, per real day and stage (`UNKNOWN#GLOBAL`, docs/design-brief.md §5.7). */
export const UNKNOWN_REPLIES_PER_DAY = 20;

/** Meta's re-engagement error: free text outside the 24 h window (ADR-0002, `WINDOW_FALLBACK`). */
export const REENGAGEMENT_ERROR_CODE = 131047;

/** A simulated message is delivered one second after it is sent (docs/architecture-integrations.md §4.3). */
export const SIMULATED_DELIVERY_DELAY_MS = 1_000;

/** Meta keeps an uploaded media id for 30 days; the adapter reuses one for a day at most. */
export const MEDIA_ID_REUSE_MS = 24 * 60 * 60 * 1000;

/** Timeout and retries of the download of an SNS signing certificate. */
export const SNS_CERT_FETCH = { timeoutMs: 3_000, attempts: 3 } as const;
