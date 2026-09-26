// Inbound media (docs/architecture-integrations.md §4.1-§4.3; FL-017, FL-018, FL-046). What a message
// carries is classified first; only a voice note (`audio/ogg`, ≤ 16 MB) and a photo (`image/jpeg` or
// `image/png`, ≤ 3.75 MB) go on, everything else gets a fixed reply. Every key is built by code
// (@cuadrilla/shared/media/keys), never from a name the sender chose:
//
//   live       `GetWhatsAppMessageMedia` with the AWS id of our number, first `metadataOnly` (type and
//              size, nothing downloaded), then into `Media/wa/<sha256(wamid)>/<sha256(mediaId)>`
//   simulated  `sim-media:<uploadId>`: the key comes from `Runtime/UPLOAD#` (same world, same kind,
//              `simMediaKey` of the world's current epoch), never from the client
//
// Then size and magic bytes are checked on the stored object; an object that fails is deleted. The
// duration of a voice note (≤ 120 s) is read by the transcription (packages/bff/src/media/).
import { simMediaKey, waMediaKey } from "@cuadrilla/shared/media/keys";
import type { WorldRuntimePort } from "../../connector/ports";
import type { MessageMedia } from "../../domain/conversations";
import type { SocialMessagingPort } from "./client";
import { IMAGE_TYPES, LIVE_AUDIO_TYPES, MEDIA_LIMITS, SIMULATOR_AUDIO_TYPES } from "./config";
import type { MediaStore } from "./media-store";
import { AudioMessage, ButtonMessage, ImageMessage, type InboundMessage, InteractiveMessage, TextMessage } from "./payloads";
import { uploadIdOf } from "./sim-envelope";

/** What an inbound message is, for the channel. */
export type InboundContent =
  | { readonly kind: "TEXT"; readonly text: string }
  /** A template quick reply or an interactive reply: the payload is a nonce. */
  | { readonly kind: "BUTTON"; readonly payload: string; readonly title: string }
  | { readonly kind: "VOICE"; readonly mediaId: string; readonly mimeType: string }
  | { readonly kind: "IMAGE"; readonly mediaId: string; readonly mimeType: string; readonly caption?: string }
  | { readonly kind: "UNSUPPORTED"; readonly type: string };

export function contentOf(message: InboundMessage): InboundContent {
  const text = TextMessage.safeParse(message);
  if (text.success) return { kind: "TEXT", text: text.data.text.body };
  const button = ButtonMessage.safeParse(message);
  if (button.success) return { kind: "BUTTON", payload: button.data.button.payload, title: button.data.button.text };
  const interactive = InteractiveMessage.safeParse(message);
  if (interactive.success) {
    const reply = interactive.data.interactive;
    const chosen = reply.type === "button_reply" ? reply.button_reply : reply.list_reply;
    return { kind: "BUTTON", payload: chosen.id, title: chosen.title };
  }
  const audio = AudioMessage.safeParse(message);
  if (audio.success) return { kind: "VOICE", mediaId: audio.data.audio.id, mimeType: audio.data.audio.mime_type };
  const image = ImageMessage.safeParse(message);
  if (image.success) {
    const { id, mime_type, caption } = image.data.image;
    return { kind: "IMAGE", mediaId: id, mimeType: mime_type, ...(caption === undefined ? {} : { caption }) };
  }
  return { kind: "UNSUPPORTED", type: message.type };
}

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export function baseMimeType(mime: string | undefined): string {
  return (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The type the first bytes of a file prove, or `undefined`. */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x4f, 0x67, 0x67, 0x53)) return "audio/ogg";
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return "audio/webm";
  if (bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") return "audio/mp4";
  return undefined;
}

export type MediaNotice = "unsupportedMedia" | "imageTooLarge" | "imageUnreadable" | "voiceTooLong" | "voiceFailed";

export type MediaOutcome = { readonly ok: true; readonly media: MessageMedia } | { readonly ok: false; readonly notice: MediaNotice; readonly deleted: boolean };

export interface MediaDeps {
  readonly store: MediaStore;
  /** Physical name of the `Media` bucket. */
  readonly mediaBucket: () => string;
  /** Live only. */
  readonly social?: SocialMessagingPort;
  readonly worlds: Pick<WorldRuntimePort, "getUpload">;
}

