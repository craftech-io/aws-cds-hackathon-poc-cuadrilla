// A button an installer tapped on a work order (docs/architecture-integrations.md §4.6), as the
// InstallerWorker runs it: InboundWhatsApp resolved the nonce and queued a `BUTTON_ACTION` on the
// installer's message group (ADR-0017), so the tap never races a turn of the same installer that is
// updating the checklist, and it runs with the worker's roles (PIPELINE for the notices and the
// certificate deliveries, TIMERS for the case ladder, MOCK_NETWORK for the ONU reading of
// `close_installation`, CertificateWriter invoke). No Harness, no turn:
//
//   "Consultar a mi supervisor"   open_case(OUT_OF_MANUAL) with the last question and the offer's sections (FL-031)
//   "Cerrar instalación"          close_installation(INSTALLED); NOT_COMPLETE → closeNotComplete (FL-047, FL-050)
//   "Cliente conforme"            record_customer_ok
import type { Connector } from "../../connector/ports";
import { esMX } from "../../copy/es-MX";
import type { Message } from "../../domain/conversations";
import type { ChannelQueueEvent, InstallerNoticeSender, WorkOrderActionInput, WorkOrderActions } from "./ports";

export type ButtonActionEvent = Extract<ChannelQueueEvent, { readonly type: "BUTTON_ACTION" }>;

export type ButtonActionOutcome = "CASE_OPENED" | "INSTALLATION_CLOSED" | "CLOSE_NOT_COMPLETE" | "CLOSE_FAILED" | "CUSTOMER_OK";

export interface ButtonActionDeps {
  readonly connector: Pick<Connector, "conversations">;
  readonly actions: WorkOrderActions;
  readonly notices: InstallerNoticeSender;
}

/** The input of the deterministic handler for the tap (`caller CHANNEL`), from the queued event alone. */
function actionInputOf(event: ButtonActionEvent): WorkOrderActionInput {
  return {
    clockId: event.clockId,
    ispId: event.ispId,
    personId: event.installerId,
    atSim: event.message.sentAtSim,
    sourceMessageId: event.message.messageId,
    eventId: event.eventId,
    workOrderId: event.workOrderId,
  };
}

/** What the summary of an `OUT_OF_MANUAL` case is built from (FL-031): the last question and the offer's sections. */
async function consultBasis(event: ButtonActionEvent, deps: ButtonActionDeps): Promise<{ question?: string; citations: string[] }> {
  const { conversations } = deps.connector;
  const offer = event.offerMessageId === undefined ? undefined : await conversations.findMessage(event.installerId, event.offerMessageId);
  const cited = offer?.refs?.citations;
  const citations = Array.isArray(cited) ? cited.filter((value): value is string => typeof value === "string") : [];
  const before = await conversations.listMessages(event.installerId, { ...(offer === undefined ? {} : { toSim: offer.sentAtSim }), descending: true, limit: 20 });
  const asked = before.find((message: Message) => message.direction === "IN" && message.messageId !== event.message.messageId && (message.text ?? message.transcript?.text) !== undefined);
  const question = asked?.text ?? asked?.transcript?.text;
  return question === undefined ? { citations } : { question, citations };
}

/** Runs a queued tap; the worker's idempotency (`IDEMP#BUTTON_ACTION#<eventId>`) keeps a redelivery from repeating it. */
export async function runButtonAction(event: ButtonActionEvent, deps: ButtonActionDeps): Promise<ButtonActionOutcome> {
  const input = actionInputOf(event);
  switch (event.action) {
    case "CONSULT_SUPERVISOR":
      await deps.actions.openConsultCase({ ...input, ...(await consultBasis(event, deps)) });
      return "CASE_OPENED";
    case "CLOSE_INSTALLATION": {
      const outcome = await deps.actions.closeInstallation(input);
      if (outcome.ok) return "INSTALLATION_CLOSED";
      if (outcome.code !== "NOT_COMPLETE") return "CLOSE_FAILED";
      await deps.notices.send({
        clockId: event.clockId,
        ispId: event.ispId,
        personId: event.installerId,
        notice: "closeNotComplete",
        text: esMX.closeNotComplete(outcome.missing),
        replyToWamid: event.message.messageId,
        refs: { items: [...outcome.missing], workOrderId: event.workOrderId },
      });
      return "CLOSE_NOT_COMPLETE";
    }
    case "CUSTOMER_OK":
      await deps.actions.recordCustomerOk(input);
      return "CUSTOMER_OK";
  }
}
