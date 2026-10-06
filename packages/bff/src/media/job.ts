// One transcription job from start to its output bytes (docs/architecture-integrations.md §5, steps 2-3):
// start (an existing job of the same name is this message's own: it is polled, never started twice),
// poll every 1.5 s until COMPLETED, FAILED or the deadline, then read the output from S3. A job that
// disappears (`NotFoundException`: an earlier attempt of the same event deleted it) is not an error:
// its output is read if it still exists, otherwise the job is started again, once. The same happens
// to a COMPLETED job whose output is already gone (an earlier attempt read and deleted it, then died
// before deleting the job). Cleanup of the output and the job is the caller's.
import { type Clock, systemClock } from "../lib/clock";
import type { Logger } from "../lib/log";
import { TRANSCRIBE_POLL } from "./config";
import { type MediaObjectsPort, type ObjectLocation, ObjectTooLargeError } from "./objects";
import { type StartJobRequest, TranscribeError, type TranscribePort } from "./transcribe-client";

export type JobRun =
  | { readonly kind: "OUTPUT"; readonly bytes: Uint8Array }
  /** `spent`: a job ran before the failure, so the reservation stays taken. */
  | { readonly kind: "START_FAILED"; readonly spent: boolean }
  | { readonly kind: "JOB_FAILED" | "POLL_FAILED" | "TIMEOUT" | "JOB_LOST" | "OUTPUT_TOO_LARGE" };

export interface JobRunDeps {
  readonly transcribe: TranscribePort;
  readonly objects: MediaObjectsPort;
  readonly realClock?: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: Logger;
}

export interface JobRunRequest {
  readonly job: StartJobRequest;
  readonly output: ObjectLocation;
  readonly maxOutputBytes: number;
  readonly pollTimeoutMs: number;
}

type PollResult = "COMPLETED" | "FAILED" | "NOT_FOUND" | "TIMEOUT" | "POLL_FAILED";

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(deps: JobRunDeps, jobName: string, timeoutMs: number): Promise<PollResult> {
  const clock = deps.realClock ?? systemClock;
  const sleep = deps.sleep ?? realSleep;
  const startedMs = (await clock.now()).getTime();
  for (;;) {
    try {
      const snapshot = await deps.transcribe.get(jobName);
      if (snapshot === undefined) return "NOT_FOUND";
      if (snapshot.status === "COMPLETED") return "COMPLETED";
      if (snapshot.status === "FAILED") {
        deps.logger?.warn("transcription job failed", { jobName, failureReason: snapshot.failureReason });
        return "FAILED";
      }
    } catch (error) {
      // A throttled or timed-out read is polled again within the deadline; anything else ends the wait.
      if (!(error instanceof TranscribeError && error.retryable)) {
        deps.logger?.warn("transcription job unreadable", { jobName, error });
        return "POLL_FAILED";
      }
    }
    const elapsedMs = (await clock.now()).getTime() - startedMs;
    if (elapsedMs + TRANSCRIBE_POLL.intervalMs > timeoutMs) return "TIMEOUT";
    await sleep(TRANSCRIBE_POLL.intervalMs);
  }
}

async function readOutput(deps: JobRunDeps, request: JobRunRequest): Promise<Uint8Array | undefined | "TOO_LARGE"> {
  try {
    return await deps.objects.read(request.output, request.maxOutputBytes);
  } catch (error) {
    if (error instanceof ObjectTooLargeError) return "TOO_LARGE";
    throw error;
  }
}

export async function runTranscriptionJob(deps: JobRunDeps, request: JobRunRequest): Promise<JobRun> {
  const { jobName } = request.job;
  let restarted = false;
  for (;;) {
    try {
      const started = await deps.transcribe.start(request.job);
      if (started === "EXISTS") deps.logger?.info("transcription job already exists; polling it", { jobName, restarted });
    } catch (error) {
      deps.logger?.warn("transcription job not started", { jobName, error });
      return { kind: "START_FAILED", spent: restarted };
    }
    const result = await poll(deps, jobName, request.pollTimeoutMs);
    if (result === "FAILED") return { kind: "JOB_FAILED" };
    if (result === "TIMEOUT") return { kind: "TIMEOUT" };
    if (result === "POLL_FAILED") return { kind: "POLL_FAILED" };
    const bytes = await readOutput(deps, request);
    if (bytes === "TOO_LARGE") return { kind: "OUTPUT_TOO_LARGE" };
    if (bytes !== undefined) return { kind: "OUTPUT", bytes };
    if (restarted) return { kind: "JOB_LOST" };
    restarted = true;
    deps.logger?.info("transcription output gone; starting the job again", { jobName, after: result });
    // A COMPLETED job keeps its name taken: it goes first, so the second start creates a new one.
    if (result === "COMPLETED") await deps.transcribe.delete(jobName);
  }
}
