// The two WhatsApp transports as channels/adapter.ts defines a channel's way out (ADR-0002): the
// outbound pipeline never sees whether a send is live or simulated. Which one a recipient gets is
// channels/registry.ts's decision (`whatsAppRouteOf`: a real phone of the live world or bound by a
// join code goes live; every synthetic identity simulated); this module only defines what both take
// and answer. Both validate the same Cloud API JSON (meta-messages.ts), record the send on the message
// the pipeline already wrote (`QUEUED` → `SENT`, with the payload as it left) and answer a
// `ChannelSendResult`: an expected failure (a template not approved, a provider error) is a code,
// never an exception.
import { isRetryable, toToolFailure } from "@cuadrilla/shared";
import type { ConversationsPort, MessageRef } from "../../connector/ports";
import type { JsonObject } from "../../domain/common";
import { type ChannelSendFailure, type ChannelSendResult, type ChannelTransport, sendFailure } from "../adapter";
import type { MetaMessage } from "./meta-messages";

/** Logical buckets an outbound message may attach from (the certificate PDF, the photos of a case). */
export type MediaBucket = "Evidence" | "Media";

export interface OutboundMedia {
  readonly bucket: MediaBucket;
  readonly key: string;
}

export interface SendRequest {
  /** The outbound message the pipeline wrote before calling the transport. */
  readonly message: MessageRef;
  readonly clockId: string;
  readonly ispId: string;
  /**
   * The payload to send. With `media`, its image, document or document header carries
   * `PENDING_MEDIA_ID`, which the transport replaces (live: `PostWhatsAppMessageMedia`; simulated:
   * a reference to the object's key).
   */
  readonly payload: MetaMessage;
  readonly media?: OutboundMedia;
}

export interface SentMessage {
  readonly providerMessageId: string;
  /** The payload as it left, with the final media id. */
  readonly payload: MetaMessage;
}

export type WhatsAppSendResult = ChannelSendResult<SentMessage>;

export type WhatsAppChannelTransport = ChannelTransport<SendRequest, WhatsAppSendResult>;

/** Placeholder media id of a payload rendered before its media is uploaded. */
export const PENDING_MEDIA_ID = "pending-media";

/** A failure while sending, as the adapter's result: its tool code, its detail and whether to retry. */
export function sendFailureOf(error: unknown): ChannelSendFailure {
  const failure = toToolFailure(error);
  return sendFailure(failure.error.code, failure.error.reason ?? failure.error.message, { retryable: isRetryable(error) });
}

/**
 * The Cloud API JSON as it is stored on the message: without `to`. The recipient's phone lives only in
 * `People` (a phone bound by a join code not even there, only its hash), so a stored payload never
 * carries it; the message already names the person.
 */
export function storedPayload(payload: MetaMessage): JsonObject {
  const { to: _recipient, ...rest } = payload;
  return JSON.parse(JSON.stringify(rest)) as JsonObject;
}

/** Stores the send on the pipeline's message: provider id, `SENT`, real instant and the Cloud API JSON without the recipient. */
export async function recordSent(
  conversations: Pick<ConversationsPort, "getMessage" | "updateMessage">,
  ref: MessageRef,
  sent: SentMessage & { readonly atReal: string },
): Promise<void> {
  const current = await conversations.getMessage(ref);
  const whatsapp = storedPayload(sent.payload);
  await conversations.updateMessage(ref, { providerMessageId: sent.providerMessageId, status: "SENT", sentAtReal: sent.atReal, refs: { ...(current?.refs ?? {}), whatsapp } });
}
