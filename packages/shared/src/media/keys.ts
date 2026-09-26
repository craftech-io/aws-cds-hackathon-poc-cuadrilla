// Object keys of the Media bucket that Transcribe and End User Messaging Social read or write
// (docs/architecture.md §6, "Claves de media"): the one place the inbound WhatsApp handler, the phone
// simulator and the voice-note transcription agree on them.
//
//   wa/<sha256(wamid)[0:32]>/<sha256(mediaId)[0:16]>                 live WhatsApp media
//   sim/<seg>/<uploadId>                                              phone simulator uploads
//   transcripts/<seg>/<sha256(messageId)[0:32]>/<jobName>.json        Transcribe output, one per message
//   seg = mediaKeySegment(clockId, worldEpoch) = sha256(clockId)[0:16] + "-e" + worldEpoch
//
// Clock ids carry `#` (`GLOBAL#isp-demo`, `JUDGE#isp-judge-07`), which opens a fragment in an `s3://`
// URI and is outside what Transcribe accepts as `OutputKey`; a live `wamid` is base64 and may carry
// `=`, `+` or `/`. So no raw clock id, `wamid` or media id ever reaches a key: they are hashed.
// This module uses node:crypto and lives on its own subpath (`@cuadrilla/shared/media/keys`), outside
// the index the console imports.
import { createHash } from "node:crypto";

/** What Transcribe accepts as `OutputKey` (StartTranscriptionJob). */
export const OUTPUT_KEY_PATTERN = /^[a-zA-Z0-9-_.!*'()/]{1,1024}$/;

// Keys this module builds, and the only ones `mediaFileUri` lets into a `MediaFileUri`.
const MEDIA_KEY = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
// S3 general purpose bucket names: 3-63 lower-case letters, digits, dots and hyphens.
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
// Simulator upload ids and Transcribe job names are ours: letters, digits, `_` and `-`.
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_NAME = /^[A-Za-z0-9_-]{1,200}$/;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function required(name: string, value: string): string {
  if (value.length === 0) throw new RangeError(`${name} must not be empty`);
  return value;
}

/** Segment of a world and its epoch: distinct worlds or epochs never share a prefix. */
export function mediaKeySegment(clockId: string, worldEpoch: number): string {
  if (!Number.isInteger(worldEpoch) || worldEpoch < 0) throw new RangeError(`worldEpoch must be a non-negative integer, got ${worldEpoch}`);
  return `${sha256Hex(required("clockId", clockId)).slice(0, 16)}-e${worldEpoch}`;
}

/** Destination of `GetWhatsAppMessageMedia` for a live message. */
export function waMediaKey(wamid: string, mediaId: string): string {
  return `wa/${sha256Hex(required("wamid", wamid)).slice(0, 32)}/${sha256Hex(required("mediaId", mediaId)).slice(0, 16)}`;
}

/** Key a simulator upload is pre-signed for (`Runtime/UPLOAD#<uploadId>` records it). */
export function simMediaKey(clockId: string, worldEpoch: number, uploadId: string): string {
  if (!UPLOAD_ID.test(uploadId)) throw new RangeError("uploadId must be 1-128 letters, digits, _ or -");
  return `sim/${mediaKeySegment(clockId, worldEpoch)}/${uploadId}`;
}

/** `OutputKey` of the transcription job of one message; a retry of the same message finds the same key. */
export function transcriptOutputKey(clockId: string, worldEpoch: number, messageId: string, jobName: string): string {
  if (!JOB_NAME.test(jobName)) throw new RangeError("jobName must be 1-200 letters, digits, _ or -");
  const key = `transcripts/${mediaKeySegment(clockId, worldEpoch)}/${sha256Hex(required("messageId", messageId)).slice(0, 32)}/${jobName}.json`;
  if (!OUTPUT_KEY_PATTERN.test(key)) throw new RangeError("transcript key outside the OutputKey pattern");
  return key;
}

/** `Media.MediaFileUri` of a transcription job; rejects any key this module would not build. */
export function mediaFileUri(bucket: string, key: string): string {
  if (!BUCKET.test(bucket) || bucket.includes("..")) throw new RangeError("invalid S3 bucket name");
  if (!MEDIA_KEY.test(key) || key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new RangeError("media key outside [A-Za-z0-9/_.-]");
  }
  return `s3://${bucket}/${key}`;
}
