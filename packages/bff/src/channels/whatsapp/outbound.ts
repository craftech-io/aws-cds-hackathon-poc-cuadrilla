// The live transport (docs/architecture-integrations.md §4.1; FL-049, FL-092): the validated Cloud API
// JSON goes out with `SendWhatsAppMessage` from the AWS id of our number. A template leaves only when
// Meta approved it (`Reference/TEMPLATE#WHATSAPP`, written by scripts/channels/whatsapp-templates.ts),
// a second fence after the contact policy's `CP-TEMPLATE-APPROVED`. Media (the certificate PDF, the
// photos of a case) is uploaded from our bucket with `PostWhatsAppMessageMedia` and its id reused
// while it is fresh. Nothing here decides whether a message may leave: the outbound pipeline did.
import type { ConversationsPort, ReferencePort } from "../../connector/ports";
import { sendFailure } from "../adapter";
import { type Clock, systemClock } from "../../lib/clock";
import type { SocialMessagingPort } from "./client";
import { MEDIA_ID_REUSE_MS } from "./config";
import { MetaMessage } from "./meta-messages";
import { mediaIdOf, withMediaId } from "./render";
import { type MediaBucket, type OutboundMedia, type SendRequest, type WhatsAppChannelTransport, type WhatsAppSendResult, PENDING_MEDIA_ID, recordSent, sendFailureOf } from "./transport";

/** Media ids already uploaded, by bucket and key, reused for `MEDIA_ID_REUSE_MS` (Meta keeps them 30 days). */
export interface MediaIdCache {
  get(media: OutboundMedia, nowMs: number): string | undefined;
  set(media: OutboundMedia, mediaId: string, nowMs: number): void;
}

export function createMediaIdCache(reuseMs: number = MEDIA_ID_REUSE_MS): MediaIdCache {
  const entries = new Map<string, { readonly mediaId: string; readonly atMs: number }>();
  const keyOf = (media: OutboundMedia) => `${media.bucket}/${media.key}`;
  return {
    get(media, nowMs) {
      const entry = entries.get(keyOf(media));
      return entry !== undefined && nowMs - entry.atMs < reuseMs ? entry.mediaId : undefined;
    },
    set(media, mediaId, nowMs) {
      entries.set(keyOf(media), { mediaId, atMs: nowMs });
    },
  };
}

export interface LiveTransportDeps {
  readonly social: SocialMessagingPort;
  readonly conversations: Pick<ConversationsPort, "getMessage" | "updateMessage">;
  readonly templates: Pick<ReferencePort, "getTemplate">;
  /** Physical bucket name of a logical one (`Resource.<Bucket>.name`). */
  readonly bucketName: (bucket: MediaBucket) => string;
  readonly mediaIds?: MediaIdCache;
  readonly realClock?: Clock;
}

export function createLiveTransport(deps: LiveTransportDeps): WhatsAppChannelTransport {
  const mediaIds = deps.mediaIds ?? createMediaIdCache();
  const realClock = deps.realClock ?? systemClock;

  async function uploaded(media: OutboundMedia, nowMs: number): Promise<string> {
    const cached = mediaIds.get(media, nowMs);
    if (cached !== undefined) return cached;
    const { mediaId } = await deps.social.uploadMedia({ bucket: deps.bucketName(media.bucket), key: media.key });
    mediaIds.set(media, mediaId, nowMs);
    return mediaId;
  }

  return {
    channel: "WHATSAPP",
    transport: "live",
    async send(request: SendRequest): Promise<WhatsAppSendResult> {
      const parsed = MetaMessage.safeParse(request.payload);
      if (!parsed.success) return sendFailure("INVALID", "PAYLOAD_INVALID");
      let payload = parsed.data;
      if (payload.type === "template") {
        const template = await deps.templates.getTemplate(payload.template.name);
        if (template?.status !== "APPROVED") return sendFailure("POLICY_DENIED", "TEMPLATE_NOT_APPROVED");
      }
      if (request.media !== undefined && mediaIdOf(payload) !== PENDING_MEDIA_ID) return sendFailure("INVALID", "MEDIA_PLACEHOLDER");
      const now = await realClock.now();
      let providerMessageId: string;
      try {
        if (request.media !== undefined) payload = withMediaId(payload, await uploaded(request.media, now.getTime()));
        providerMessageId = (await deps.social.send(payload)).messageId;
      } catch (error) {
        return sendFailureOf(error);
      }
      await recordSent(deps.conversations, request.message, { providerMessageId, payload, atReal: now.toISOString() });
      return { ok: true, providerMessageId, payload };
    },
  };
}
