// In-process stand-ins for the transcription (never imported by runtime code): the unit tests of this
// folder and the local flows (tests/flows, "Transcribe falso con salidas de fixture") run on them. The
// fake Transcribe behaves like the service where the voice-note flow depends on it: a job name is taken
// until the job is deleted (`EXISTS`), a deleted job is `undefined` (NotFound), and a completed job
// writes its output JSON, in the service's format, under the request's `OutputKey`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StartTranscriptionJobCommandInput } from "@aws-sdk/client-transcribe";
import { type TranscribeConfig, localTranscribeConfig } from "./config";
import { ObjectTooLargeError, type MediaObjectsPort, type ObjectLocation } from "./objects";
import { type StartJobRequest, type TranscribePort, type TranscriptionJobSnapshot, startJobInput } from "./transcribe-client";

export const TEST_MEDIA_BUCKET = "aws-cds-hackathon-poc-cuadrilla-poc-media-test";

export const TEST_TRANSCRIBE_CONFIG: TranscribeConfig = localTranscribeConfig(TEST_MEDIA_BUCKET);

export interface MemoryMediaObjects extends MediaObjectsPort {
  readonly objects: Map<string, Uint8Array>;
  readonly deleted: string[];
  put(location: ObjectLocation, bytes: Uint8Array | string): void;
  has(location: ObjectLocation): boolean;
}

const at = (location: ObjectLocation): string => `${location.bucket}/${location.key}`;

export function createMemoryMediaObjects(): MemoryMediaObjects {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    put: (location, bytes) => void objects.set(at(location), typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes),
    has: (location) => objects.has(at(location)),
    async read(location, maxBytes) {
      const bytes = objects.get(at(location));
      if (bytes !== undefined && bytes.length > maxBytes) throw new ObjectTooLargeError(maxBytes);
      return bytes;
    },
    async delete(location) {
      deleted.push(at(location));
      objects.delete(at(location));
    },
  };
}

/** Output JSON of a job in Transcribe's format: one `pronunciation` item per word, then the period. */
export function transcribeOutputJson(jobName: string, text: string, confidence: number): string {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const items = words.map((word) => ({ type: "pronunciation", alternatives: [{ confidence: confidence.toFixed(4), content: word.replace(/[.,;?!]/g, "") }], start_time: "0.0", end_time: "0.5" }));
  return JSON.stringify({
    jobName,
    accountId: "776805327629",
    status: "COMPLETED",
    results: { transcripts: [{ transcript: text }], items: [...items, ...(words.length > 0 ? [{ type: "punctuation", alternatives: [{ confidence: "0.0", content: "." }] }] : [])] },
  });
}

/** What a fake job produces: a transcript, a failure, or nothing ever (stays IN_PROGRESS). */
export type FakeJobScript = { readonly text: string; readonly confidence: number } | "FAILED" | "NEVER";

export interface FakeTranscribeOptions {
  readonly objects: MemoryMediaObjects;
  readonly config?: TranscribeConfig;
  /** The result of a job from its request; by default a clear transcript. */
  readonly script?: (input: StartTranscriptionJobCommandInput) => FakeJobScript;
  /** `get` calls that answer IN_PROGRESS before the job completes. */
  readonly pollsBeforeDone?: number;
}

export interface FakeTranscribe extends TranscribePort {
  /** Every accepted `StartTranscriptionJob` request, exactly as the SDK would receive it. */
  readonly started: StartTranscriptionJobCommandInput[];
  /** Every `start` call, including the ones answered `EXISTS`. */
  readonly startCalls: string[];
  readonly deletedJobs: string[];
  readonly jobs: ReadonlyMap<string, { readonly input: StartTranscriptionJobCommandInput; polls: number }>;
  /** Drops a job as another attempt of the same event would have (`DeleteTranscriptionJob`). */
  forget(jobName: string): void;
}

