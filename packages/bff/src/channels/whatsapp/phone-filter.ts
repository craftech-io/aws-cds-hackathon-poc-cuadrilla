// The first thing `InboundWhatsApp` does with a record (docs/architecture-integrations.md §4.4, steps
// 1 to 3; ADR-0002), before idempotency, identity or any parsing of messages:
//
//   1. Origin. Live: a valid SNS signature (version 2, certificate from our region's SNS host) whose
//      signed `TopicArn` is our WhatsApp topic (SNS signs every topic of every account with the same
//      certificate, so the signature alone would accept a notification of someone else's topic handed
//      to the Lambda directly); a `qa-foreign=1` attribute is foreign always; the stage must have the
//      `live` transport.
//      Simulated: a valid `sim-envelope` HMAC and a world whose `whatsappMode` is `simulated`.
//   2. Number, in the envelope (`whatsAppWebhookEntry` still unparsed): `context.MetaPhoneNumberIds[]`
//      must hold our Meta id WITH the ARN of our number (built from the AWS id); simulated: `sim-<clockId>`.
//   3. Number, in every change: each `metadata.phone_number_id` must be our Meta id (or `sim-<clockId>`);
//      a change without `metadata` is foreign too.
//
// The comparison is always with the Meta id: the AWS id only builds the ARN. Nothing here throws for a
// foreign or malformed record (success without effects, so SNS never retries it); a foreign one
// leaves only an id-and-time probe and a metric whose dimension is the last four digits of its Meta id.
import type { WhatsAppMode, WhatsAppTransport } from "@cuadrilla/shared";
import { foreignProbeId } from "../../connector/keys";
import type { WorldRuntimePort } from "../../connector/ports";
import type { SecretKey } from "../../lib/crypto";
import type { Logger } from "../../lib/log";
import { acceptsInbound } from "../registry";
import { QA_FOREIGN_ATTRIBUTE, SIM_SIGNATURE_VERSION, phoneNumberArn, simMetaPhoneNumberId } from "./config";
import { EumEnvelope, SnsRecord, WebhookEntry, messageAttribute, parseJson } from "./payloads";
import type { MetricSink } from "./ports";
import type { SnsVerifier } from "./sns-signature";
import { verifySimulatedEnvelope } from "./sim-envelope";

export type ForeignReason = "QA_FOREIGN" | "ENVELOPE_NUMBER" | "CHANGE_NUMBER" | "CHANGE_WITHOUT_METADATA";
export type RejectReason =
  | "MALFORMED_RECORD"
  | "MALFORMED_ENVELOPE"
  | "MALFORMED_ENTRY"
  | "BAD_SIGNATURE"
  | "BAD_SIGNATURE_VERSION"
  | "BAD_CERT_URL"
  | "FOREIGN_TOPIC"
  | "UNSUPPORTED_TYPE"
  | "BAD_SIM_SIGNATURE"
  | "SIM_WORLD_NOT_SIMULATED"
  | "LIVE_TRANSPORT_DISABLED";

export type ScreenResult =
  | { readonly verdict: "ACCEPT"; readonly origin: "LIVE"; readonly snsMessageId: string; readonly envelope: EumEnvelope; readonly entry: WebhookEntry }
  | { readonly verdict: "ACCEPT"; readonly origin: "SIMULATED"; readonly clockId: string; readonly snsMessageId: string; readonly envelope: EumEnvelope; readonly entry: WebhookEntry }
  | { readonly verdict: "FOREIGN"; readonly reason: ForeignReason; readonly snsMessageId: string; readonly metaIdTail: string }
  | { readonly verdict: "REJECT"; readonly reason: RejectReason }
  /** A dependency failed on a record that may be ours (a certificate download, a table read): let SNS retry. */
  | { readonly verdict: "RETRY"; readonly reason: string };

/** The two ids of our number (lib/secrets.ts `whatsAppConnection`); `undefined` until P-01. */
export interface NumberIds {
  readonly phoneNumberId: string;
  readonly metaPhoneNumberId: string;
}

