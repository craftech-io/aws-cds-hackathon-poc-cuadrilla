// `eval.runQuestions` of the `QaDriver` (docs/tool-catalog.md; docs/test-plan.md §4.5 `EV-01/2`, §5): a
// batch of the manual's questions, each sent by its own installer (one active order, no shared session or
// memory) through the simulator's path, then:
//
//   1. `installer.settle`, and what the question left (observe.ts)
//   2. an offer to escalate ("Consultar a mi supervisor") is tapped, as an installer would, and the case
//      it opened is recorded (`OFFER_ESCALATION`)
//   3. the score of score.ts against the question's accepted outcomes and voiding patterns
//   4. one `EvalResult` per question: outcome, passed, latency to the first reply, tokens, cost, and the
//      details the report needs (observed outcomes, citations, cases, guardrail, safety, `Retrieve`)
//
// Up to 4 questions at once, each in its own FIFO group (its own installer). A question already measured
// in this run is skipped unless `rerun`; one that could not be run (`ERROR:…`) is retried. Every attempt
// sends a new inbound (its key is the driver call's and the question's, `evalAttempt`), so a retried or
// re-run question reaches the agent again instead of being dropped as a duplicate (FL-093). The texts the
// agent wrote travel back to the runner for the ADR-0023 check and are never persisted.
import { ToolError } from "@cuadrilla/shared";
import type { EvalResult } from "../domain/metrics";
import { tokenCost } from "./cost";
import { escalationOffer, readQuestion, type QuestionReading } from "./observe";
import { type QuestionSpec, questionSpecOf } from "./outcomes";
import { type EvalDeps, RunQuestionsInput, evalAttempt } from "./ports";
import { type PublishOutcome, closeRun, isErrorOutcome } from "./publish";
import { scoreQuestion } from "./score";
import { evalRunOf, itemInstallerId } from "./world-request";

/** Margin for the clocks of the Lambdas that stamp the rows (the driver's and the worker's). */
const CLOCK_MARGIN_MS = 1_000;

export interface ItemRun {
  readonly result: EvalResult;
  /** Only of questions: the agent's texts of this attempt (the runner's neutral-words check). */
  readonly agentTexts?: readonly string[];
}

export interface RunOutput {
  readonly runId: string;
  readonly ispId: string;
  readonly ran: readonly ItemRun[];
  /** Items of the batch already measured in this run (not run again). */
  readonly skipped: readonly string[];
  readonly publish?: PublishOutcome;
}

/** The code of a failure, never its message (it may quote data of the world). */
export function failureCodeOf(error: unknown): string {
  if (error instanceof ToolError) return error.reason === undefined ? error.code : `${error.code}:${error.reason}`;
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "UNKNOWN";
}

/** Runs `work` over `items`, at most `limit` at once, keeping the input order. */
export async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/** Items of a batch to run: the requested ones without a usable result, or all of them on a rerun. */
export async function itemsToRun(deps: Pick<EvalDeps, "connector">, run: { readonly ispId: string; readonly runId: string }, kind: "Q" | "P", requested: readonly string[], rerun: boolean): Promise<{ readonly todo: string[]; readonly skipped: string[] }> {
  if (rerun) return { todo: [...requested], skipped: [] };
  const done = new Set((await deps.connector.metrics.listEvalResults(run.ispId, run.runId, kind)).filter((row) => !isErrorOutcome(row.outcome)).map((row) => row.itemId));
  return { todo: requested.filter((itemId) => !done.has(itemId)), skipped: requested.filter((itemId) => done.has(itemId)) };
}

interface QuestionTarget {
  readonly clockId: string;
  readonly installerId: string;
  readonly workOrderId: string;
}

/** The question's own installer and its active order, checked against the world (never taken from the input). */
async function targetOf(deps: EvalDeps, clockId: string, questionId: string): Promise<QuestionTarget> {
  const installerId = itemInstallerId(clockId, questionId);
  const workOrderId = (await deps.connector.worlds.getInstallerState(installerId))?.activeWorkOrderId;
  if (workOrderId === undefined) throw new ToolError("NOT_FOUND", `${questionId} has no installer with an active order in ${clockId}`, "EVAL_SETUP");
  const order = await deps.connector.workOrders.getWorkOrder(workOrderId);
  if (order?.clockId !== clockId || order.installerId !== installerId) throw new ToolError("CONFLICT", `the order of ${questionId} is not its installer's in ${clockId}`, "EVAL_SETUP");
  return { clockId, installerId, workOrderId };
}

