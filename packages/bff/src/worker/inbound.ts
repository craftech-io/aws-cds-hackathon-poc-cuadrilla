// `INBOUND_MESSAGE` (docs/architecture.md §7, docs/design-brief.md §5.1 and §5.9): an installer's message,
// already stored and masked by InboundWhatsApp, inside the installer's FIFO group. In this order:
//
//   1. a voice note: the kill switch (`servicePaused`, no Transcribe), then `transcribe_voice_note` inside
//      this same message (it reserves the world's and the global transcription caps); low confidence, too
//      long, a failure or a cap → its fixed notice and the end (no turn)
//   2. the order the message is about (worker/active-order.ts, FL-013): with several pending and none
//      active, the `ORDER_CHOICE` list goes out and no turn runs (the tap on a row brings the message back)
//   3. the safety classifier over the text or the transcript, before G1 and the agent and never stopped by
//      the kill switch: a match → `SAFETY_INSTRUCTION` + `open_case(SAFETY)` (safety/, until done per event)
//   4. the active order has a troubleshooting step `PENDING` → the simulated orchestrator learns that the
//      installer acted (`POST /v1/onus/{serial}/physical-action {kind: INSTALLER_STEP}`, until done per event)
//   5. the active order has a case `TAKEN` → `relay_message` to the supervisor and the end (`CP-BRIDGE`)
//   6. otherwise the agent's turn (`INSTALLER_MESSAGE`, turns/turn.ts)
import type { NetworkClient } from "../network/client";
import type { Message } from "../domain/conversations";
import type { WorkOrder } from "../domain/work-orders";
import { agentKillDecision } from "../ops/kill-switch";
import type { TurnDeps, TurnOutcome, TurnRequest } from "../turns/deps";
import { inboundOfMessage } from "../turns/facts";
import { runAgentTurn } from "../turns/turn";
import { resolveTurnOrder } from "./active-order";
import { WORKER_ACTIONS, auditOnce, workerAudit } from "./audit";
import type { InboundMessageEvent } from "./events";
import { type NoticeTarget, sendWorkerNotice } from "./notices";
import type { TranscriptionOutcome, WorkerContext, WorkerNoticeKey, WorkerPorts } from "./ports";

export interface InboundDeps {
  readonly turn: TurnDeps;
  readonly ports: WorkerPorts;
  readonly network: Pick<NetworkClient, "reportPhysicalAction">;
}

export type InboundOutcome =
  | { readonly kind: "MESSAGE_GONE" }
  | { readonly kind: "VOICE_REFUSED"; readonly notice: WorkerNoticeKey }
  | { readonly kind: "ORDER_CHOICE"; readonly safetyFired: boolean }
  | { readonly kind: "RELAYED"; readonly caseId: string; readonly safetyFired: boolean }
  | { readonly kind: "TURN"; readonly turn: TurnOutcome; readonly safetyFired: boolean };

const VOICE_NOTICES: Readonly<Record<Exclude<TranscriptionOutcome["status"], "TRANSCRIBED">, WorkerNoticeKey>> = {
  LOW_CONFIDENCE: "voiceUnclear",
  TOO_LONG: "voiceTooLong",
  FAILED: "voiceFailed",
  CAP_REACHED: "turnCap",
  PAUSED: "servicePaused",
};

/** Marks of work done per event (`IDEMP#<mark>#<eventId>`): a retried event that finished it never repeats it. */
export const ONCE = { safety: "SAFETY", physicalAction: "PHYSICAL_ACTION" } as const;

/**
 * Runs the work unless a previous delivery of the event finished it, and marks it only AFTER it ran: a
 * Lambda that dies inside it (timeout, OOM) leaves no mark, so the redelivery runs it again and safety
 * never stops (ADR-0016). The work is idempotent on its own: the safety instruction has a deterministic
 * message id, the case opens once per order and reason and a second open finishes whatever the lost
 * one left undone of its ladder and of the zone chief's email (cases/resume.ts), its audit row is
 * written once per message (safety/handler.ts) and the physical action's audit once per event; only a
 * repeated report to the simulated orchestrator remains possible, and only after a lost invocation.
 */
async function untilDone(deps: InboundDeps, mark: string, eventId: string, run: () => Promise<void>): Promise<void> {
  const { runtime } = deps.turn.data;
  if ((await runtime.getIdempotency(mark, eventId)) !== undefined) return;
  await run();
  await runtime.claimIdempotency(mark, eventId);
}

function targetOf(event: InboundMessageEvent, workOrderId: string | undefined): NoticeTarget {
  return { clockId: event.clockId, ispId: event.ispId, installerId: event.installerId, eventId: event.eventId, replyToMessageId: event.message.messageId, ...(workOrderId === undefined ? {} : { workOrderId }) };
}

/** The voice note's transcript: already stored (a retried event), transcribed now, or a fixed notice. */
async function transcribed(deps: InboundDeps, ctx: WorkerContext, event: InboundMessageEvent, message: Message, workOrderId: string | undefined): Promise<Message | WorkerNoticeKey> {
  if (message.media?.kind !== "AUDIO" || message.transcript !== undefined) return message;
  const kill = agentKillDecision(await deps.turn.budget.kill.status(event.clockId));
  const outcome: TranscriptionOutcome = kill.proceed ? await deps.ports.transcriber.transcribe({ clockId: event.clockId, ispId: event.ispId, installerId: event.installerId, message, eventId: event.eventId }, ctx) : { status: "PAUSED" };
  if (outcome.status === "TRANSCRIBED") return { ...message, transcript: { text: outcome.text, confidence: outcome.confidence } };
  const notice = VOICE_NOTICES[outcome.status];
  ctx.log.info("worker.voice_refused", { status: outcome.status, notice });
  await sendWorkerNotice({ notices: deps.ports.notices, runtime: deps.turn.data.runtime }, ctx, targetOf(event, workOrderId), notice);
  return notice;
}

