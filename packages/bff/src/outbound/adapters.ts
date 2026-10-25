// The pipeline as the other modules of the product declared it, as ports (each one a request written by
// code, `author SYSTEM`, `textSource CODE`, so the contact policy decides it and the audit log records it):
//
//   DayStartSender        dayplan/ports.ts       the `ordenes_del_dia` template with the "Ver órdenes" nonce
//   EvidenceOutboundPort  evidence/ports.ts      the `VERDICT_REACTION` to a photo and its fixed notice
//   WorkerNoticeSender    worker/ports.ts        the worker's `SYSTEM_NOTICE`s (texts of copy/es-MX.ts)
//   OrderChoiceSender     worker/active-order.ts the `ORDER_CHOICE` list of the installer's pending orders
//   OUTBOUND_SEND                                a send a person ordered from the console (or the QaDriver)
//
// Every send carries a derived `messageId`, so a redelivered event is answered from the message it
// already left (outbound/pipeline.ts `replayOf`) and never sends twice.
import { ToolError } from "@cuadrilla/shared";
import { BUTTON_LABELS, VERDICT_REACTIONS } from "../copy/buttons";
import { esMX } from "../copy/es-MX";
import type { DayStartSender, DayStartSendOutcome } from "../dayplan/ports";
import type { OrderChoice } from "../dayplan/active-order";
import type { EvidenceOutboundPort } from "../evidence/ports";
import { simNowOf } from "../lib/clock";
import { sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { OutboundSendEvent } from "../worker/events";
import type { WorkerNoticeSender } from "../worker/ports";
import type { OutboundDeps } from "./deps";
import { sendOutbound } from "./pipeline";
import type { OutboundCall, OutboundInput, OutboundResult } from "./types";

/** A Meta or simulator `wamid`: the only id a reply context or a reaction may carry. */
const WAMID = /^wamid\.[A-Za-z0-9_.:=+/-]{1,240}$/;

/** A message id derived from what makes the send the same send (event ids may carry `#`). */
export function derivedMessageId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${sha256Hex(parts.join("\n")).slice(0, 40)}`;
}

function call(logger: Logger, correlationId: string, actor: OutboundCall["actor"] = "WORKER"): OutboundCall {
  return { actor, correlationId: correlationId.slice(0, 64), log: logger };
}

function logRefused(logger: Logger, result: OutboundResult, what: string): void {
  if (result.status === "REFUSED") logger.warn("outbound.port_refused", { what, code: result.failure.error.code, reason: result.failure.error.reason, ruleIds: [...result.ruleIds] });
}

async function worldNow(deps: OutboundDeps, clockId: string): Promise<string> {
  const clock = await deps.connector.runtime.getClock(clockId);
  if (clock === undefined) throw new ToolError("NOT_FOUND", "the world of the send does not exist");
  return simNowOf(clock, (await deps.realClock.now()).getTime()).toISOString();
}

// ---- DAY_START ------------------------------------------------------------------------------------

function dayStartOutcome(result: OutboundResult): DayStartSendOutcome {
  switch (result.status) {
    case "SENT":
      return { status: "SENT", messageId: result.messageId, ruleIds: [...(result.decision?.ruleIds ?? [])] };
    case "DEFERRED":
      return { status: "DEFERRED", ruleIds: [...(result.decision?.ruleIds ?? [])], nextAllowedAt: result.nextAllowedAt };
    case "REFUSED":
      return { status: "DENIED", ruleIds: [...result.ruleIds], reason: result.failure.error.reason ?? result.failure.error.code };
  }
}

export function pipelineDayStartSender(deps: OutboundDeps, logger: Logger): DayStartSender {
  return {
    async sendDayStart(request) {
      const result = await sendOutbound(
        deps,
        {
          channel: "WHATSAPP",
          kind: "DAY_START",
          author: "SYSTEM",
          textSource: "CODE",
          personId: request.installerId,
          eventAtSim: request.eventAtSim,
          template: { name: request.templateName, params: [...request.params], buttonObjects: request.buttons.map((button) => ({ ...button.object })) },
          messageId: derivedMessageId("daystart", request.clockId, request.installerId, request.date),
          refs: { workOrderIds: [...request.workOrderIds], ...(request.timerKey === undefined ? {} : { timerKey: request.timerKey }) },
        },
        call(logger, request.correlationId),
      );
      return dayStartOutcome(result);
    },
  };
}

// ---- Evidence -------------------------------------------------------------------------------------

export function pipelineEvidenceOutbound(deps: OutboundDeps, logger: Logger): EvidenceOutboundPort {
  return {
    async reactToPhoto(request) {
      if (!WAMID.test(request.messageId)) {
        logger.warn("outbound.reaction_without_wamid", { validationId: request.validationId });
        return;
      }
      const result = await sendOutbound(
        deps,
        {
          channel: "WHATSAPP",
          kind: "VERDICT_REACTION",
          author: "SYSTEM",
          textSource: "CODE",
          personId: request.installerId,
          eventAtSim: request.atSim,
          workOrderId: request.workOrderId,
          inResponseToInbound: true,
          reaction: { wamid: request.messageId, emoji: VERDICT_REACTIONS[request.verdict] },
          messageId: derivedMessageId("react", request.validationId),
          refs: { validationId: request.validationId, verdict: request.verdict },
          ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
        },
        call(logger, request.correlationId),
      );
      logRefused(logger, result, "VERDICT_REACTION");
    },
    async photoNotice(request) {
      const result = await sendOutbound(
        deps,
        {
          channel: "WHATSAPP",
          kind: "SYSTEM_NOTICE",
          author: "SYSTEM",
          textSource: "CODE",
          personId: request.installerId,
          eventAtSim: request.atSim,
          workOrderId: request.workOrderId,
          notice: request.notice,
          text: esMX[request.notice],
          inResponseToInbound: true,
          ...(WAMID.test(request.messageId) ? { replyToWamid: request.messageId } : {}),
          messageId: derivedMessageId("ntc", request.notice, request.messageId),
          ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
        },
        call(logger, request.correlationId),
      );
      logRefused(logger, result, request.notice);
    },
  };
}

// ---- The worker's notices and lists ---------------------------------------------------------------

export function pipelineWorkerNotices(deps: OutboundDeps, logger: Logger): WorkerNoticeSender {
  return {
    async send(notice) {
      const reply = notice.replyToMessageId;
      const result = await sendOutbound(
        deps,
        {
          channel: "WHATSAPP",
          kind: "SYSTEM_NOTICE",
          author: "SYSTEM",
          textSource: "CODE",
          personId: notice.personId,
          eventAtSim: await worldNow(deps, notice.clockId),
          notice: notice.notice,
          text: notice.text,
          ...(notice.buttons === undefined ? {} : { buttons: notice.buttons.map((button) => ({ ...button })) }),
          inResponseToInbound: reply !== undefined,
          ...(reply !== undefined && WAMID.test(reply) ? { replyToWamid: reply } : {}),
          ...(notice.workOrderId === undefined ? {} : { workOrderId: notice.workOrderId }),
          messageId: derivedMessageId("ntc", notice.notice, notice.eventId),
        },
        call(logger, notice.eventId),
      );
      logRefused(logger, result, notice.notice);
    },
  };
}

export interface OrderChoiceRequest {
  readonly clockId: string;
  readonly installerId: string;
  readonly choice: OrderChoice;
  /** The installer's message the list asks about: processed in its turn once a row is chosen (FL-013). */
  readonly sourceMessageId: string;
  readonly atSim: string;
  readonly eventId: string;
}

export interface OrderChoiceSender {
  send(request: OrderChoiceRequest): Promise<"SENT" | "NOT_SENT">;
}

export function pipelineOrderChoice(deps: OutboundDeps, logger: Logger): OrderChoiceSender {
  return {
    async send(request) {
      const result = await sendOutbound(
        deps,
        {
          channel: "WHATSAPP",
          kind: "ORDER_CHOICE",
          author: "SYSTEM",
          textSource: "CODE",
          personId: request.installerId,
          eventAtSim: request.atSim,
          text: request.choice.body,
          list: { button: BUTTON_LABELS.CHOOSE_ORDER.es, rows: request.choice.rows.map((row) => ({ title: row.title, description: row.description, action: row.action, object: { ...row.object } })) },
          inResponseToInbound: true,
          ...(WAMID.test(request.sourceMessageId) ? { replyToWamid: request.sourceMessageId } : {}),
          messageId: derivedMessageId("choice", request.eventId),
          refs: { workOrderIds: [...request.choice.workOrderIds], sourceMessageId: request.sourceMessageId },
        },
        call(logger, request.eventId),
      );
      logRefused(logger, result, "ORDER_CHOICE");
      return result.status === "REFUSED" ? "NOT_SENT" : "SENT";
    },
  };
}

// ---- OUTBOUND_SEND --------------------------------------------------------------------------------

/** A send a person ordered: the pipeline validates the request and decides it with its author. */
export async function sendOrderedOutbound(deps: OutboundDeps, event: OutboundSendEvent, logger: Logger): Promise<OutboundResult> {
  const result = await sendOutbound(deps, event.request as unknown as OutboundInput, call(logger, event.eventId, event.author));
  logRefused(logger, result, "OUTBOUND_SEND");
  return result;
}
