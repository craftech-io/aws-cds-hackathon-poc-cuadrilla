// `transcribe_voice_note` (docs/tool-catalog.md; docs/architecture-integrations.md §5; docs/architecture.md
// §7 and §9.7; FL-017, FL-018, FL-099 c): the `InstallerWorker` calls it inside the installer's FIFO
// message, before the safety classifier and the turn, so the transcript enters the envelope as
// `VOICE_TRANSCRIPT` with its confidence. Deterministic, never seen by the model.
//
//   1. Limits. The voice note is read from `Media/` (≤ 16 MB), its first bytes must prove its type, and
//      its container's duration must be ≤ 120 s (≤ 2 MB when the container says nothing); otherwise
//      the object is deleted and the installer gets "menos de 2 minutos", with no job.
//   2. Spend. The kill switch (`KILL#AGENT`) and one conditional reservation of the world's cap and the
//      stage's ceiling (`SIMCAP#…#transcribe`, `TRANSCRIBE#GLOBAL`), idempotent per job, before any call.
//   3. Job `cuadrilla-poc-<sha256(clockId ‖ worldEpoch ‖ messageId)>[0:32]`, input `mediaFileUri`, output
//      `transcriptOutputKey` (@cuadrilla/shared/media/keys: never the raw clock id, which carries `#`).
//      `ConflictException` → the existing job is this message's own and is polled.
//   4. Poll every 1.5 s up to 90 s. `NotFoundException` (deleted by an earlier attempt of the same event)
//      → the output is read if it still exists, else the job is started again once.
//   5. The output JSON (≤ 1 MB) is read by S3, masked, and deleted at once (the one-day lifecycle of
//      `Media/transcripts/` is the backstop); then the job is deleted.
//   6. Empty text or confidence < 0.55 → "No te entendí bien…" (`TranscribeLowConfidence`, `LOW_CONFIDENCE`).
//
// Injected failures exist only for `qa-*` worlds (media/faults.ts). Logs carry ids, hashes and numbers,
// never the transcript.
import { mediaFileUri, transcriptOutputKey } from "@cuadrilla/shared/media/keys";
import type { CopyPack } from "../copy/types";
import { type Clock, systemClock } from "../lib/clock";
import type { Logger } from "../lib/log";
import { type CapLedger, type CostCapsDeps, releaseCost, reserveCost } from "../ops/cost-caps";
import { MAX_TRANSCRIPT_OUTPUT_BYTES, TRANSCRIBE_POLL, type TranscribeConfig, VOICE_LIMITS, mediaFormatOf, transcriptionJobName, voiceMimeOf } from "./config";
import { checkVoiceLimits, reservedSeconds } from "./duration";
import { type TranscribeFaultReader, faultyTranscribe } from "./faults";
import { type MediaObjectsPort, type ObjectLocation, ObjectTooLargeError } from "./objects";
import { type JobRun, runTranscriptionJob } from "./job";
import type { TranscribePort } from "./transcribe-client";
import { type ReadTranscript, readTranscript } from "./transcript";

/** Fixed texts the installer may get instead of a turn (copy/es-MX.ts). */
export type VoiceNotice = Extract<keyof CopyPack, "voiceTooLong" | "voiceUnclear" | "voiceFailed" | "servicePaused" | "turnCap">;

export type VoiceNoteFailure =
  | "UNSUPPORTED_FORMAT"
  | "MEDIA_MISSING"
  | "NOT_AUDIO"
  | "TOO_LONG"
  | "KILL_SWITCH_ACTIVE"
  | "CAP_REACHED"
  | "START_FAILED"
  | "JOB_FAILED"
  | "POLL_FAILED"
  | "TIMEOUT"
  | "JOB_LOST"
  | "OUTPUT_UNREADABLE"
  | "LOW_CONFIDENCE";

/** Ledgers a transcription takes: the world's cap and the stage's ceiling (ADR-0019). */
export const TRANSCRIBE_LEDGERS: readonly CapLedger[] = ["SIMULATOR", "GLOBAL"];

export interface VoiceNoteRequest {
  readonly clockId: string;
  readonly worldEpoch: number;
  /** Id of the inbound message (`wamid` of Meta or of the simulator). */
  readonly messageId: string;
  /** The stored voice note, as the channel checked it (`Message.media`). */
  readonly media: { readonly s3Key: string; readonly mime: string };
  /** `Isps/SETTINGS` of the world's operator (only its cap fields are read). */
  readonly settings: unknown;
}

