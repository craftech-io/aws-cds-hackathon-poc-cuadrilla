// The one Bedrock `Converse` client of the photo validation (`PhotoModelPort`, docs/architecture.md
// §9.6). The model is `Resource.PhotoModel` (infra/agent-tools.ts, linkedPhotoModelId). Each attempt has a
// 30 s deadline; up to 2 retries with backoff and jitter, only on throttling, timeouts and transient
// service errors, and only while the call's budget (well under the 60 s of `ToolEvidence`) leaves
// room for another full attempt. The SDK does not retry on its own (one attempt per call), so the
// budget is this module's.
//
// Faults (`Runtime/FAULTS#<clockId>.validator`) exist only for `qa-*` worlds (FL-043, the scenario
// runner): `ERROR_503` and `TIMEOUT` make the model unavailable, `NO_TOOL_USE` and `INVALID_OUTPUT`
// return a reading without a valid `record_verdict` (UNSURE). Any other world never reads them.
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { DeadlineError, withDeadline } from "../lib/deadline";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { mayHaveFaults } from "../network/faults";
import type { WorldRuntimePort } from "../connector/ports";
import { buildConverseRequest, readConverseOutput } from "./converse-request";
import type { PhotoModelPort, PhotoModelResult } from "./ports";

export const PHOTO_ATTEMPT_TIMEOUT_MS = CLIENT_TIMEOUTS.converse.requestTimeoutMs;
export const PHOTO_ATTEMPTS = 3;
/** Budget of the whole call, retries included: the Lambda also reads, writes and reacts. */
export const PHOTO_CALL_BUDGET_MS = 45_000;
/** A retry starts only with at least this much budget left. */
const MIN_RETRY_BUDGET_MS = 5_000;

const RETRYABLE_ERRORS = new Set(["ThrottlingException", "ServiceUnavailableException", "InternalServerException", "ModelNotReadyException", "ModelTimeoutException", "DeadlineError", "TimeoutError"]);

export const ValidatorFault = z.enum(["ERROR_503", "TIMEOUT", "NO_TOOL_USE", "INVALID_OUTPUT"]);
export type ValidatorFault = z.infer<typeof ValidatorFault>;

/** `Resource.PhotoModel`: the model id (rate card key) and, with ADR-0028, the app's inference profile `Converse` names. */
const PhotoModelLink = z.object({ modelId: z.string().min(1), invokeModelId: z.string().min(1).optional() });

/** What `Converse` is called with: the inference profile when the stage links one, else the model id. */
export function linkedPhotoModelId(): string {
  const link = readLinked("PhotoModel", PhotoModelLink);
  return link.invokeModelId ?? link.modelId;
}

export interface ConverseSender {
  send(command: ConverseCommand, options?: { readonly abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

export interface BedrockPhotoModelDeps {
  readonly client?: ConverseSender;
  readonly modelId?: () => string;
  /** Faults of `qa-*` worlds; other worlds never read them. */
  readonly worlds?: Pick<WorldRuntimePort, "getFaults">;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

class FaultError extends Error {
  override readonly name = "ServiceUnavailableException";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

async function faultOf(worlds: BedrockPhotoModelDeps["worlds"], clockId: string): Promise<ValidatorFault | undefined> {
  if (worlds === undefined || !mayHaveFaults(clockId)) return undefined;
  const parsed = ValidatorFault.safeParse((await worlds.getFaults(clockId))?.validator);
  return parsed.success ? parsed.data : undefined;
}

/** A response without a valid `record_verdict`, as a fault of a QA world asks. */
function faultyResponse(fault: "NO_TOOL_USE" | "INVALID_OUTPUT"): ConverseCommandOutput {
  const content = fault === "NO_TOOL_USE" ? [{ text: "PASS" }] : [{ toolUse: { toolUseId: "qa-fault", name: "record_verdict", input: { verdict: "PASS" } } }];
  return { output: { message: { role: "assistant", content } }, stopReason: fault === "NO_TOOL_USE" ? "end_turn" : "tool_use", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, metrics: { latencyMs: 0 }, $metadata: {} };
}

let sharedClient: BedrockRuntimeClient | undefined;

function defaultClient(): ConverseSender {
  sharedClient ??= new BedrockRuntimeClient(awsClientConfig({ ...CLIENT_TIMEOUTS.converse, maxAttempts: 1 }));
  return sharedClient;
}

export function bedrockPhotoModel(deps: BedrockPhotoModelDeps = {}): PhotoModelPort {
  const now = deps.now ?? Date.now;
  const modelId = deps.modelId ?? linkedPhotoModelId;
  return {
    source: "MODEL",
    async read(call): Promise<PhotoModelResult> {
      const started = now();
      const fault = await faultOf(deps.worlds, call.clockId);
      if (fault === "TIMEOUT") return { kind: "UNAVAILABLE", reason: "DeadlineError", latencyMs: now() - started };
      const request: ConverseCommandInput = buildConverseRequest({ modelId: modelId(), item: call.item, rubric: call.rubric, jpeg: call.jpeg });
      const client = deps.client ?? defaultClient();
      try {
        const output = await withRetry(
          async () => {
            if (fault === "ERROR_503") throw new FaultError("validator fault of a QA world");
            if (fault === "NO_TOOL_USE" || fault === "INVALID_OUTPUT") return faultyResponse(fault);
            const remaining = PHOTO_CALL_BUDGET_MS - (now() - started);
            return withDeadline("bedrock.converse", Math.max(1, Math.min(PHOTO_ATTEMPT_TIMEOUT_MS, remaining)), (signal) => client.send(new ConverseCommand(request), { abortSignal: signal }));
          },
          {
            attempts: PHOTO_ATTEMPTS,
            baseDelayMs: 500,
            maxDelayMs: 4_000,
            shouldRetry: (error) => RETRYABLE_ERRORS.has(errorName(error)) && PHOTO_CALL_BUDGET_MS - (now() - started) >= MIN_RETRY_BUDGET_MS,
            ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
            ...(deps.random === undefined ? {} : { random: deps.random }),
          },
        );
        return { kind: "READ", source: "MODEL", ...readConverseOutput(output), latencyMs: now() - started };
      } catch (error) {
        const reason = error instanceof DeadlineError ? "DeadlineError" : errorName(error);
        call.logger.warn("evidence.model.unavailable", { reason, latencyMs: now() - started });
        return { kind: "UNAVAILABLE", reason, latencyMs: now() - started };
      }
    },
  };
}