export function createFakeTranscribe(options: FakeTranscribeOptions): FakeTranscribe {
  const config = options.config ?? TEST_TRANSCRIBE_CONFIG;
  const script = options.script ?? (() => ({ text: "Ya estoy con la señora Treviño, la ONU no prende la luz PON.", confidence: 0.93 }));
  const pollsBeforeDone = options.pollsBeforeDone ?? 1;
  const jobs = new Map<string, { input: StartTranscriptionJobCommandInput; polls: number; written: boolean }>();
  const started: StartTranscriptionJobCommandInput[] = [];
  const startCalls: string[] = [];
  const deletedJobs: string[] = [];

  return {
    started,
    startCalls,
    deletedJobs,
    jobs,
    forget: (jobName) => void jobs.delete(jobName),
    async start(request: StartJobRequest) {
      startCalls.push(request.jobName);
      if (jobs.has(request.jobName)) return "EXISTS";
      const input = startJobInput(config, request);
      started.push(input);
      jobs.set(request.jobName, { input, polls: 0, written: false });
      return "STARTED";
    },
    async get(jobName): Promise<TranscriptionJobSnapshot | undefined> {
      const job = jobs.get(jobName);
      if (job === undefined) return undefined;
      const outcome = script(job.input);
      if (outcome === "NEVER") return { status: "IN_PROGRESS" };
      job.polls += 1;
      if (job.polls <= pollsBeforeDone) return { status: job.polls === 1 ? "QUEUED" : "IN_PROGRESS" };
      if (outcome === "FAILED") return { status: "FAILED", failureReason: "The media file could not be decoded" };
      if (!job.written) {
        job.written = true;
        options.objects.put({ bucket: job.input.OutputBucketName ?? "", key: job.input.OutputKey ?? "" }, transcribeOutputJson(jobName, outcome.text, outcome.confidence));
      }
      return { status: "COMPLETED" };
    },
    async delete(jobName) {
      deletedJobs.push(jobName);
      jobs.delete(jobName);
    },
  };
}

// ---- Voice-note bytes ------------------------------------------------------------------------------

/** A synthetic voice note of scripts/seed/audio (Polly es-MX, docs/seed-spec.md): `vn-01` 3.2 s, `vn-10` 159 s. */
export function seedVoiceNote(voiceId: `vn-${string}`): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../../scripts/seed/audio/${voiceId}.ogg`, import.meta.url))));
}

// Half a second of silence, AAC in MP4 (8 kHz mono), encoded for these tests: the shape a Safari
// recording has (`ftyp` M4A, `moov` with the audio track's `mdhd`).
const SILENT_M4A_BASE64 =
  "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAtZtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAB9AAAAPoAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACJXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAPoAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAD6AAAAQAAAEAAAAAAZ1tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAB9AAAAToFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAFIbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEMc3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAB9AAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAB9AAAAA/gWAgIAFFYhW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAABAAABAAAAAABAAADoAAAABxzdHNjAAAAAAAAAAEAAAABAAAABQAAAAEAAAAUc3RzegAAAAAAAAAEAAAABQAAABRzdGNvAAAAAAAAAAEAAAMCAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAAAUAAAABAAAAPXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdAAAAAhmcmVlAAAAHG1kYXQBGCAHARggBwEYIAcBGCAHARggBw==";

/** The MP4 recording with its audio track's declared duration set to `seconds`. */
export function m4aVoiceNote(seconds: number): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(SILENT_M4A_BASE64, "base64"));
  const mdhd = Buffer.from(bytes).indexOf("mdhd");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Version 0 `mdhd`: flags, creation, modification, then timescale and duration.
  const timescale = view.getUint32(mdhd + 16);
  view.setUint32(mdhd + 20, Math.round(seconds * timescale));
  return bytes;
}

/** A WebM header (EBML + Segment Info) like the browser recorder's, with or without its Duration. */
export function webmVoiceNote(seconds?: number): Uint8Array {
  const size = (length: number): number[] => [0x01, 0, 0, 0, (length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255];
  const element = (id: number[], body: number[]): number[] => [...id, ...size(body.length), ...body];
  const float64 = (value: number): number[] => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    return [...new Uint8Array(view.buffer)];
  };
  const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
  const header = element([0x1a, 0x45, 0xdf, 0xa3], [...element([0x42, 0x82], ascii("webm")), ...element([0x42, 0x87], [4]), ...element([0x42, 0x85], [2])]);
  const info = element([0x15, 0x49, 0xa9, 0x66], [...element([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), ...(seconds === undefined ? [] : element([0x44, 0x89], float64(seconds * 1_000)))]);
  return new Uint8Array([...header, ...element([0x18, 0x53, 0x80, 0x67], info)]);
}
