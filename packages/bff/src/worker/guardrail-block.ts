// `handle_guardrail_block` (docs/tool-catalog.md; docs/architecture.md §9.1; docs/design-brief.md §5.5):
// what the worker does when a turn is blocked, by the card pre-filter, by G1 before the Harness or by
// the Harness's own guardrail (`content_filtered` / `guardrail_intervened`). No model, in this order:
//
//   1. the Harness's text never leaves: the turn note is the fixed `GUARDRAIL_BLOCK`
//   2. the installer gets the fixed `guardrailRefusal`, unless the same message already got the safety
//      instruction (or the turn answers no message of the installer)
//   3. a case on the order: `DENIED_TOPIC`, `PROMPT_INJECTION` or `OTHER` ("datos de tarjeta"), with the
//      fixed summary of copy/ (never the blocked text)
//   4. `GUARDRAIL_BLOCK` audited once per event, with policy, origin (`PREFILTER`/`HARNESS`) and source
//   5. a block of the Harness raises the order's `sessionEpoch`: the next turn starts a clean session
//
// A case that cannot be opened after a pre-filter block fails the event (SQS retries it: no model was
// called); after a block of the Harness it is logged, so the turn never runs twice.
import type { Connector } from "../connector/ports";
import { esMX } from "../copy/es-MX";
import type { WorkOrder } from "../domain/work-orders";
import { type TurnRequest, answersInstaller } from "../turns/deps";
import { WORKER_ACTIONS, auditOnce, workerAudit } from "./audit";
import { noticeTargetOf, sendWorkerNotice } from "./notices";
import type { WorkerContext, WorkerPorts } from "./ports";

export const GUARDRAIL_BLOCK_METRIC = "GuardrailBlocks";

export interface GuardrailBlock {
  readonly origin: "PREFILTER" | "HARNESS";
  /** `DENIED_TOPIC`, `PROMPT_ATTACK`, `CARD_DATA`, `UNLISTED`, `SENSITIVE_INFORMATION` or `HARNESS`. */
  readonly policy: string;
  readonly caseReason: "DENIED_TOPIC" | "PROMPT_INJECTION" | "OTHER";
  /** A card: the case's summary says "datos de tarjeta". */
  readonly sensitive?: "CARD";
  readonly topics?: readonly string[];
  readonly entity?: string;
  readonly stopReason?: string;
}

export interface GuardrailBlockDeps {
  readonly data: Pick<Connector, "audit" | "runtime" | "workOrders">;
  readonly ports: Pick<WorkerPorts, "cases" | "notices">;
}

export interface GuardrailBlockInput {
  readonly request: TurnRequest;
  readonly block: GuardrailBlock;
  readonly workOrder?: WorkOrder;
  readonly turnId?: string;
}

export interface GuardrailBlockOutcome {
  readonly caseId?: string;
  readonly refused: boolean;
}

async function openBlockCase(deps: GuardrailBlockDeps, ctx: WorkerContext, input: GuardrailBlockInput): Promise<string | undefined> {
  const { request, block, workOrder } = input;
  if (workOrder === undefined) return undefined;
  const summary = esMX.caseReason({ reason: block.caseReason, ...(block.sensitive === undefined ? {} : { sensitive: block.sensitive }) });
  try {
    const opened = await deps.ports.cases.openCase(
      { clockId: request.clockId, ispId: request.ispId, installerId: request.installerId, workOrderId: workOrder.workOrderId, reason: block.caseReason, summary, eventId: request.eventId, atSim: request.eventAtSim },
      ctx,
    );
    return opened.caseId;
  } catch (error) {
    if (block.origin === "PREFILTER") throw error;
    ctx.log.error("worker.block_case_failed", { reason: block.caseReason, cause: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

export async function handleGuardrailBlock(deps: GuardrailBlockDeps, ctx: WorkerContext, input: GuardrailBlockInput): Promise<GuardrailBlockOutcome> {
  const { request, block, workOrder } = input;
  const refuse = answersInstaller(request.trigger) && request.safetyFired !== true;
  const target = noticeTargetOf(request, workOrder?.workOrderId);
  const refused = refuse ? await sendWorkerNotice({ notices: deps.ports.notices, runtime: deps.data.runtime }, ctx, target, "guardrailRefusal") : false;
  const caseId = await openBlockCase(deps, ctx, input);
  await auditOnce(workerAudit(deps.data), {
    action: WORKER_ACTIONS.guardrailBlock,
    eventId: request.eventId,
    ispId: request.ispId,
    clockId: request.clockId,
    atSim: request.eventAtSim,
    trigger: request.trigger,
    ruleIds: block.origin === "PREFILTER" && block.sensitive === "CARD" ? [] : ["G1"],
    ...(request.message === undefined ? {} : { messageId: request.message.messageId }),
    refs: {
      ...(workOrder === undefined ? {} : { workOrderId: workOrder.workOrderId }),
      ...(caseId === undefined ? {} : { caseId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    },
    detail: {
      origin: block.origin,
      policy: block.policy,
      source: request.inbound?.source ?? "SYSTEM",
      caseReason: block.caseReason,
      refused,
      ...(block.topics === undefined || block.topics.length === 0 ? {} : { topics: [...block.topics] }),
      ...(block.entity === undefined ? {} : { entity: block.entity }),
      ...(block.stopReason === undefined ? {} : { stopReason: block.stopReason }),
    },
  });
  if (block.origin === "HARNESS" && workOrder !== undefined) await deps.data.workOrders.bumpSessionEpoch(workOrder.workOrderId);
  ctx.log.warn("metric", { metric: GUARDRAIL_BLOCK_METRIC, value: 1, origin: block.origin, policy: block.policy });
  return { refused, ...(caseId === undefined ? {} : { caseId }) };
}
