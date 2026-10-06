// Duration of a voice note from its container (docs/architecture-integrations.md §5, step 1): Ogg/Opus
// from WhatsApp and Polly (last granule position), WebM/Opus and MP4/AAC from the browser recorder
// (Segment Info and the audio track's media header). The parser is `music-metadata`, bounded here: it
// only ever sees bytes already capped at the channel's 16 MB, reads no tags or covers, and a container
// it cannot measure (a browser WebM without its Duration element, a truncated or forged file) is
// `undefined`, never an exception: the size then stands in for the duration.
import { parseBuffer } from "music-metadata";
import { sniffMediaType } from "../channels/whatsapp/media";
import { VOICE_LIMITS, type VoiceMime } from "./config";

/** Seconds of audio the container declares, or `undefined` when it cannot be read. */
export async function containerDurationSec(bytes: Uint8Array, mime: VoiceMime): Promise<number | undefined> {
  if (bytes.length === 0 || bytes.length > VOICE_LIMITS.maxBytes) return undefined;
  try {
    const metadata = await parseBuffer(bytes, { mimeType: mime, size: bytes.length }, { duration: true, skipCovers: true });
    const duration = metadata.format.duration;
    return duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : undefined;
  } catch {
    return undefined;
  }
}

export type VoiceLimitVerdict =
  | { readonly ok: true; readonly durationSec?: number }
  | { readonly ok: false; readonly reason: "TOO_LONG"; readonly durationSec?: number }
  | { readonly ok: false; readonly reason: "NOT_AUDIO" };

/**
 * ≤ 120 s by the container; when the container says nothing, ≤ 2 MB. The first bytes must prove the
 * declared type (the channel checked them once; this read is a second, independent one).
 */
export async function checkVoiceLimits(bytes: Uint8Array, mime: VoiceMime): Promise<VoiceLimitVerdict> {
  if (sniffMediaType(bytes) !== mime) return { ok: false, reason: "NOT_AUDIO" };
  const durationSec = await containerDurationSec(bytes, mime);
  if (durationSec === undefined) return bytes.length > VOICE_LIMITS.unknownDurationMaxBytes ? { ok: false, reason: "TOO_LONG" } : { ok: true };
  return durationSec > VOICE_LIMITS.maxSeconds ? { ok: false, reason: "TOO_LONG", durationSec } : { ok: true, durationSec };
}

/** Seconds reserved against the transcription caps: the measured duration, or the longest allowed. */
export function reservedSeconds(durationSec: number | undefined): number {
  if (durationSec === undefined) return VOICE_LIMITS.maxSeconds;
  return Math.min(VOICE_LIMITS.maxSeconds, Math.max(1, Math.ceil(durationSec)));
}
