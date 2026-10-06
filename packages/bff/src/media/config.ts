// Fixed values of the voice-note transcription (docs/architecture-integrations.md §5, docs/architecture.md
// §9.7, ADR-0006): limits, polling, the confidence threshold, the job name derived from the message and
// what the `Transcribe` Linkable of infra/media.ts carries (vocabulary, language, job prefix, output
// bucket and prefix, tags). Pure module: the scenario runner imports `transcriptionJobName` to find the
// job of a message.
import { createHash } from "node:crypto";
import { z } from "zod";
import { VOCABULARY_NAME } from "../copy/transcribe-vocabulary";
import { readLinked } from "../lib/resource";

const MIB = 1024 * 1024;

export const VOICE_LIMITS = {
  /** Longest voice note that is transcribed ("Manda notas de voz de menos de 2 minutos"). */
  maxSeconds: 120,
  /** When the container's duration cannot be read, the size stands in for it. */
  unknownDurationMaxBytes: 2 * MIB,
  /** Largest voice note the channel accepts (docs/architecture-integrations.md §4.1). */
  maxBytes: 16 * MIB,
} as const;

export const TRANSCRIBE_POLL = {
  intervalMs: 1_500,
  timeoutMs: 90_000,
} as const;

/** The output JSON is read only up to this size. */
export const MAX_TRANSCRIPT_OUTPUT_BYTES = 1 * MIB;

/** Average confidence of the pronounced words below which the note is not understood (FL-018 a). */
export const MIN_TRANSCRIPT_CONFIDENCE = 0.55;

/** `Transcript.text` of a message holds at most this many characters (domain/conversations.ts). */
export const MAX_TRANSCRIPT_CHARS = 4_000;

export const TRANSCRIBE_LANGUAGE_CODE = "es-MX";

/** Prefix of every job of this app: the IAM fence (`transcription-job/cuadrilla-poc-*`) expects it. */
export const TRANSCRIBE_JOB_PREFIX = "cuadrilla-poc-";

/** `StartTranscriptionJob.MediaFormat` of each voice-note type the channel lets through. */
const MEDIA_FORMATS = {
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/mp4": "mp4",
} as const;

export type VoiceMime = keyof typeof MEDIA_FORMATS;
export type VoiceMediaFormat = (typeof MEDIA_FORMATS)[VoiceMime];

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
function baseMime(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** The voice-note type of a MIME type (parameters ignored), or `undefined` when it is not one. */
export function voiceMimeOf(mime: string): VoiceMime | undefined {
  const base = baseMime(mime);
  return Object.hasOwn(MEDIA_FORMATS, base) ? (base as VoiceMime) : undefined;
}

export function mediaFormatOf(mime: VoiceMime): VoiceMediaFormat {
  return MEDIA_FORMATS[mime];
}

const MessageIdShape = z.string().min(1).max(256);

/**
 * `cuadrilla-poc-<sha256(clockId ‖ worldEpoch ‖ messageId)>[0:32]`: idempotent per message (a retry of
 * the same event finds its own job) and distinct per world and epoch (two worlds that send the same
 * synthetic file at once never share a job). `‖` is a `|`, which no clock id or message id carries.
 */
export function transcriptionJobName(clockId: string, worldEpoch: number, messageId: string): string {
  if (clockId.length === 0) throw new RangeError("clockId must not be empty");
  if (!Number.isInteger(worldEpoch) || worldEpoch < 0) throw new RangeError(`worldEpoch must be a non-negative integer, got ${worldEpoch}`);
  const id = MessageIdShape.parse(messageId);
  const digest = createHash("sha256").update(`${clockId}|${worldEpoch}|${id}`, "utf8").digest("hex");
  return `${TRANSCRIBE_JOB_PREFIX}${digest.slice(0, 32)}`;
}

const JobTag = z.object({ Key: z.string().min(1).max(128), Value: z.string().max(256) }).strict();

/** Properties of the `Transcribe` Linkable (infra/media.ts). */
export const TranscribeConfig = z.object({
  vocabularyName: z.string().regex(/^cuadrilla-poc-[0-9A-Za-z._-]{1,186}$/),
  languageCode: z.literal(TRANSCRIBE_LANGUAGE_CODE),
  jobNamePrefix: z.literal(TRANSCRIBE_JOB_PREFIX),
  outputBucket: z.string().min(3).max(63),
  outputPrefix: z.literal("transcripts/"),
  jobTags: z.array(JobTag).min(1).max(50),
});
export type TranscribeConfig = z.infer<typeof TranscribeConfig>;

export function linkedTranscribeConfig(): TranscribeConfig {
  return readLinked("Transcribe", TranscribeConfig);
}

/** The configuration of the tests and the local flows (the deployed one comes from the link). */
export function localTranscribeConfig(outputBucket: string): TranscribeConfig {
  return {
    vocabularyName: VOCABULARY_NAME,
    languageCode: TRANSCRIBE_LANGUAGE_CODE,
    jobNamePrefix: TRANSCRIBE_JOB_PREFIX,
    outputBucket,
    outputPrefix: "transcripts/",
    jobTags: [{ Key: "Project", Value: "aws-cds-hackathon-poc-cuadrilla" }],
  };
}