export type VoiceNoteOutcome =
  | {
      readonly ok: true;
      readonly transcript: { readonly text: string; readonly confidence: number };
      readonly durationSec?: number;
      readonly jobName: string;
      readonly maskedKinds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly notice: VoiceNotice;
      readonly reason: VoiceNoteFailure;
      readonly jobName?: string;
      readonly durationSec?: number;
      /** The voice note was deleted from `Media/` (out of limits). */
      readonly mediaDeleted?: boolean;
      readonly confidence?: number;
    };

/** `ACTION TRANSCRIBED` / `LOW_CONFIDENCE` (docs/tool-catalog.md); the worker writes the `AuditLog` row. */
export interface TranscriptionAuditEvent {
  readonly action: "TRANSCRIBED" | "LOW_CONFIDENCE";
  readonly clockId: string;
  readonly messageId: string;
  readonly jobName: string;
  readonly confidence: number;
  readonly durationSec?: number;
  readonly maskedKinds: readonly string[];
}

export interface VoiceNoteDeps {
  readonly transcribe: TranscribePort;
  readonly objects: MediaObjectsPort;
  readonly config: () => TranscribeConfig;
  /** Physical name of the `Media` bucket (where the voice notes are). */
  readonly mediaBucket: () => string;
  /** `reserve_cost` with the kill switch reader (ops/cost-caps.ts). */
  readonly costs: CostCapsDeps;
  readonly faults?: TranscribeFaultReader;
  /** Real time: the poll deadline and the latency. */
  readonly realClock?: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  /** At most 90 s; the worker may pass less when its message budget is shorter. */
  readonly pollTimeoutMs?: number;
  readonly audit?: (event: TranscriptionAuditEvent) => Promise<void>;
  readonly logger?: Logger;
}

function failure(notice: VoiceNotice, reason: VoiceNoteFailure, extra: Omit<Extract<VoiceNoteOutcome, { ok: false }>, "ok" | "notice" | "reason"> = {}): VoiceNoteOutcome {
  return { ok: false, notice, reason, ...extra };
}

async function bestEffort(logger: Logger | undefined, what: string, run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    logger?.warn(`transcription cleanup failed: ${what}`, { error });
    return false;
  }
}

/** Reads the voice note and applies the limits; deletes it when it is out of them. */
async function measure(deps: VoiceNoteDeps, location: ObjectLocation, mime: NonNullable<ReturnType<typeof voiceMimeOf>>): Promise<VoiceNoteOutcome | { readonly durationSec?: number }> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await deps.objects.read(location, VOICE_LIMITS.maxBytes);
  } catch (error) {
    if (!(error instanceof ObjectTooLargeError)) throw error;
    const mediaDeleted = await bestEffort(deps.logger, "voice note", () => deps.objects.delete(location));
    return failure("voiceTooLong", "TOO_LONG", { mediaDeleted });
  }
  if (bytes === undefined) return failure("voiceFailed", "MEDIA_MISSING");
  const verdict = await checkVoiceLimits(bytes, mime);
  if (verdict.ok) return verdict.durationSec === undefined ? {} : { durationSec: verdict.durationSec };
  if (verdict.reason === "NOT_AUDIO") return failure("voiceFailed", "NOT_AUDIO");
  const mediaDeleted = await bestEffort(deps.logger, "voice note", () => deps.objects.delete(location));
  deps.logger?.info("voice note too long", { action: "VOICE_TOO_LONG", metric: "VoiceTooLong", durationSec: verdict.durationSec, bytes: bytes.length });
  return failure("voiceTooLong", "TOO_LONG", { mediaDeleted, ...(verdict.durationSec === undefined ? {} : { durationSec: verdict.durationSec }) });
}

async function portFor(deps: VoiceNoteDeps, clockId: string): Promise<TranscribePort> {
  if (deps.faults === undefined) return deps.transcribe;
  try {
    const fault = await deps.faults.transcribeFault(clockId);
    if (fault === undefined) return deps.transcribe;
    deps.logger?.info("transcribe fault injected", { fault, clockId });
    return faultyTranscribe(fault);
  } catch (error) {
    deps.logger?.warn("transcribe faults unreadable; no fault applied", { error, clockId });
    return deps.transcribe;
  }
}

const RUN_FAILURES: Readonly<Record<Exclude<JobRun["kind"], "OUTPUT">, VoiceNoteFailure>> = {
  START_FAILED: "START_FAILED",
  JOB_FAILED: "JOB_FAILED",
  POLL_FAILED: "POLL_FAILED",
  TIMEOUT: "TIMEOUT",
  JOB_LOST: "JOB_LOST",
  OUTPUT_TOO_LARGE: "OUTPUT_UNREADABLE",
};