export interface PhoneFilterDeps {
  readonly verifier: SnsVerifier;
  /** ARN of our WhatsApp topic (`Resource.WaInboundOrigin.arn`): the only `TopicArn` a live record may carry. */
  readonly topicArn: () => string;
  readonly simEnvelopeKey: SecretKey;
  readonly numberIds: () => NumberIds | undefined;
  /** `ChannelModes.whatsapp.transports` of the stage. */
  readonly stageTransports: () => readonly WhatsAppTransport[];
  /** `Isps/SETTINGS.whatsappMode` of a world; `undefined` when the world does not exist. */
  readonly worldMode: (clockId: string) => Promise<WhatsAppMode | undefined>;
}

/** Last four digits of a Meta id, the only part of a foreign id a metric or a log may carry. */
export function metaIdTail(metaId: string | undefined): string {
  const digits = (metaId ?? "").replace(/\D/g, "");
  return digits.length === 0 ? "none" : digits.slice(-4);
}

function foreign(reason: ForeignReason, snsMessageId: string, metaId: string | undefined): ScreenResult {
  return { verdict: "FOREIGN", reason, snsMessageId, metaIdTail: metaIdTail(metaId) };
}

type NumberCheck = { readonly ok: true; readonly entry: WebhookEntry } | { readonly ok: false; readonly result: ScreenResult };

/** Steps 2 and 3 for an expected Meta id (and, live, the ARN of our number). */
function checkNumber(snsMessageId: string, envelope: EumEnvelope, metaId: string, arn: string | undefined): NumberCheck {
  const refs = envelope.context.MetaPhoneNumberIds;
  const ours = refs.some((ref) => ref.metaPhoneNumberId === metaId && (arn === undefined || ref.arn === arn));
  if (!ours) return { ok: false, result: foreign("ENVELOPE_NUMBER", snsMessageId, refs.find((ref) => ref.metaPhoneNumberId !== metaId)?.metaPhoneNumberId ?? refs[0]?.metaPhoneNumberId) };
  const entry = WebhookEntry.safeParse(parseJson(envelope.whatsAppWebhookEntry));
  if (!entry.success) return { ok: false, result: { verdict: "REJECT", reason: "MALFORMED_ENTRY" } };
  for (const change of entry.data.changes) {
    const changeId = change.value.metadata?.phone_number_id;
    if (changeId === undefined) return { ok: false, result: foreign("CHANGE_WITHOUT_METADATA", snsMessageId, undefined) };
    if (changeId !== metaId) return { ok: false, result: foreign("CHANGE_NUMBER", snsMessageId, changeId) };
  }
  return { ok: true, entry: entry.data };
}

function parseEnvelope(message: string): EumEnvelope | undefined {
  const parsed = EumEnvelope.safeParse(parseJson(message));
  return parsed.success ? parsed.data : undefined;
}

async function screenSimulated(record: SnsRecord, deps: PhoneFilterDeps): Promise<ScreenResult> {
  const clockId = verifySimulatedEnvelope(record.Sns, deps.simEnvelopeKey);
  if (clockId === undefined) return { verdict: "REJECT", reason: "BAD_SIM_SIGNATURE" };
  let mode: WhatsAppMode | undefined;
  try {
    mode = await deps.worldMode(clockId);
  } catch {
    return { verdict: "RETRY", reason: "WORLD_MODE_UNAVAILABLE" };
  }
  if (mode === undefined || !acceptsInbound("simulated", { stageTransports: deps.stageTransports(), worldMode: mode })) return { verdict: "REJECT", reason: "SIM_WORLD_NOT_SIMULATED" };
  const envelope = parseEnvelope(record.Sns.Message);
  if (envelope === undefined) return { verdict: "REJECT", reason: "MALFORMED_ENVELOPE" };
  const check = checkNumber(record.Sns.MessageId, envelope, simMetaPhoneNumberId(clockId), undefined);
  if (!check.ok) return check.result;
  return { verdict: "ACCEPT", origin: "SIMULATED", clockId, snsMessageId: record.Sns.MessageId, envelope, entry: check.entry };
}