async function askAndObserve(deps: EvalDeps, target: QuestionTarget, question: QuestionSpec, settleTimeoutSec: number): Promise<{ readonly reading: QuestionReading; readonly tapped: boolean }> {
  const { clockId, installerId, workOrderId } = target;
  const attempt = evalAttempt(deps.callKey, question.questionId);
  const sinceReal = new Date(deps.now().getTime() - CLOCK_MARGIN_MS).toISOString();
  const sent = await deps.channel.sendText({ clockId, installerId, text: question.text, attempt });
  await deps.channel.settleInstaller({ installerId, timeoutSec: settleTimeoutSec });
  const window = { installerId, workOrderId, sinceReal, ...(sent.messageId === undefined ? {} : { inboundMessageId: sent.messageId }) };
  const first = await readQuestion(deps.connector, window);
  const offer = escalationOffer(first.observation);
  if (offer === undefined) return { reading: first, tapped: false };
  const tapAtReal = new Date(deps.now().getTime() - CLOCK_MARGIN_MS).toISOString();
  await deps.channel.tapButton({ clockId, installerId, nonce: offer.nonce, action: "CONSULT_SUPERVISOR", attempt });
  await deps.channel.settleInstaller({ installerId, timeoutSec: settleTimeoutSec });
  const second = await readQuestion(deps.connector, { ...window, tapAtReal });
  // The latency is the question's: to the first reply, which came before the tap.
  const { firstReplyLatencyMs: _afterTap, ...rest } = second;
  return { reading: { ...rest, ...(first.firstReplyLatencyMs === undefined ? {} : { firstReplyLatencyMs: first.firstReplyLatencyMs }) }, tapped: true };
}

async function runQuestion(deps: EvalDeps, context: { readonly clockId: string; readonly ispId: string; readonly runId: string; readonly rates: readonly unknown[]; readonly settleTimeoutSec: number }, question: QuestionSpec): Promise<ItemRun> {
  const base = { ispId: context.ispId, runId: context.runId, kind: "Q" as const, itemId: question.questionId, clockId: context.clockId };
  let target: QuestionTarget | undefined;
  try {
    target = await targetOf(deps, context.clockId, question.questionId);
    const { reading, tapped } = await askAndObserve(deps, target, question, context.settleTimeoutSec);
    const score = scoreQuestion(question, reading.observation);
    const cost = tokenCost(context.rates, reading.usage);
    const result = await deps.connector.metrics.putEvalResult({
      ...base,
      outcome: score.outcome,
      passed: score.passed,
      ...(reading.firstReplyLatencyMs === undefined ? {} : { latencyMs: Math.round(reading.firstReplyLatencyMs) }),
      inputTokens: reading.usage.inputTokens,
      outputTokens: reading.usage.outputTokens,
      details: {
        type: question.type,
        installerId: target.installerId,
        workOrderId: target.workOrderId,
        observed: [...score.observed],
        voidedBy: [...score.voidedBy],
        citations: [...score.citations],
        turnSections: [...reading.observation.turnSections],
        cases: reading.observation.cases.map((entry) => ({ kind: entry.kind, reason: entry.reason })),
        ...(reading.observation.guardrail === undefined ? {} : { guardrail: { policy: reading.observation.guardrail.policy, topics: [...reading.observation.guardrail.topics] } }),
        safetyDetected: score.safetyDetected,
        unexpectedSafety: score.unexpectedSafety,
        offerTapped: tapped,
        replies: reading.observation.replies.length,
        turns: reading.usage.turns,
        maxTokensTurns: reading.usage.maxTokensTurns,
        retrieveScores: [...reading.retrieve.scores],
        retrieveCoverage: { ...reading.retrieve.coverage },
        costUsd: cost.usd,
        costStatus: cost.status,
      },
    });
    return { result, agentTexts: reading.agentTexts };
  } catch (error) {
    const code = failureCodeOf(error);
    deps.log.warn("evaluation.question_failed", { questionId: question.questionId, code });
    const result = await deps.connector.metrics.putEvalResult({ ...base, outcome: `ERROR:${code}`.slice(0, 64), passed: false, details: { type: question.type, error: code, ...(target === undefined ? {} : { installerId: target.installerId, workOrderId: target.workOrderId }) } });
    return { result };
  }
}

/** The questions of the set, by id (the `Reference` rows `seed:load` wrote). */
export async function questionSet(deps: Pick<EvalDeps, "connector">): Promise<Map<string, QuestionSpec>> {
  const rows = await deps.connector.reference.listEvalQuestions();
  return new Map(rows.map((row) => questionSpecOf(row)).map((spec) => [spec.questionId, spec]));
}

export async function runQuestions(deps: EvalDeps, raw: unknown): Promise<RunOutput> {
  const input = RunQuestionsInput.parse(raw);
  const run = evalRunOf(input.clockId);
  const set = await questionSet(deps);
  const unknown = input.questionIds.filter((questionId) => !set.has(questionId));
  if (unknown.length > 0) throw new ToolError("INVALID", `not questions of the set: ${unknown.join(", ")}`, "EVAL_UNKNOWN_ITEM");
  const { todo, skipped } = await itemsToRun(deps, run, "Q", input.questionIds, input.rerun);
  const rates = todo.length === 0 ? [] : await deps.connector.reference.listRateCard();
  const context = { clockId: input.clockId, ...run, rates, settleTimeoutSec: input.settleTimeoutSec };
  const ran = await inPool(todo, input.concurrency, (questionId) => runQuestion(deps, context, set.get(questionId) as QuestionSpec));
  const publish = input.publish || input.collect ? await closeRun(deps, "Q", run, [...set.keys()].sort(), input.publish) : undefined;
  return { ...run, ran, skipped, ...(publish === undefined ? {} : { publish }) };
}
