/// <reference path="../../sst-env.d.ts" />
// The one client of the Harness (docs/architecture.md §9.1): `InvokeHarness` on the `live` endpoint with
// the work order's `runtimeSessionId`, the installer's `actorId` with the world epoch and the turn
// envelope (agent/envelope.ts) as the only user message. Never `systemPrompt`, `model`, `tools` nor
// `allowedTools` from the edge: the system prompt is static on the Harness (infra/agentcore.ts).
//
// It reads the stream to the end: the text of the last assistant message is the turn note (ADR-0014),
// the last `messageStop.stopReason` says how the turn ended and every `metadata.usage` adds to the
// tokens of the turn. A `ThrottlingException` of the call is retried with exponential backoff and full
// jitter, at most 3 times and only while the Lambda keeps more than `timeoutSeconds + 30 s` after the
// backoff (docs/architecture.md §7, "Presupuesto de tiempo del mensaje"); past that the worker answers
// `AGENT_FALLBACK` and puts the event back on the queue. Nothing else is retried here: a call that
// reached the model may already have used tools.
//
// Checked against the installed `@aws-sdk/client-bedrock-agentcore` 3.1135.0 `.d.ts` (`InvokeHarnessRequest`,
// models_0.d.ts; `MemoryRecordSummary`, models_1.d.ts):
//   - the request takes `maxIterations`, `maxTokens` and `timeoutSeconds` per invocation, and `actorId`;
//   - no session attribute reaches the Gateway outside the user's text: only `runtimeUserId`, `baggage`
//     and the trace headers exist, and none is forwarded to tool inputs, so the `sessionToken` travels in
//     the envelope (an expired token of a closed turn may stay in Memory events and traces;
//     docs/architecture.md §13);
//   - `HarnessStopReason` lists `content_filtered` and no `guardrail_intervened`; both read as a
//     guardrail block, since the stream may carry a value the enum does not list; `max_tokens` and
//     `max_output_tokens_exceeded` read as the output budget running out (`TurnMaxTokens`);
//   - `MemoryRecordSummary` brings `memoryRecordId`, `content`, `memoryStrategyId`, `namespaces`,
//     `createdAt`, `score?` and `metadata?`, and no `updatedAt`.
import { BedrockAgentCoreClient, InvokeHarnessCommand, type InvokeHarnessCommandInput, type InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { z } from "zod";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { DeadlineError, withDeadline } from "../lib/deadline";
import { readLinked } from "../lib/resource";
import { backoffDelayMs } from "../lib/retry";

const REGION = "us-east-1";

/** `Resource.Harness` (infra/agentcore.ts): what the worker needs to invoke the `live` endpoint. */
export const HarnessLink = z.object({
  harnessArn: z.string().startsWith("arn:aws:"),
  endpointName: z.string().min(1),
  timeoutSeconds: z.int().positive(),
  maxIterations: z.int().positive(),
  maxTokens: z.int().positive().optional(),
});
export type HarnessLink = z.infer<typeof HarnessLink>;

/** Retries of a throttled call. */
export const HARNESS_THROTTLE_RETRIES = 3;
/** Backoff of a throttled call: full jitter over 1 s, 2 s, 4 s. */
export const HARNESS_BACKOFF = { baseDelayMs: 1_000, maxDelayMs: 8_000 } as const;
/** Closing margin of the message (docs/architecture.md §7): what the worker keeps after a turn for its writes. */
export const TURN_CLOSING_MARGIN_MS = 30_000;
/** What an attempt may take beyond the Harness's own `timeoutSeconds` (stream start and tail). */
export const HARNESS_STREAM_GRACE_MS = 5_000;
/** A `TurnNote` holds at most 4,000 characters (domain/conversations.ts). */
export const TURN_NOTE_MAX_CHARS = 4_000;

/**
 * Room for one more attempt (docs/architecture.md §7): the Lambda keeps more than `timeoutSeconds + 30 s`.
 * `remainingMs` is `context.getRemainingTimeInMillis()` at the moment of the retry, after its backoff.
 */
export function hasRoomForAttempt(remainingMs: number, timeoutSeconds: number): boolean {
  return remainingMs > timeoutSeconds * 1_000 + TURN_CLOSING_MARGIN_MS;
}

/** How the turn ended, from the last `messageStop.stopReason`. */
export const HarnessOutcome = z.enum(["COMPLETED", "GUARDRAIL", "MAX_TOKENS", "INCOMPLETE"]);
export type HarnessOutcome = z.infer<typeof HarnessOutcome>;

const COMPLETED_STOPS: ReadonlySet<string> = new Set(["end_turn", "stop_sequence"]);
/** A guardrail ended the turn: its text is the guardrail's sentinel and never leaves (§9.1). */
export const GUARDRAIL_STOPS: ReadonlySet<string> = new Set(["guardrail_intervened", "content_filtered"]);
/** The output budget ran out before the turn ended (`TurnMaxTokens`, ADR-0020). */
export const MAX_TOKENS_STOPS: ReadonlySet<string> = new Set(["max_tokens", "max_output_tokens_exceeded"]);

export function outcomeOf(stopReason: string): HarnessOutcome {
  if (COMPLETED_STOPS.has(stopReason)) return "COMPLETED";
  if (GUARDRAIL_STOPS.has(stopReason)) return "GUARDRAIL";
  if (MAX_TOKENS_STOPS.has(stopReason)) return "MAX_TOKENS";
  return "INCOMPLETE";
}

export interface HarnessUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface HarnessTurnRequest {
  readonly runtimeSessionId: string;
  readonly actorId: string;
  /** The user message: the envelope of agent/envelope.ts. */
  readonly envelope: string;
  /** Real instant (epoch ms) the Lambda ends at: `now + context.getRemainingTimeInMillis()`. */
  readonly lambdaDeadlineMs: number;
}

export interface HarnessTurnResult {
  readonly outcome: HarnessOutcome;
  /** Raw stop reason (`end_turn`, `max_tokens`, `content_filtered`…); `none` if the stream never said. */
  readonly stopReason: string;
  /** Text of the last assistant message: the turn note, never a message to anyone. */
  readonly note: string;
  readonly usage: HarnessUsage;
  /** Tool calls the model made (Gateway calls, whatever their result). */
  readonly toolUses: number;
  /** Invocations, the throttled ones included. */
  readonly attempts: number;
}

export type HarnessErrorKind = "THROTTLED" | "TIMEOUT" | "STREAM" | "REQUEST";

/** A turn that could not run or did not end: `THROTTLED` goes back to the queue, the rest fail the turn. */
export class HarnessError extends Error {
  override readonly name = "HarnessError";
  constructor(
    readonly kind: HarnessErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type HarnessSend = (input: InvokeHarnessCommandInput, options: { readonly abortSignal: AbortSignal }) => Promise<{ readonly stream?: AsyncIterable<InvokeHarnessStreamOutput> | undefined }>;

export interface HarnessClient {
  invoke(request: HarnessTurnRequest): Promise<HarnessTurnResult>;
}

export interface HarnessClientDeps {
  readonly link: () => HarnessLink;
  readonly send: HarnessSend;
  /** Real time in ms (the deadline and the backoff are real). */
  readonly nowMs: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export function isThrottling(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const named = (error as { name?: unknown }).name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return named === "ThrottlingException" || named === "TooManyRequestsException" || status === 429;
}

/** The request: the Harness of the link, its `live` endpoint, the turn's ids and envelope. Nothing that overrides the Harness's prompt, model or tools. */
export function harnessRequest(link: HarnessLink, request: HarnessTurnRequest): InvokeHarnessCommandInput {
  return {
    harnessArn: link.harnessArn,
    qualifier: link.endpointName,
    runtimeSessionId: request.runtimeSessionId,
    actorId: request.actorId,
    messages: [{ role: "user", content: [{ text: request.envelope }] }],
    maxIterations: link.maxIterations,
    timeoutSeconds: link.timeoutSeconds,
    ...(link.maxTokens === undefined ? {} : { maxTokens: link.maxTokens }),
  };
}

interface StreamState {
  current: string;
  lastText: string;
  stopReason: string;
  toolUses: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

function streamFailure(event: InvokeHarnessStreamOutput): HarnessError | undefined {
  if (event.internalServerException !== undefined) return new HarnessError("STREAM", "the Harness stream failed (internal error)");
  if (event.validationException !== undefined) return new HarnessError("STREAM", "the Harness stream failed (validation)");
  if (event.runtimeClientError !== undefined) return new HarnessError("STREAM", "the Harness stream failed (runtime client error)");
  return undefined;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function absorb(state: StreamState, event: InvokeHarnessStreamOutput): void {
  if (event.messageStart !== undefined) {
    state.current = "";
    return;
  }
  if (event.contentBlockStart?.start?.toolUse !== undefined) state.toolUses += 1;
  const text = event.contentBlockDelta?.delta?.text;
  if (typeof text === "string") state.current += text;
  if (event.messageStop !== undefined) {
    state.stopReason = event.messageStop.stopReason ?? "none";
    if (state.current.trim() !== "") state.lastText = state.current;
  }
  const usage = event.metadata?.usage;
  if (usage !== undefined) {
    // One metadata event per model call: the turn spends their sum.
    state.usage.inputTokens += count(usage.inputTokens);
    state.usage.outputTokens += count(usage.outputTokens);
    state.usage.cacheReadTokens += count(usage.cacheReadInputTokens);
    state.usage.cacheWriteTokens += count(usage.cacheWriteInputTokens);
  }
}

/** Reads a whole Harness stream into the turn's result (without `attempts`). */
export async function readHarnessStream(stream: AsyncIterable<InvokeHarnessStreamOutput>): Promise<Omit<HarnessTurnResult, "attempts">> {
  const state: StreamState = { current: "", lastText: "", stopReason: "none", toolUses: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  for await (const event of stream) {
    const failure = streamFailure(event);
    if (failure !== undefined) throw failure;
    absorb(state, event);
  }
  if (state.current.trim() !== "" && state.lastText === "") state.lastText = state.current;
  return {
    outcome: outcomeOf(state.stopReason),
    stopReason: state.stopReason,
    note: [...state.lastText.trim()].slice(0, TURN_NOTE_MAX_CHARS).join(""),
    usage: state.usage,
    toolUses: state.toolUses,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHarnessClient(deps: HarnessClientDeps): HarnessClient {
  const sleep = deps.sleep ?? defaultSleep;
  return {
    async invoke(request) {
      const link = HarnessLink.parse(deps.link());
      const input = harnessRequest(link, request);
      const attemptBudgetMs = link.timeoutSeconds * 1_000 + HARNESS_STREAM_GRACE_MS;
      for (let attempt = 0; ; attempt += 1) {
        const usable = request.lambdaDeadlineMs - TURN_CLOSING_MARGIN_MS - deps.nowMs();
        if (usable <= 0) throw new HarnessError("TIMEOUT", "no time left for the turn");
        try {
          const result = await withDeadline("InvokeHarness", Math.min(usable, attemptBudgetMs), async (signal) => {
            const output = await deps.send(input, { abortSignal: signal });
            if (output.stream === undefined) throw new HarnessError("STREAM", "the Harness answered without a stream");
            return readHarnessStream(output.stream);
          });
          return { ...result, attempts: attempt + 1 };
        } catch (error) {
          if (error instanceof HarnessError) throw error;
          if (error instanceof DeadlineError) throw new HarnessError("TIMEOUT", "the turn ran past its deadline", { cause: error });
          if (!isThrottling(error)) throw new HarnessError("REQUEST", "InvokeHarness failed", { cause: error });
          const delay = backoffDelayMs(attempt, { ...HARNESS_BACKOFF, ...(deps.random === undefined ? {} : { random: deps.random }) });
          const remainingAfterBackoff = request.lambdaDeadlineMs - deps.nowMs() - delay;
          if (attempt >= HARNESS_THROTTLE_RETRIES || !hasRoomForAttempt(remainingAfterBackoff, link.timeoutSeconds)) {
            throw new HarnessError("THROTTLED", `InvokeHarness throttled after ${attempt + 1} attempts`, { cause: error });
          }
          await sleep(delay);
        }
      }
    },
  };
}

let sdkClient: BedrockAgentCoreClient | undefined;

/** The SDK never retries the Harness: throttling is retried above, within the message's time budget. */
function agentCoreClient(): BedrockAgentCoreClient {
  sdkClient ??= new BedrockAgentCoreClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.harness) });
  return sdkClient;
}

/** The Harness client of the `InstallerWorker`, over `Resource.Harness` (linked late by infra/workers.ts). */
export function linkedHarnessClient(nowMs: () => number): HarnessClient {
  return createHarnessClient({
    link: () => readLinked("Harness", HarnessLink),
    nowMs,
    send: (input, options) => agentCoreClient().send(new InvokeHarnessCommand(input), { abortSignal: options.abortSignal }),
  });
}
