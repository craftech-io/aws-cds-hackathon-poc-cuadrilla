// One invocation of the Harness for a turn that passed every gate (docs/architecture.md §9.1): the session
// of the turn and its signed token, the envelope (facts, untrusted block, photo, preloaded reads), the
// actor and session of the order, and what the stream left. The turn is closed whatever happens, so its
// token dies with it.
//
//   end_turn / stop_sequence                     note, usage, latency; an installer left without an answer
//                                                gets `agentFallback` and the order a new session (ADR-0028)
//   content_filtered / guardrail_intervened      the sentinel never leaves: worker/guardrail-block.ts
//   max_tokens, any other stop, a timeout, an    `TURN_FAILED`, `TurnErrors` (`TurnMaxTokens` for max_tokens);
//   error, a forced failure of a QA world        `agentFallback` if the installer got nothing from the turn
//   a throttled call with no time left           `agentFallback` once, the turn closes and the event goes
//                                                back to the queue (TurnRequeued)
//
// `IDEMP#TURN_RAN#<eventId>` is written as soon as the Harness answers, so an event retried after a later
// failure never invokes the Harness twice.
import { renderEnvelope } from "../agent/envelope";
import { HarnessError, type HarnessTurnResult } from "../agent/harness-client";
import type { WorkOrder } from "../domain/work-orders";
import { ulid } from "../lib/crypto";
import { localDateOf, MEXICO_CITY_TIME_ZONE } from "../services/business-hours/zoned-time";
import { openSession } from "../services/session/session";
import { WORKER_ACTIONS, auditOnce, workerAudit } from "../worker/audit";
import { handleGuardrailBlock } from "../worker/guardrail-block";
import { noticeTargetOf, sendWorkerNotice } from "../worker/notices";
import type { WorkerContext } from "../worker/ports";
import { type TurnDeps, type TurnFailureCause, type TurnOutcome, type TurnRequest, TurnRequeued, answersInstaller } from "./deps";
import { envelopeEvent, envelopeFacts } from "./facts";
import { harnessIdentity } from "./identity";
import { preloadReads, readsFor } from "./preload";
import { FIXED_NOTES, TURN_LOG_METRICS, type TurnRecordDeps, escalatedInTurn, firstReplyLatency, logTurnMetric, messagesOfTurn, recordTurnKpi, writeTurnNote } from "./record";

/** `IDEMP#TURN_RAN#<eventId>`: the Harness already answered this event. */
export const TURN_RAN_SOURCE = "TURN_RAN";
/** `Runtime/FAULTS#<qa-…>.turn = "FAIL_NEXT"` makes the next turn of the world fail (`turn.forceFailure`, FL-099 a). */
export const FORCED_TURN_FAILURE = "FAIL_NEXT";

export interface InvokeInput {
  readonly request: TurnRequest;
  readonly workOrder?: WorkOrder;
  readonly worldEpoch: number;
  readonly simNow: string;
  readonly clockMode: string;
}

type Invocation = { readonly ran: true; readonly result: HarnessTurnResult; readonly latencyMs: number } | { readonly ran: false; readonly cause: TurnFailureCause };

function recordDeps(deps: TurnDeps, ctx: WorkerContext): TurnRecordDeps {
  return { data: deps.data, agentMode: deps.agentMode, log: ctx.log };
}

/** Consumes a forced failure of a `qa-*` world; every other world has no faults. */
async function takeForcedFailure(deps: TurnDeps, clockId: string): Promise<boolean> {
  const faults = await deps.data.worlds.getFaults(clockId);
  if (faults === undefined || Reflect.get(faults, "turn") !== FORCED_TURN_FAILURE) return false;
  const { entity: _entity, createdAt: _createdAt, updatedAt: _updatedAt, version: _version, ...rest } = faults;
  await deps.data.worlds.setFaults({ ...rest, turn: "CONSUMED" });
  return true;
}

async function envelopeOf(deps: TurnDeps, ctx: WorkerContext, input: InvokeInput, token: string): Promise<string> {
  const { request, workOrder } = input;
  const planned = readsFor(request.trigger, workOrder !== undefined);
  const [facts, preloaded] = await Promise.all([
    envelopeFacts(deps.data, { ...(workOrder === undefined ? {} : { workOrder }), simNow: input.simNow, clockMode: input.clockMode }),
    deps.reads === undefined ? Promise.resolve([]) : preloadReads(deps.reads, token, planned, ctx.log),
  ]);
  const inbound = request.inbound;
  return renderEnvelope(
    {
      sessionToken: token,
      event: envelopeEvent(request, workOrder),
      facts,
      untrusted: inbound === undefined ? [] : [{ kind: inbound.kind, text: inbound.text, truncated: inbound.truncated, ...(inbound.confidence === undefined ? {} : { confidence: inbound.confidence }) }],
      attachments: request.attachment === undefined ? [] : [request.attachment],
      preloaded,
    },
    deps.random,
  ).text;
}

