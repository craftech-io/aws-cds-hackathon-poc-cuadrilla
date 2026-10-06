// The single Amazon Transcribe client (CLAUDE.md, "un cliente por servicio externo"; docs/architecture.md
// §9.7): start a batch job, read its status, delete it. Timeouts and the SDK's retries with backoff come
// from lib/clients.ts (`transcribe`: 5 s per attempt, 3 attempts); a throttled call is retried once more
// here with jittered backoff. Two answers are outcomes, not errors, because the voice-note flow depends
// on them (docs/architecture-integrations.md §5):
//
//   ConflictException at start    the job already exists: it is the one of the same message
//   NotFoundException at get      the job was deleted (by an earlier attempt of the same event)
//
// Every other failure becomes a `TranscribeError` whose message names the operation and the exception
// only, never the request (the job name is a hash; nothing personal goes to Transcribe but the audio).
import {
  DeleteTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  StartTranscriptionJobCommand,
  TranscribeClient,
  type StartTranscriptionJobCommandInput,
} from "@aws-sdk/client-transcribe";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { withRetry } from "../lib/retry";
import type { TranscribeConfig, VoiceMediaFormat } from "./config";

export type TranscribeErrorCode = "THROTTLED" | "INVALID" | "UNAVAILABLE" | "TIMEOUT" | "FAULT";

export class TranscribeError extends Error {
  override readonly name = "TranscribeError";
  readonly retryable: boolean;
  constructor(
    readonly code: TranscribeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.retryable = code === "THROTTLED" || code === "TIMEOUT";
  }
}

const ERROR_CODES: Readonly<Record<string, TranscribeErrorCode>> = {
  LimitExceededException: "THROTTLED",
  ThrottlingException: "THROTTLED",
  BadRequestException: "INVALID",
  ValidationException: "INVALID",
  InternalFailureException: "UNAVAILABLE",
  AccessDeniedException: "UNAVAILABLE",
  TimeoutError: "TIMEOUT",
  RequestTimeout: "TIMEOUT",
};

export function toTranscribeError(operation: string, error: unknown): TranscribeError {
  if (error instanceof TranscribeError) return error;
  const name = error instanceof Error ? error.name : "UnknownError";
  return new TranscribeError(ERROR_CODES[name] ?? "UNAVAILABLE", `${operation} failed: ${name}`, { cause: error });
}

/** Status of a job as the voice-note flow needs it. */
export type TranscriptionJobState = "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface TranscriptionJobSnapshot {
  readonly status: TranscriptionJobState;
  /** Transcribe's reason when `FAILED` (a fixed service text about the audio, never its content). */
  readonly failureReason?: string;
}

/** What one job is started with; every value is built by code (packages/bff/src/media/transcribe.ts). */
export interface StartJobRequest {
  readonly jobName: string;
  readonly mediaFileUri: string;
  readonly mediaFormat: VoiceMediaFormat;
  readonly outputKey: string;
}

export interface TranscribePort {
  /** `StartTranscriptionJob`; `EXISTS` when a job with this name is already there. */
  start(request: StartJobRequest): Promise<"STARTED" | "EXISTS">;
  /** `GetTranscriptionJob`; `undefined` when the job does not exist. */
  get(jobName: string): Promise<TranscriptionJobSnapshot | undefined>;
  /** `DeleteTranscriptionJob`; a job that no longer exists counts as deleted. */
  delete(jobName: string): Promise<void>;
}

/** The exact request of `StartTranscriptionJob` (exported for the test of its shape). */
export function startJobInput(config: TranscribeConfig, request: StartJobRequest): StartTranscriptionJobCommandInput {
  if (!request.jobName.startsWith(config.jobNamePrefix)) throw new RangeError(`job names start with ${config.jobNamePrefix}`);
  if (!request.outputKey.startsWith(config.outputPrefix)) throw new RangeError(`output keys start with ${config.outputPrefix}`);
  return {
    TranscriptionJobName: request.jobName,
    LanguageCode: config.languageCode,
    MediaFormat: request.mediaFormat,
    Media: { MediaFileUri: request.mediaFileUri },
    OutputBucketName: config.outputBucket,
    OutputKey: request.outputKey,
    Settings: { VocabularyName: config.vocabularyName },
    Tags: config.jobTags.map((tag) => ({ Key: tag.Key, Value: tag.Value })),
  };
}

const KNOWN_STATES: ReadonlySet<string> = new Set<TranscriptionJobState>(["QUEUED", "IN_PROGRESS", "COMPLETED", "FAILED"]);

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

export interface TranscribeClientOptions {
  readonly config: () => TranscribeConfig;
  readonly client?: TranscribeClient;
  /** Backoff of the extra retry of a throttled call; injected by the tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

let sharedClient: TranscribeClient | undefined;

function defaultClient(): TranscribeClient {
  sharedClient ??= new TranscribeClient({ region: "us-east-1", ...awsClientConfig(CLIENT_TIMEOUTS.transcribe) });
  return sharedClient;
}

export function createTranscribeClient(options: TranscribeClientOptions): TranscribePort {
  const client = (): TranscribeClient => options.client ?? defaultClient();
  const call = <T>(operation: string, run: () => Promise<T>): Promise<T> =>
    withRetry(
      async () => {
        try {
          return await run();
        } catch (error) {
          throw toTranscribeError(operation, error);
        }
      },
      { attempts: 2, baseDelayMs: 200, maxDelayMs: 1_000, shouldRetry: (error) => error instanceof TranscribeError && error.code === "THROTTLED", ...(options.sleep === undefined ? {} : { sleep: options.sleep }) },
    );

  return {
    async start(request) {
      const input = startJobInput(options.config(), request);
      try {
        await call("StartTranscriptionJob", () => client().send(new StartTranscriptionJobCommand(input)));
        return "STARTED";
      } catch (error) {
        if (errorName((error as Error).cause) === "ConflictException") return "EXISTS";
        throw error;
      }
    },
    async get(jobName) {
      try {
        const output = await call("GetTranscriptionJob", () => client().send(new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })));
        const job = output.TranscriptionJob;
        const status = job?.TranscriptionJobStatus;
        if (status === undefined || !KNOWN_STATES.has(status)) throw new TranscribeError("UNAVAILABLE", `GetTranscriptionJob returned no known status`);
        return { status: status as TranscriptionJobState, ...(job?.FailureReason === undefined ? {} : { failureReason: job.FailureReason.slice(0, 200) }) };
      } catch (error) {
        if (errorName((error as Error).cause) === "NotFoundException") return undefined;
        throw error;
      }
    },
    async delete(jobName) {
      try {
        await call("DeleteTranscriptionJob", () => client().send(new DeleteTranscriptionJobCommand({ TranscriptionJobName: jobName })));
      } catch (error) {
        if (errorName((error as Error).cause) === "NotFoundException") return;
        throw error;
      }
    },
  };
}