/** `transcribe_voice_note`: the transcript of one voice note, or the fixed notice to answer with. */
export async function transcribeVoiceNote(deps: VoiceNoteDeps, request: VoiceNoteRequest): Promise<VoiceNoteOutcome> {
  const realClock = deps.realClock ?? systemClock;
  const mime = voiceMimeOf(request.media.mime);
  if (mime === undefined) return failure("voiceFailed", "UNSUPPORTED_FORMAT");
  const bucket = deps.mediaBucket();
  const media: ObjectLocation = { bucket, key: request.media.s3Key };
  const measured = await measure(deps, media, mime);
  if ("ok" in measured) return measured;
  const { durationSec } = measured;
  const withDuration = durationSec === undefined ? {} : { durationSec };

  const jobName = transcriptionJobName(request.clockId, request.worldEpoch, request.messageId);
  const reservation = await reserveCost(deps.costs, {
    world: { clockId: request.clockId, settings: request.settings },
    resource: "transcribe",
    amount: reservedSeconds(durationSec),
    reserve: TRANSCRIBE_LEDGERS,
    surface: "AGENT",
    idempotencyKey: `TRANSCRIBE#${jobName}`,
  });
  if (!reservation.ok) {
    return reservation.code === "KILL_SWITCH_ACTIVE" ? failure("servicePaused", "KILL_SWITCH_ACTIVE", { jobName }) : failure("turnCap", "CAP_REACHED", { jobName });
  }

  const config = deps.config();
  const output: ObjectLocation = { bucket: config.outputBucket, key: transcriptOutputKey(request.clockId, request.worldEpoch, request.messageId, jobName) };
  const port = await portFor(deps, request.clockId);
  const startedAt = (await realClock.now()).getTime();
  const run = await runTranscriptionJob(
    { transcribe: port, objects: deps.objects, realClock, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }), ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
    {
      job: { jobName, mediaFileUri: mediaFileUri(bucket, media.key), mediaFormat: mediaFormatOf(mime), outputKey: output.key },
      output,
      maxOutputBytes: MAX_TRANSCRIPT_OUTPUT_BYTES,
      pollTimeoutMs: Math.min(deps.pollTimeoutMs ?? TRANSCRIBE_POLL.timeoutMs, TRANSCRIBE_POLL.timeoutMs),
    },
  );
  const latencyMs = (await realClock.now()).getTime() - startedAt;

  let transcript: ReadTranscript | undefined;
  if (run.kind === "OUTPUT") {
    try {
      transcript = readTranscript(run.bytes);
    } catch (error) {
      deps.logger?.warn("transcribe output unreadable", { error, jobName });
    }
  }
  await bestEffort(deps.logger, "transcript output", () => deps.objects.delete(output));
  await bestEffort(deps.logger, "transcription job", () => port.delete(jobName));
  deps.logger?.info("transcription job finished", { action: "TRANSCRIBE_DONE", metric: "TranscribeLatency", latencyMs, jobName, result: run.kind });

  if (run.kind !== "OUTPUT") {
    if (run.kind === "START_FAILED" && !run.spent) await releaseCost(deps.costs, reservation.reserved);
    deps.logger?.warn("voice note not transcribed", { action: "TRANSCRIBE_FAILED", reason: RUN_FAILURES[run.kind], jobName, clockId: request.clockId });
    return failure("voiceFailed", RUN_FAILURES[run.kind], { jobName, ...withDuration });
  }
  if (transcript === undefined) return failure("voiceFailed", "OUTPUT_UNREADABLE", { jobName, ...withDuration });

  const event = { clockId: request.clockId, messageId: request.messageId, jobName, confidence: transcript.confidence, maskedKinds: transcript.maskedKinds, ...withDuration };
  if (transcript.unclear) {
    deps.logger?.info("voice note unclear", { action: "LOW_CONFIDENCE", metric: "TranscribeLowConfidence", confidence: transcript.confidence, empty: transcript.text.length === 0, jobName });
    await deps.audit?.({ action: "LOW_CONFIDENCE", ...event });
    return failure("voiceUnclear", "LOW_CONFIDENCE", { jobName, confidence: transcript.confidence, ...withDuration });
  }
  await deps.audit?.({ action: "TRANSCRIBED", ...event });
  return { ok: true, transcript: { text: transcript.text, confidence: transcript.confidence }, jobName, maskedKinds: transcript.maskedKinds, ...withDuration };
}