async function runHarness(deps: TurnDeps, ctx: WorkerContext, input: InvokeInput, token: string): Promise<Invocation> {
  const { request, workOrder } = input;
  const envelope = await envelopeOf(deps, ctx, input, token);
  if (await takeForcedFailure(deps, request.clockId)) return { ran: false, cause: "TIMEOUT" };
  const identity = harnessIdentity(deps.runtimeSessionKey(), {
    installerId: request.installerId,
    clockId: request.clockId,
    worldEpoch: input.worldEpoch,
    simDate: localDateOf(new Date(request.eventAtSim), MEXICO_CITY_TIME_ZONE),
    ...(workOrder === undefined ? {} : { workOrder: { workOrderId: workOrder.workOrderId, sessionEpoch: workOrder.sessionEpoch } }),
  });
  const started = ctx.now().getTime();
  try {
    const result = await deps.harness.invoke({ ...identity, envelope, lambdaDeadlineMs: ctx.lambdaDeadlineMs });
    return { ran: true, result, latencyMs: ctx.now().getTime() - started };
  } catch (error) {
    if (!(error instanceof HarnessError) || error.kind === "THROTTLED") throw error;
    // AWS's error name and message (no payload): what to fix, without guessing.
    const cause = error.cause instanceof Error ? { causeName: error.cause.name, causeMessage: error.cause.message.slice(0, 300) } : {};
    ctx.log.warn("turn.harness_failed", { kind: error.kind, ...cause });
    return { ran: false, cause: error.kind === "TIMEOUT" ? "TIMEOUT" : "HARNESS_ERROR" };
  }
}

/** `agentFallback` to an installer who asked and got nothing, audited once per event. */
async function fallback(deps: TurnDeps, ctx: WorkerContext, input: InvokeInput, turnId: string, cause: string): Promise<void> {
  const { request, workOrder } = input;
  if (!answersInstaller(request.trigger)) return;
  await sendWorkerNotice({ notices: deps.ports.notices, runtime: deps.data.runtime }, ctx, noticeTargetOf(request, workOrder?.workOrderId), "agentFallback");
  await auditOnce(workerAudit(deps.data), {
    action: WORKER_ACTIONS.agentFallback,
    eventId: request.eventId,
    ispId: request.ispId,
    clockId: request.clockId,
    atSim: request.eventAtSim,
    trigger: request.trigger,
    refs: { turnId, ...(workOrder === undefined ? {} : { workOrderId: workOrder.workOrderId }) },
    reason: cause,
  });
}

async function failTurn(deps: TurnDeps, ctx: WorkerContext, input: InvokeInput, turnId: string, cause: TurnFailureCause, stopReason?: string): Promise<void> {
  const { request, workOrder } = input;
  await auditOnce(workerAudit(deps.data), {
    action: WORKER_ACTIONS.turnFailed,
    eventId: request.eventId,
    ispId: request.ispId,
    clockId: request.clockId,
    atSim: request.eventAtSim,
    trigger: request.trigger,
    refs: { turnId, ...(workOrder === undefined ? {} : { workOrderId: workOrder.workOrderId }) },
    detail: { cause, ...(stopReason === undefined ? {} : { stopReason }) },
  });
  logTurnMetric(ctx.log, TURN_LOG_METRICS.errors, { cause, trigger: request.trigger, ...(stopReason === undefined ? {} : { stopReason }) });
}

/** A conversation that concluded not to answer starts over (ADR-0028 §3): new session for the order, audited. */
async function resetSession(deps: TurnDeps, input: InvokeInput, turnId: string): Promise<void> {
  const { request, workOrder } = input;
  if (workOrder === undefined) return;
  await deps.data.workOrders.bumpSessionEpoch(workOrder.workOrderId);
  await auditOnce(workerAudit(deps.data), {
    action: WORKER_ACTIONS.sessionReset,
    eventId: request.eventId,
    ispId: request.ispId,
    clockId: request.clockId,
    atSim: request.eventAtSim,
    trigger: request.trigger,
    refs: { turnId, workOrderId: workOrder.workOrderId },
    reason: "NO_REPLY",
  });
}

