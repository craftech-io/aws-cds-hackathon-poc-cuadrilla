// Which order an installer's message is about (FL-013, dayplan/active-order.ts): code decides before the
// turn, never the model.
//
//   a tap on a row of `ORDER_CHOICE` (`CHOOSE_ORDER`)   that order becomes active and the message the list
//                                                        asked about is the one the turn answers
//   any other button that names its order               that order
//   free text, a voice note or a photo                  `set_active_work_order`: the active order while it
//                                                        is pending today, the only pending one, none, or
//                                                        the `ORDER_CHOICE` list (sent once per event, no turn)
import { ToolError } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import { chooseActiveWorkOrder, resolveActiveWorkOrder, type ActiveOrderRequest } from "../dayplan/active-order";
import type { Message } from "../domain/conversations";
import type { OrderChoiceSender } from "../outbound/adapters";
import type { InboundMessageEvent } from "./events";
import type { WorkerContext } from "./ports";

export type TurnOrder = { readonly kind: "ORDER"; readonly workOrderId?: string; readonly message: Message } | { readonly kind: "CHOICE" };

export interface TurnOrderDeps {
  readonly data: Connector;
  readonly orderChoice: OrderChoiceSender;
}

/** The installer's message an `ORDER_CHOICE` list asked about (`refs.sourceMessageId` of the list). */
async function askedMessage(data: Connector, tap: Message): Promise<Message | undefined> {
  if (tap.nonce === undefined) return undefined;
  const nonce = await data.runtime.getNonce(tap.nonce);
  if (nonce?.messageId === undefined) return undefined;
  const list = await data.conversations.findMessage(tap.personId, nonce.messageId);
  const source = list?.refs?.sourceMessageId;
  if (typeof source !== "string") return undefined;
  const asked = await data.conversations.findMessage(tap.personId, source);
  return asked?.direction === "IN" ? asked : undefined;
}

export async function resolveTurnOrder(deps: TurnOrderDeps, ctx: WorkerContext, event: InboundMessageEvent, message: Message): Promise<TurnOrder> {
  const active = { connector: deps.data, logger: ctx.log };
  const request: ActiveOrderRequest = {
    ispId: event.ispId,
    clockId: event.clockId,
    installerId: event.installerId,
    atSim: message.sentAtSim,
    actor: "WORKER",
    refs: { messageId: message.messageId, eventId: event.eventId },
  };
  if (message.buttonAction === "CHOOSE_ORDER" && message.workOrderId !== undefined) {
    try {
      await chooseActiveWorkOrder(active, { ...request, workOrderId: message.workOrderId });
      const asked = await askedMessage(deps.data, message);
      return { kind: "ORDER", workOrderId: message.workOrderId, message: asked === undefined ? message : { ...asked, workOrderId: message.workOrderId } };
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      ctx.log.info("worker.order_choice_refused", { code: error.code, reason: error.reason });
    }
  } else if (message.buttonAction !== undefined && message.workOrderId !== undefined) {
    return { kind: "ORDER", workOrderId: message.workOrderId, message };
  }
  const resolution = await resolveActiveWorkOrder(active, request);
  switch (resolution.kind) {
    case "ACTIVE":
      return { kind: "ORDER", workOrderId: resolution.workOrder.workOrderId, message };
    case "NONE":
      return { kind: "ORDER", ...(message.workOrderId === undefined ? {} : { workOrderId: message.workOrderId }), message };
    case "CHOICE": {
      const sent = await deps.orderChoice.send({ clockId: event.clockId, installerId: event.installerId, choice: resolution.choice, sourceMessageId: message.messageId, atSim: message.sentAtSim, eventId: event.eventId });
      ctx.log.info("worker.order_choice", { orders: resolution.choice.workOrderIds.length, sent });
      // A list the policy held back leaves the message unanswered: the turn answers it without an order.
      return sent === "SENT" ? { kind: "CHOICE" } : { kind: "ORDER", message };
    }
  }
}
