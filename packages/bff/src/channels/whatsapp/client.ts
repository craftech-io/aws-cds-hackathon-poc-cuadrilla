// The single End User Messaging Social client (CLAUDE.md, "un cliente por servicio externo"): send a
// Cloud API payload, fetch inbound media to S3 and upload media for an outbound message. It always
// uses the AWS id of our number (`originationPhoneNumberId`, secret WhatsAppPhoneNumberId), never the
// Meta id. Timeouts and the SDK's retries with backoff come from lib/clients.ts; errors are mapped
// here to `ChannelError` so callers never see an SDK exception.
import {
  GetWhatsAppMessageMediaCommand,
  PostWhatsAppMessageMediaCommand,
  SendWhatsAppMessageCommand,
  SocialMessagingClient,
} from "@aws-sdk/client-socialmessaging";
import { ChannelError, type ChannelErrorCode } from "@cuadrilla/shared";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../../lib/clients";
import { META_API_VERSION, WHATSAPP_REGION } from "./config";
import { type MetaMessage, type MetaReadStatus, encodePayload } from "./meta-messages";

export interface S3Location {
  readonly bucket: string;
  readonly key: string;
}

export interface MediaMetadata {
  readonly mimeType?: string;
  readonly fileSize?: number;
}

export interface SocialMessagingPort {
  /** `SendWhatsAppMessage`; returns the provider id of the message (the key of its statuses). */
  send(payload: MetaMessage | MetaReadStatus): Promise<{ readonly messageId: string }>;
  /** `GetWhatsAppMessageMedia` with `metadataOnly`: type and size, nothing downloaded. */
  mediaMetadata(mediaId: string): Promise<MediaMetadata>;
  /** `GetWhatsAppMessageMedia` into our bucket. */
  downloadMedia(mediaId: string, destination: S3Location): Promise<MediaMetadata>;
  /** `PostWhatsAppMessageMedia` from our bucket; returns Meta's media id. */
  uploadMedia(source: S3Location): Promise<{ readonly mediaId: string }>;
}

const ERROR_CODES: Readonly<Record<string, ChannelErrorCode>> = {
  ThrottledRequestException: "RATE_LIMITED",
  LimitExceededException: "RATE_LIMITED",
  InternalServiceException: "SEND_FAILED",
  DependencyException: "SEND_FAILED",
  ValidationException: "INVALID",
  InvalidParametersException: "INVALID",
  ResourceNotFoundException: "INVALID",
  ConflictException: "INVALID",
  AccessDeniedException: "UNAVAILABLE",
  AccessDeniedByMetaException: "UNAVAILABLE",
  TimeoutError: "TIMEOUT",
  RequestTimeout: "TIMEOUT",
};

/** An SDK failure as a `ChannelError`; the message names the operation and the exception only. */
export function toChannelError(operation: string, error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = ERROR_CODES[name] ?? "SEND_FAILED";
  return new ChannelError(code, "WHATSAPP", `${operation} failed: ${name}`, { cause: error });
}

async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toChannelError(operation, error);
  }
}

export interface SocialMessagingOptions {
  /** AWS id of our number, read lazily (it is `not-connected` until P-01 closes). */
  readonly originationPhoneNumberId: () => string;
  readonly client?: SocialMessagingClient;
}

let sharedClient: SocialMessagingClient | undefined;

function defaultClient(): SocialMessagingClient {
  sharedClient ??= new SocialMessagingClient({ region: WHATSAPP_REGION, ...awsClientConfig(CLIENT_TIMEOUTS.socialMessaging) });
  return sharedClient;
}

export function createSocialMessaging(options: SocialMessagingOptions): SocialMessagingPort {
  const client = (): SocialMessagingClient => options.client ?? defaultClient();

  async function getMedia(mediaId: string, destination?: S3Location): Promise<MediaMetadata> {
    const output = await call("GetWhatsAppMessageMedia", () =>
      client().send(
        new GetWhatsAppMessageMediaCommand({
          mediaId,
          originationPhoneNumberId: options.originationPhoneNumberId(),
          ...(destination === undefined ? { metadataOnly: true } : { destinationS3File: { bucketName: destination.bucket, key: destination.key } }),
        }),
      ),
    );
    return { ...(output.mimeType === undefined ? {} : { mimeType: output.mimeType }), ...(output.fileSize === undefined ? {} : { fileSize: output.fileSize }) };
  }

  return {
    async send(payload) {
      const output = await call("SendWhatsAppMessage", () =>
        client().send(new SendWhatsAppMessageCommand({ originationPhoneNumberId: options.originationPhoneNumberId(), message: encodePayload(payload), metaApiVersion: META_API_VERSION })),
      );
      if (output.messageId === undefined) throw new ChannelError("SEND_FAILED", "WHATSAPP", "SendWhatsAppMessage returned no message id");
      return { messageId: output.messageId };
    },
    mediaMetadata: (mediaId) => getMedia(mediaId),
    downloadMedia: (mediaId, destination) => getMedia(mediaId, destination),
    async uploadMedia(source) {
      const output = await call("PostWhatsAppMessageMedia", () =>
        client().send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: options.originationPhoneNumberId(), sourceS3File: { bucketName: source.bucket, key: source.key } })),
      );
      if (output.mediaId === undefined) throw new ChannelError("SEND_FAILED", "WHATSAPP", "PostWhatsAppMessageMedia returned no media id");
      return { mediaId: output.mediaId };
    },
  };
}

/** Test seam. */
export function resetSocialMessagingClient(): void {
  sharedClient = undefined;
}