async function screenLive(record: SnsRecord, deps: PhoneFilterDeps): Promise<ScreenResult> {
  const sns = record.Sns;
  const signature = await deps.verifier.verify(sns);
  if (signature === "CERT_UNAVAILABLE") return { verdict: "RETRY", reason: signature };
  if (signature === "BAD_VERSION") return { verdict: "REJECT", reason: "BAD_SIGNATURE_VERSION" };
  if (signature !== "VALID") return { verdict: "REJECT", reason: signature };
  // `TopicArn` is inside the signed string: this binds the signature to our topic.
  if (sns.TopicArn !== deps.topicArn()) return { verdict: "REJECT", reason: "FOREIGN_TOPIC" };
  const envelope = parseEnvelope(sns.Message);
  if (messageAttribute(sns, QA_FOREIGN_ATTRIBUTE) === "1") return foreign("QA_FOREIGN", sns.MessageId, envelope?.context.MetaPhoneNumberIds[0]?.metaPhoneNumberId);
  // The world of a live event is resolved after the filter (identity.ts); only the stage decides here.
  if (!acceptsInbound("live", { stageTransports: deps.stageTransports(), worldMode: "live" })) return { verdict: "REJECT", reason: "LIVE_TRANSPORT_DISABLED" };
  if (envelope === undefined) return { verdict: "REJECT", reason: "MALFORMED_ENVELOPE" };
  const ids = deps.numberIds();
  if (ids === undefined) return foreign("ENVELOPE_NUMBER", sns.MessageId, envelope.context.MetaPhoneNumberIds[0]?.metaPhoneNumberId);
  const check = checkNumber(sns.MessageId, envelope, ids.metaPhoneNumberId, phoneNumberArn(ids.phoneNumberId));
  if (!check.ok) return check.result;
  return { verdict: "ACCEPT", origin: "LIVE", snsMessageId: sns.MessageId, envelope, entry: check.entry };
}

/** Steps 1 to 3 for one record of the Lambda event. Never throws. */
export async function screenRecord(raw: unknown, deps: PhoneFilterDeps): Promise<ScreenResult> {
  try {
    const record = SnsRecord.safeParse(raw);
    if (!record.success) return { verdict: "REJECT", reason: "MALFORMED_RECORD" };
    return record.data.Sns.SignatureVersion === SIM_SIGNATURE_VERSION ? await screenSimulated(record.data, deps) : await screenLive(record.data, deps);
  } catch {
    return { verdict: "RETRY", reason: "SCREEN_FAILED" };
  }
}

export interface ForeignDeps {
  readonly worlds: Pick<WorldRuntimePort, "putProbe">;
  readonly metrics: MetricSink;
  readonly logger: Logger;
}

/**
 * What a foreign event leaves: `Runtime/PROBE#foreign#<SNS MessageId>` (ids and time, 48 h,
 * idempotent: a redelivery of the same SNS message finds it) and `ForeignPhoneNumberEvents`. The
 * probe id is the SNS `MessageId`, the one `Publish` returns to the QaDriver (FL-095). No content.
 */
export async function recordForeign(result: Extract<ScreenResult, { verdict: "FOREIGN" }>, deps: ForeignDeps): Promise<void> {
  deps.metrics.count("ForeignPhoneNumberEvents", { metaPhoneNumberId: result.metaIdTail });
  deps.logger.info("foreign WhatsApp event discarded", { reason: result.reason, eventId: result.snsMessageId, metaIdTail: result.metaIdTail });
  try {
    await deps.worlds.putProbe(foreignProbeId(result.snsMessageId), { reason: result.reason });
  } catch (error) {
    deps.logger.warn("foreign probe not written", { eventId: result.snsMessageId, error });
  }
}
