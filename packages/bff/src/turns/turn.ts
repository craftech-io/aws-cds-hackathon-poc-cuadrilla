// An agent turn (docs/architecture.md §7 `AGENT_TURN` and §9.1, docs/design-brief.md §5.1): the gates every
// turn passes before the Harness, in this order, and then the invocation (turns/invoke.ts).
//
//   1. the world exists (a reset or a destroyed world leaves late events behind); the order is the
//      installer's in that world, else the turn runs on the installer's day session
//   2. the kill switch → `servicePaused` without the Harness (none if the message already got the safety
//      instruction); a cap of the world, the operator or the stage → `TURN_CAP` with its scope and `turnCap`
//      (worker/turn-cap.ts). Nothing is preloaded, nothing reaches Bedrock
//   3. a card in the installer's text → blocked before G1 (lib/mask.ts `prefilterBlock`, FL-078 b)
//   4. the G1 pre-filter over the installer's text (turns/prefilter.ts): only a BLOCKED assessment blocks
//      (worker/guardrail-block.ts); an anonymization goes on with G1's text, masked again by the
//      normalizer, and `GUARDRAIL_MASK` is audited
//
// Every decision is audited once per event, so a retried event never doubles a row.
import { normalizeUntrusted } from "../channels/normalizer";
import type { WorkOrder } from "../domain/work-orders";
import { effectiveMode, simNowOf } from "../lib/clock";
import { WORKER_ACTIONS, auditOnce, workerAudit } from "../worker/audit";
import { handleGuardrailBlock } from "../worker/guardrail-block";
import { noticeTargetOf, sendWorkerNotice } from "../worker/notices";
import type { WorkerContext } from "../worker/ports";
import { type TurnBudget, reserveTurn } from "../worker/turn-cap";
import { type TurnDeps, type TurnInbound, type TurnOutcome, type TurnRequest, answersInstaller } from "./deps";
import { invokeTurn } from "./invoke";
import { caseReasonOf } from "./prefilter";

export const KILL_SWITCH_METRIC = "KillSwitchActive";

/** The order of the turn, only if it is the installer's in the turn's world. */
async function workOrderOf(deps: TurnDeps, ctx: WorkerContext, request: TurnRequest): Promise<WorkOrder | undefined> {
  if (request.workOrderId === undefined) return undefined;
  const order = await deps.data.workOrders.getWorkOrder(request.workOrderId);
  if (order !== undefined && order.clockId === request.clockId && order.installerId === request.installerId) return order;
  ctx.log.warn("turn.work_order_out_of_scope", { workOrderId: request.workOrderId, trigger: request.trigger });
  return undefined;
}

/** The audit row, the log line and the fixed notice of a turn the budget refused. */
async function refuseByBudget(deps: TurnDeps, ctx: WorkerContext, request: TurnRequest, workOrder: WorkOrder | undefined, budget: Exclude<TurnBudget, { allowed: true }>): Promise<TurnOutcome> {
  const notify = answersInstaller(request.trigger);
  const notices = { notices: deps.ports.notices, runtime: deps.data.runtime };
  const base = { eventId: request.eventId, ispId: request.ispId, clockId: request.clockId, atSim: request.eventAtSim, trigger: request.trigger, ...(request.message === undefined ? {} : { messageId: request.message.messageId }) };
  const refs = workOrder === undefined ? {} : { workOrderId: workOrder.workOrderId };
  if (budget.refusal === "PAUSED") {
    ctx.log.warn("metric", { metric: KILL_SWITCH_METRIC, value: 1, scope: budget.scope, surface: "AGENT" });
    await auditOnce(workerAudit(deps.data), { ...base, action: WORKER_ACTIONS.killSwitch, decision: "DENY", ruleIds: ["LAM-KILL"], refs, detail: { scope: budget.scope } });
    if (notify && request.safetyFired !== true) await sendWorkerNotice(notices, ctx, noticeTargetOf(request, workOrder?.workOrderId), "servicePaused");
    return { kind: "SKIPPED", reason: "PAUSED" };
  }
  await auditOnce(workerAudit(deps.data), {
    ...base,
    action: WORKER_ACTIONS.turnCap,
    decision: "DENY",
    refs,
    detail: { scope: budget.scope, ledger: budget.ledger, period: budget.period, limit: budget.limit, resetsAtReal: budget.resetsAtReal },
  });
  if (notify && request.safetyFired !== true) await sendWorkerNotice(notices, ctx, noticeTargetOf(request, workOrder?.workOrderId), "turnCap");
  return { kind: "SKIPPED", reason: "TURN_CAP" };
}

