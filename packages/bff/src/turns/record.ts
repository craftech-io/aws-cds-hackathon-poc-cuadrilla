// What a turn leaves behind besides its tools' effects (docs/architecture.md §9.1 and §12, ADR-0028):
//
//   TurnNote          the final text of the Harness (ADR-0014: an internal note, never sent), with its
//                     `stopReason` and tokens, or a fixed code when its text must not be kept (a guardrail's
//                     sentinel, a failed turn)
//   CuadrillaMetrics  the turn and its tokens on the order's KPI row, its latency, the first-reply
//                     latency (real ms from the inbound message to the first outbound of the turn) and
//                     the turn's cost by the verified rate card (`costUsd`, the metrics' cost per
//                     conversation; absent while a model row is not verified)
//   log fields        `TurnLatency`, `TurnErrors`, `TurnMaxTokens`, `FirstReplyLatency` (logs only, ADR-0028)
//   AgentSpendUsd     the turn's OWN spend, by the verified rows of the rate card (WP-49), only in the
//                     demo and live worlds: the alarm of the cost cut (ADR-0019) sums it per hour against
//                     the stage's hourly budget, so a conversation adds what each turn spends, never its
//                     running total again. Guest worlds
//                     (sign-up ones included) are capped by their own ceilings and never log it; QA and
//                     evaluation worlds have a budget per run
//   answered          whether the installer got something from the turn: a message of the turn, or an
//                     escalation or a safety report that answers by itself (`ALWAYS_ANSWER`)
import { ConnectorError, ispKindOfClock } from "@cuadrilla/shared";
import type { HarnessUsage } from "../agent/harness-client";
import type { Connector } from "../connector/ports";
import type { Message } from "../domain/conversations";
import type { AgentMode } from "../domain/metrics";
import type { Logger } from "../lib/log";
import { maskText } from "../lib/mask";
import { DEFAULT_MODEL_ID, conversationCost } from "../services/ratecard/ratecard";
import type { TurnRequest } from "./deps";

export const TURN_LOG_METRICS = { latency: "TurnLatency", errors: "TurnErrors", maxTokens: "TurnMaxTokens", firstReply: "FirstReplyLatency" } as const;

/** Read by the metric filter of the cost cut (infra/observability-spec.ts). */
export const AGENT_SPEND_METRIC = "AgentSpendUsd";

/** Fixed notes of the turns whose model text is not kept. */
export const FIXED_NOTES = { guardrail: "GUARDRAIL_BLOCK", failed: "TURN_FAILED" } as const;

/** Tools whose successful call answers the installer by itself (the escalation and the safety handler notify). */
export const ANSWERING_TOOLS = ["escalate_case", "report_safety_hazard"] as const;

export interface TurnRecordDeps {
  readonly data: Pick<Connector, "conversations" | "metrics" | "runtime" | "reference">;
  readonly agentMode: AgentMode;
  readonly log: Logger;
}

export interface NoteInput {
  readonly request: TurnRequest;
  readonly turnId: string;
  readonly text: string;
  readonly usage?: HarnessUsage;
  readonly stopReason?: string;
  readonly latencyMs?: number;
}

/** Appends the note (masked); a retried event that already wrote it leaves the first one. */
export async function writeTurnNote(deps: TurnRecordDeps, input: NoteInput): Promise<void> {
  const { request } = input;
  const text = maskText(input.text).trim() || FIXED_NOTES.failed;
  try {
    await deps.data.conversations.appendTurnNote({
      turnId: input.turnId,
      personId: request.installerId,
      clockId: request.clockId,
      trigger: request.trigger,
      note: [...text].slice(0, 4_000).join(""),
      atSim: request.eventAtSim,
      agentMode: deps.agentMode,
      ...(request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId }),
      ...(input.usage === undefined ? {} : { usage: { inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens } }),
      ...(input.stopReason === undefined ? {} : { stopReason: input.stopReason.slice(0, 64) }),
      ...(input.latencyMs === undefined ? {} : { latencyMs: Math.max(0, Math.round(input.latencyMs)) }),
    });
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
  }
}

/** The turn, its tokens, its latency and its priced cost on the order's KPI row (`EVAL` in an evaluation world). */
export async function recordTurnKpi(deps: TurnRecordDeps, request: TurnRequest, usage: HarnessUsage, latencyMs: number, firstReplyLatencyMs?: number): Promise<void> {
  const order = request.workOrderId === undefined ? {} : { workOrderId: request.workOrderId };
  const usd = await turnCostUsd(deps, usage, order);
  if (request.workOrderId !== undefined) await addTurnToKpi(deps, { ...request, workOrderId: request.workOrderId }, { usage, latencyMs, firstReplyLatencyMs, costUsd: usd });
  if (usd !== undefined && agentSpendCounts(request.clockId)) deps.log.info("metric", { metric: AGENT_SPEND_METRIC, value: usd, ...order });
}