export interface MediaRequest {
  readonly origin: "LIVE" | "SIMULATED";
  readonly clockId: string;
  readonly worldEpoch: number;
  /** `wamid` of the message (the live key is derived from it). */
  readonly wamid: string;
  readonly content: Extract<InboundContent, { kind: "VOICE" | "IMAGE" }>;
}

const MAGIC_BYTES = 16;

function refuse(content: MediaRequest["content"], problem: "TYPE" | "SIZE" | "BYTES", deleted: boolean): MediaOutcome {
  if (problem === "TYPE") return { ok: false, notice: "unsupportedMedia", deleted };
  if (content.kind === "VOICE") return { ok: false, notice: problem === "SIZE" ? "voiceTooLong" : "voiceFailed", deleted };
  return { ok: false, notice: problem === "SIZE" ? "imageTooLarge" : "imageUnreadable", deleted };
}

function limitOf(request: MediaRequest): number {
  if (request.content.kind === "VOICE") return MEDIA_LIMITS.audioBytes;
  return request.origin === "LIVE" ? MEDIA_LIMITS.imageBytes : MEDIA_LIMITS.simulatorImageBytes;
}

function allowedTypes(request: MediaRequest): readonly string[] {
  if (request.content.kind === "IMAGE") return request.origin === "LIVE" ? IMAGE_TYPES : ["image/jpeg"];
  return request.origin === "LIVE" ? LIVE_AUDIO_TYPES : SIMULATOR_AUDIO_TYPES;
}

/** Size and magic bytes of the stored object; deletes it when it fails. */
async function checkStored(request: MediaRequest, key: string, maxBytes: number, deps: MediaDeps): Promise<MediaOutcome> {
  const location = { bucket: deps.mediaBucket(), key };
  const stored = await deps.store.head(location);
  if (stored === undefined) return refuse(request.content, "BYTES", false);
  const reject = async (problem: "TYPE" | "SIZE" | "BYTES"): Promise<MediaOutcome> => {
    await deps.store.delete(location);
    return refuse(request.content, problem, true);
  };
  if (stored.bytes > maxBytes) return reject("SIZE");
  const declared = baseMimeType(stored.contentType ?? request.content.mimeType);
  if (!allowedTypes(request).includes(declared)) return reject("TYPE");
  if (sniffMediaType(await deps.store.readStart(location, MAGIC_BYTES)) !== declared) return reject("BYTES");
  return { ok: true, media: { kind: request.content.kind === "VOICE" ? "AUDIO" : "IMAGE", s3Key: key, mime: declared, bytes: stored.bytes } };
}

async function fetchLive(request: MediaRequest, deps: MediaDeps): Promise<MediaOutcome> {
  const social = deps.social;
  if (social === undefined) throw new Error("live media needs the End User Messaging Social client");
  if (!allowedTypes(request).includes(baseMimeType(request.content.mimeType))) return refuse(request.content, "TYPE", false);
  const metadata = await social.mediaMetadata(request.content.mediaId);
  if (metadata.fileSize !== undefined && metadata.fileSize > limitOf(request)) return refuse(request.content, "SIZE", false);
  if (metadata.mimeType !== undefined && !allowedTypes(request).includes(baseMimeType(metadata.mimeType))) return refuse(request.content, "TYPE", false);
  const key = waMediaKey(request.wamid, request.content.mediaId);
  await social.downloadMedia(request.content.mediaId, { bucket: deps.mediaBucket(), key });
  return checkStored(request, key, limitOf(request), deps);
}

async function fetchSimulated(request: MediaRequest, deps: MediaDeps): Promise<MediaOutcome> {
  const uploadId = uploadIdOf(request.content.mediaId);
  if (uploadId === undefined) return refuse(request.content, "BYTES", false);
  const upload = await deps.worlds.getUpload(uploadId);
  const kind = request.content.kind === "VOICE" ? "VOICE" : "PHOTO";
  if (upload === undefined || upload.clockId !== request.clockId || upload.kind !== kind) return refuse(request.content, "BYTES", false);
  const key = simMediaKey(request.clockId, request.worldEpoch, uploadId);
  if (upload.key !== key) return refuse(request.content, "BYTES", false);
  return checkStored(request, key, Math.min(upload.maxBytes, limitOf(request)), deps);
}

/** Brings the media of a voice note or a photo into `Media/`, checked; or the fixed notice to answer with. */
export function fetchInboundMedia(request: MediaRequest, deps: MediaDeps): Promise<MediaOutcome> {
  return request.origin === "LIVE" ? fetchLive(request, deps) : fetchSimulated(request, deps);
}