/** G1 over the installer's words: a block ends the turn here; an anonymization replaces the text. */
async function prefilter(deps: TurnDeps, ctx: WorkerContext, request: TurnRequest, workOrder: WorkOrder | undefined, inbound: TurnInbound): Promise<{ readonly blocked: TurnOutcome } | { readonly inbound: TurnInbound }> {
  if (inbound.source !== "INSTALLER") return { inbound };
  const verdict = await deps.prefilter.check(inbound.text);
  if (verdict.action === "NONE") return { inbound };
  if (verdict.action === "BLOCKED") {
    await handleGuardrailBlock(
      { data: deps.data, ports: deps.ports },
      ctx,
      { request, block: { origin: "PREFILTER", policy: verdict.policy, caseReason: caseReasonOf(verdict.policy), topics: verdict.topics, ...(verdict.policy === "CARD_DATA" ? { sensitive: "CARD" as const } : {}) }, ...(workOrder === undefined ? {} : { workOrder }) },
    );
    return { blocked: { kind: "BLOCKED", origin: "PREFILTER" } };
  }
  const masked = normalizeUntrusted(verdict.text);
  await auditOnce(workerAudit(deps.data), {
    action: WORKER_ACTIONS.guardrailMask,
    eventId: request.eventId,
    ispId: request.ispId,
    clockId: request.clockId,
    atSim: request.eventAtSim,
    trigger: request.trigger,
    ruleIds: ["G1"],
    ...(request.message === undefined ? {} : { messageId: request.message.messageId }),
    refs: workOrder === undefined ? {} : { workOrderId: workOrder.workOrderId },
    detail: { kinds: [...verdict.kinds] },
  });
  return { inbound: { ...inbound, text: masked.text, truncated: inbound.truncated || masked.truncated } };
}

export interface CardBlock {
  readonly kind: "CARD";
  readonly policy: string;
  readonly entity: string;
}

/** Runs one turn: the gates, then the Harness. `card` is the pre-G1 block the inbound text carried. */
export async function runAgentTurn(deps: TurnDeps, ctx: WorkerContext, request: TurnRequest, card?: CardBlock): Promise<TurnOutcome> {
  const clock = await deps.data.runtime.getClock(request.clockId);
  if (clock === undefined) {
    ctx.log.warn("turn.world_gone", { trigger: request.trigger });
    return { kind: "SKIPPED", reason: "NO_WORLD" };
  }
  const workOrder = await workOrderOf(deps, ctx, request);
  const scoped: TurnRequest = { ...request, ...(workOrder === undefined ? { workOrderId: undefined } : {}) };
  const settings = await deps.data.isps.getSettings(request.ispId);
  const budget = await reserveTurn(deps.budget, { clockId: request.clockId, settings: settings ?? {} }, request.eventId, ctx.log);
  if (!budget.allowed) return refuseByBudget(deps, ctx, scoped, workOrder, budget);
  if (card !== undefined) {
    await handleGuardrailBlock(
      { data: deps.data, ports: deps.ports },
      ctx,
      { request: scoped, block: { origin: "PREFILTER", policy: card.policy, caseReason: "OTHER", sensitive: card.kind, entity: card.entity }, ...(workOrder === undefined ? {} : { workOrder }) },
    );
    return { kind: "BLOCKED", origin: "PREFILTER" };
  }
  let inbound = scoped.inbound;
  if (inbound !== undefined) {
    const filtered = await prefilter(deps, ctx, scoped, workOrder, inbound);
    if ("blocked" in filtered) return filtered.blocked;
    inbound = filtered.inbound;
  }
  const realNowMs = ctx.now().getTime();
  return invokeTurn(deps, ctx, {
    request: { ...scoped, ...(inbound === undefined ? {} : { inbound }) },
    worldEpoch: clock.worldEpoch,
    simNow: simNowOf(clock, realNowMs).toISOString(),
    clockMode: effectiveMode(clock, realNowMs),
    ...(workOrder === undefined ? {} : { workOrder }),
  });
}