async function orderOf(deps: InboundDeps, event: InboundMessageEvent, workOrderId: string | undefined): Promise<WorkOrder | undefined> {
  if (workOrderId === undefined) return undefined;
  const order = await deps.turn.data.workOrders.getWorkOrder(workOrderId);
  return order !== undefined && order.clockId === event.clockId && order.installerId === event.installerId ? order : undefined;
}

/** Step 3: the installer answered a step the agent indicated; the orchestrator's ONU reacts to the world event. */
async function reportPhysicalAction(deps: InboundDeps, ctx: WorkerContext, event: InboundMessageEvent, order: WorkOrder, atSim: string): Promise<void> {
  const steps = await deps.turn.data.workOrders.listSteps(order.workOrderId);
  if (!steps.some((step) => step.outcome === "PENDING")) return;
  await untilDone(deps, ONCE.physicalAction, event.eventId, async () => {
    const outcome = await deps.network.reportPhysicalAction({ clockId: event.clockId, serial: order.onuSerial, caller: "WORKER", atSim, kind: "INSTALLER_STEP", logger: ctx.log });
    if (outcome.kind !== "OK") ctx.log.warn("worker.physical_action_failed", { outcome: outcome.kind, ...(outcome.kind === "UNAVAILABLE" ? { reason: outcome.reason } : {}) });
    await auditOnce(workerAudit(deps.turn.data), {
      action: WORKER_ACTIONS.physicalAction,
      eventId: event.eventId,
      ispId: event.ispId,
      clockId: event.clockId,
      atSim,
      messageId: event.message.messageId,
      refs: { workOrderId: order.workOrderId },
      detail: { kind: "INSTALLER_STEP", outcome: outcome.kind },
    });
  });
}

export async function handleInboundMessage(deps: InboundDeps, ctx: WorkerContext, event: InboundMessageEvent): Promise<InboundOutcome> {
  const { data } = deps.turn;
  const stored = await data.conversations.getMessage(event.message);
  if (stored === undefined || stored.direction !== "IN" || stored.personId !== event.installerId || stored.clockId !== event.clockId) {
    ctx.log.warn("worker.message_gone", { messageId: event.message.messageId });
    return { kind: "MESSAGE_GONE" };
  }
  const state = await data.worlds.getInstallerState(event.installerId);
  const workOrderId = stored.workOrderId ?? state?.activeWorkOrderId;
  const current = await transcribed(deps, ctx, event, stored, workOrderId);
  if (typeof current === "string") return { kind: "VOICE_REFUSED", notice: current };
  const resolved = await resolveTurnOrder({ data, orderChoice: deps.ports.orderChoice }, ctx, event, current);
  const own = inboundOfMessage(current);
  const order = resolved.kind === "ORDER" ? await orderOf(deps, event, resolved.workOrderId) : undefined;
  let safetyFired = false;
  if (own.inbound !== undefined) {
    const safety = await deps.ports.safety.classify(own.inbound.text);
    if (safety.matched) {
      await untilDone(deps, ONCE.safety, event.eventId, () =>
        deps.ports.safety.handle(
          { clockId: event.clockId, ispId: event.ispId, installerId: event.installerId, category: safety.category, lexiconVersion: safety.lexiconVersion, messageId: current.messageId, eventId: event.eventId, atSim: current.sentAtSim, ...(order === undefined ? {} : { workOrderId: order.workOrderId }) },
          ctx,
        ),
      );
      safetyFired = true;
    }
  }
  if (resolved.kind === "CHOICE") return { kind: "ORDER_CHOICE", safetyFired };
  // A tap on a row of the list answers the message the list asked about (FL-013).
  const message = resolved.message;
  const { inbound, attachment, block } = message === current ? own : inboundOfMessage(message);
  if (order !== undefined) {
    await reportPhysicalAction(deps, ctx, event, order, current.sentAtSim);
    const taken = (await data.cases.listCasesOfWorkOrder(order.workOrderId)).find((caseItem) => caseItem.status === "TAKEN");
    if (taken !== undefined) {
      await deps.ports.cases.relayFromInstaller({ clockId: event.clockId, ispId: event.ispId, installerId: event.installerId, workOrderId: order.workOrderId, caseId: taken.caseId, message, eventId: event.eventId }, ctx);
      return { kind: "RELAYED", caseId: taken.caseId, safetyFired };
    }
  }
  const request: TurnRequest = {
    trigger: "INSTALLER_MESSAGE",
    eventId: event.eventId,
    clockId: event.clockId,
    ispId: event.ispId,
    installerId: event.installerId,
    eventAtSim: current.sentAtSim,
    message,
    safetyFired,
    ...(order === undefined ? {} : { workOrderId: order.workOrderId }),
    ...(inbound === undefined ? {} : { inbound }),
    ...(attachment === undefined ? {} : { attachment }),
  };
  const card = block === undefined ? undefined : { kind: block.kind, policy: block.policy, entity: block.entity };
  return { kind: "TURN", turn: await runAgentTurn(deps.turn, ctx, request, card), safetyFired };
}