async function finishTurn(deps: TurnDeps, ctx: WorkerContext, input: InvokeInput, turnId: string, invocation: Extract<Invocation, { ran: true }>): Promise<TurnOutcome> {
  const { request, workOrder } = input;
  const { result, latencyMs } = invocation;
  const record = recordDeps(deps, ctx);
  logTurnMetric(ctx.log, TURN_LOG_METRICS.latency, { latencyMs, trigger: request.trigger, outcome: result.outcome, stopReason: result.stopReason, toolUses: result.toolUses, attempts: result.attempts });
  if (result.outcome === "GUARDRAIL") {
    await writeTurnNote(record, { request, turnId, text: FIXED_NOTES.guardrail, usage: result.usage, stopReason: result.stopReason, latencyMs });
    await recordTurnKpi(record, request, result.usage, latencyMs);
    await handleGuardrailBlock(
      { data: deps.data, ports: deps.ports },
      ctx,
      { request, block: { origin: "HARNESS", policy: "HARNESS", caseReason: "OTHER", stopReason: result.stopReason }, turnId, ...(workOrder === undefined ? {} : { workOrder }) },
    );
    return { kind: "BLOCKED", origin: "HARNESS", turnId };
  }
  const completed = result.outcome === "COMPLETED";
  await writeTurnNote(record, { request, turnId, text: completed || result.note !== "" ? result.note : FIXED_NOTES.failed, usage: result.usage, stopReason: result.stopReason, latencyMs });
  if (result.outcome === "MAX_TOKENS") logTurnMetric(ctx.log, TURN_LOG_METRICS.maxTokens, { trigger: request.trigger });
  const sent = await messagesOfTurn(deps.data, request, turnId);
  const answered = sent.length > 0 || (await escalatedInTurn(deps.data, turnId));
  const firstReply = firstReplyLatency(request.message, sent);
  if (firstReply !== undefined) logTurnMetric(ctx.log, TURN_LOG_METRICS.firstReply, { latencyMs: firstReply, kind: request.inbound?.kind ?? "NONE" });
  await recordTurnKpi(record, request, result.usage, latencyMs, firstReply);
  if (!completed) await failTurn(deps, ctx, input, turnId, result.outcome === "MAX_TOKENS" ? "MAX_TOKENS" : "INCOMPLETE", result.stopReason);
  if (answersInstaller(request.trigger) && !answered) {
    await fallback(deps, ctx, input, turnId, completed ? "NO_REPLY" : result.stopReason);
    if (completed) await resetSession(deps, input, turnId);
  }
  if (!completed) return { kind: "FAILED", turnId, cause: result.outcome === "MAX_TOKENS" ? "MAX_TOKENS" : "INCOMPLETE" };
  return { kind: "COMPLETED", turnId, usage: result.usage, stopReason: result.stopReason, toolUses: result.toolUses, answered };
}

/** Runs the turn and closes it; a throttled Harness closes it, answers once and puts the event back on the queue. */
export async function invokeTurn(deps: TurnDeps, ctx: WorkerContext, input: InvokeInput): Promise<TurnOutcome> {
  const { request, workOrder } = input;
  if ((await deps.data.runtime.getIdempotency(TURN_RAN_SOURCE, request.eventId)) !== undefined) return { kind: "SKIPPED", reason: "ALREADY_RAN" };
  const nowMs = ctx.now().getTime();
  const turnId = ulid(nowMs, deps.random);
  const opened = await openSession(
    { sessionKey: deps.sessionKey(), store: deps.data.runtime, nowMs },
    {
      turnId,
      ispId: request.ispId,
      installerId: request.installerId,
      trigger: request.trigger,
      clockId: request.clockId,
      eventAtSim: request.eventAtSim,
      ...(workOrder === undefined ? {} : { workOrderId: workOrder.workOrderId }),
      ...(request.message === undefined ? {} : { sourceMessageId: request.message.messageId }),
    },
  );
  let invocation: Invocation;
  try {
    invocation = await runHarness(deps, ctx, input, opened.token);
  } catch (error) {
    await deps.data.runtime.closeTurn(turnId, { clockId: request.clockId });
    if (!(error instanceof HarnessError)) throw error;
    // Throttled with no room for another attempt (docs/architecture.md §7): answer once, back to the queue.
    await fallback(deps, ctx, input, turnId, "THROTTLED");
    throw new TurnRequeued("the Harness is throttled and the message has no time left", { cause: error });
  }
  await deps.data.runtime.closeTurn(turnId, { clockId: request.clockId, ...(invocation.ran ? { stopReason: invocation.result.stopReason.slice(0, 64) } : {}) });
  if (!invocation.ran) {
    await writeTurnNote(recordDeps(deps, ctx), { request, turnId, text: FIXED_NOTES.failed });
    await failTurn(deps, ctx, input, turnId, invocation.cause);
    await fallback(deps, ctx, input, turnId, invocation.cause);
    return { kind: "FAILED", turnId, cause: invocation.cause };
  }
  await deps.data.runtime.claimIdempotency(TURN_RAN_SOURCE, request.eventId);
  return finishTurn(deps, ctx, input, turnId, invocation);
}