interface TurnKpiDelta {
  readonly usage: HarnessUsage;
  readonly latencyMs: number;
  readonly firstReplyLatencyMs: number | undefined;
  readonly costUsd: number | undefined;
}

async function addTurnToKpi(deps: TurnRecordDeps, request: TurnRequest & { readonly workOrderId: string }, turn: TurnKpiDelta): Promise<void> {
  const evaluation = ispKindOfClock(request.clockId) === "EVAL";
  await deps.data.metrics.addToKpi(
    {
      ispId: request.ispId,
      source: evaluation ? "EVAL" : "WORLD",
      clockId: request.clockId,
      workOrderId: request.workOrderId,
      agentMode: deps.agentMode,
      ...(evaluation ? { runId: request.clockId.slice("eval-".length) } : {}),
    },
    {
      counters: { turns: 1, inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens },
      turnLatencyMs: Math.max(0, Math.round(turn.latencyMs)),
      ...(turn.firstReplyLatencyMs === undefined ? {} : { firstReplyLatencyMs: turn.firstReplyLatencyMs }),
      ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
    },
  );
}

/** The cost in USD of these model tokens by the verified rate card rows, or `undefined` while a row it needs is not verified. */
export function tokensCostUsd(tokens: Pick<HarnessUsage, "inputTokens" | "outputTokens">, rows: readonly unknown[]): number | undefined {
  const usage = {
    models: { [DEFAULT_MODEL_ID]: { input: tokens.inputTokens, output: tokens.outputTokens, cacheRead: 0, cacheWrite: 0 } },
    embeddingTokens: 0,
    agentCore: { gateway: 0, memoryEvents: 0, memoryRecords: 0, harness: 0 },
    transcribeSeconds: 0,
    emails: 0,
    attachmentBytes: 0,
    whatsapp: { utility: 0, service: 0 },
  };
  const cost = conversationCost(usage, rows, { whatsappSimulated: false });
  return cost.status === "VERIFIED" ? cost.usd : undefined;
}

/** The worlds whose spend the stage-wide cut sums: the demo and the live world, never a guest's, QA's or an evaluation's. */
export const agentSpendCounts = (clockId: string): boolean => ispKindOfClock(clockId) === "DEMO";

/** The turn's own cost by the verified rate card; a rate card that cannot be read or priced only leaves a warning, never fails the turn. */
async function turnCostUsd(deps: TurnRecordDeps, usage: HarnessUsage, order: { readonly workOrderId?: string }): Promise<number | undefined> {
  try {
    const usd = tokensCostUsd(usage, await deps.data.reference.listRateCard());
    if (usd === undefined) deps.log.warn("turn.cost_unpriced", order);
    return usd;
  } catch (error) {
    deps.log.warn("turn.cost_unavailable", { ...order, error });
    return undefined;
  }
}

/** The outbound messages of the turn to its installer, oldest first. */
export async function messagesOfTurn(data: Pick<Connector, "conversations">, request: TurnRequest, turnId: string): Promise<Message[]> {
  const thread = await data.conversations.listMessages(request.installerId, { fromSim: request.eventAtSim });
  return thread.filter((message) => message.direction === "OUT" && message.turnId === turnId);
}

/** A successful escalation or safety report of the turn answers the installer by itself. */
export async function escalatedInTurn(data: Pick<Connector, "runtime">, turnId: string): Promise<boolean> {
  const results = await Promise.all(ANSWERING_TOOLS.map((tool) => data.runtime.listTurnResults(turnId, tool)));
  return results.flat().some((result) => result.output.ok === true);
}

/** Real ms from the inbound message to the first outbound of the turn; `undefined` when it cannot be measured. */
export function firstReplyLatency(inbound: Message | undefined, sent: readonly Message[]): number | undefined {
  const receivedAt = inbound?.sentAtReal === undefined ? Number.NaN : Date.parse(inbound.sentAtReal);
  const firstAt = Math.min(...sent.map((message) => (message.sentAtReal === undefined ? Number.POSITIVE_INFINITY : Date.parse(message.sentAtReal))));
  if (!Number.isFinite(receivedAt) || !Number.isFinite(firstAt) || firstAt < receivedAt) return undefined;
  return Math.round(firstAt - receivedAt);
}

/** One log line per metric data point; CloudWatch Logs Insights reads them (ADR-0028). */
export function logTurnMetric(log: Logger, metric: (typeof TURN_LOG_METRICS)[keyof typeof TURN_LOG_METRICS], fields: Readonly<Record<string, unknown>>): void {
  log.info("metric", { metric, value: 1, ...fields });
}
