// Keywords and buttons, resolved by code (docs/architecture-integrations.md §4.6). copy/keywords.ts
// parses the words (case, accents and spaces ignored; only the whole message counts); this module
// decides who may use each one and runs it through the deterministic handlers, without the Harness:
//
//   ALTA            staff of the allow list        record_consent + welcome (FL-002)
//   BAJA            staff                          revoke_consent + confirmation; from a phone bound by a join
//                                                  code, the lease is released instead (FL-005)
//   TURNO           supervisor with opt-in         register_shift + "Turno registrado hasta las …" (plan B)
//   ÓRDENES         installer with opt-in          AGENT_TURN(ORDERS_REQUESTED) on the installer's queue (FL-016)
//   "Consultar a mi supervisor"   installer        open_case(OUT_OF_MANUAL), no turn (FL-031)
//   "Cerrar instalación"          installer        close_installation; NOT_COMPLETE → closeNotComplete (FL-047, FL-050)
//   "Cliente conforme"            installer        record_customer_ok
//   "Tomar caso", "No puedo", "Cerrar caso", a case of the list   supervisor → SUPERVISOR_ACTION on the
//                                  queue of the installer of the case (ADR-0017)
//
// Anything else a button asks for (see the day's orders, a reply, an order, an item) reaches the
// worker as the installer's message. "ALTA <código>" is a live-only keyword handled before identity
// (gate.ts); from a simulated identity it is an ordinary message.
import type { WaButtonAction } from "@cuadrilla/shared";
import { esMX, OPT_IN_TEXT_VERSION } from "../../copy/es-MX";
import type { Keyword } from "../../copy/keywords";
import type { Message } from "../../domain/conversations";
import type { Nonce } from "../../domain/runtime";
import { zonedParts } from "../../services/business-hours/zoned-time";
import { type StaffDeps, type StaffMessage, actionInput, messageRefOf, noticeTo } from "./context";
import { releasePhoneLease } from "./lease";
import type { SupervisorAction } from "./ports";

/** Buttons each role may tap; a nonce with another action is refused (`NONCE_ACTION`). */
export const INSTALLER_BUTTONS: readonly WaButtonAction[] = ["VIEW_ORDERS", "VIEW_REPLY", "CHOOSE_ORDER", "CHOOSE_ITEM", "CONSULT_SUPERVISOR", "NO_THANKS", "CUSTOMER_OK", "CLOSE_INSTALLATION"];
export const SUPERVISOR_BUTTONS: readonly WaButtonAction[] = ["TAKE_CASE", "DECLINE_CASE", "CLOSE_CASE", "CHOOSE_CASE"];

/** ALTA and BAJA work without opt-in; TURNO and ÓRDENES need it. */
export function worksWithoutConsent(keyword: Keyword): boolean {
  return keyword.kind === "ALTA" || keyword.kind === "BAJA";
}

export type KeywordOutcome = "CONSENT_GRANTED" | "CONSENT_REVOKED" | "OPT_OUT_REPEATED" | "LEASE_RELEASED" | "SHIFT_REGISTERED" | "ORDERS_REQUESTED";

async function queueOrdersRequested(staff: StaffMessage, deps: StaffDeps): Promise<void> {
  await deps.queue.enqueue({ type: "AGENT_TURN", trigger: "ORDERS_REQUESTED", eventId: staff.eventId, clockId: staff.clockId, ispId: staff.ispId, installerId: staff.person.personId, message: messageRefOf(staff.message) });
}

/**
 * Runs a keyword for this staff member, or returns `undefined` when it is not one for them (a
 * supervisor writing "ÓRDENES", an installer writing "TURNO", a join code from a simulated phone):
 * then the message goes on as any other. `consented` is the opt-in in force.
 */
export async function handleKeyword(keyword: Keyword, staff: StaffMessage, consented: boolean, deps: StaffDeps): Promise<KeywordOutcome | undefined> {
  const { person } = staff;
  const role = person.role === "SUPERVISOR" ? "SUPERVISOR" : "INSTALLER";
  switch (keyword.kind) {
    case "ALTA":
      await deps.actions.recordConsent({ ...actionInput(staff), textVersion: OPT_IN_TEXT_VERSION });
      await deps.notices.send(noticeTo(staff, "welcome", esMX.welcome(person.firstName, role)));
      return "CONSENT_GRANTED";
    case "BAJA": {
      // A phone bound by a join code opts out of the judge's world by giving the person back: the
      // synthetic person keeps its consent, so the judge's simulator keeps working.
      const lease = staff.sender.lease;
      if (lease === undefined && consented) await deps.actions.revokeConsent(actionInput(staff));
      await deps.notices.send(noticeTo(staff, "optOutConfirmed", esMX.optOutConfirmed));
      if (lease !== undefined) await releasePhoneLease(lease, "OPT_OUT", { worlds: deps.connector.worlds, audit: deps.connector.audit });
      return lease !== undefined ? "LEASE_RELEASED" : consented ? "CONSENT_REVOKED" : "OPT_OUT_REPEATED";
    }
    case "TURNO": {
      if (role !== "SUPERVISOR" || !consented) return undefined;
      const { closesAtSim } = await deps.actions.registerShift(actionInput(staff));
      await deps.notices.send(noticeTo(staff, "shiftRegistered", esMX.shiftRegistered(zonedParts(new Date(closesAtSim), staff.timeZone).time)));
      return "SHIFT_REGISTERED";
    }
    case "ORDENES":
      if (role !== "INSTALLER" || !consented) return undefined;
      await queueOrdersRequested(staff, deps);
      return "ORDERS_REQUESTED";
    case "ALTA_CODE":
      return undefined;
  }
}

export type ButtonOutcome = "CASE_OPENED" | "INSTALLATION_CLOSED" | "CLOSE_NOT_COMPLETE" | "CLOSE_FAILED" | "CUSTOMER_OK" | "ORDERS_REQUESTED" | "QUEUED" | "SUPERVISOR_QUEUED" | "OBJECT_GONE";

/** Whether the tap starts a turn or a worker step, so the message gets the read receipt. */
export function isQueuedOutcome(outcome: ButtonOutcome): boolean {
  return outcome === "ORDERS_REQUESTED" || outcome === "QUEUED";
}

/** What the summary of an `OUT_OF_MANUAL` case is built from (FL-031): the last question and the offer's sections. */
async function consultBasis(nonce: Nonce, staff: StaffMessage, deps: StaffDeps): Promise<{ question?: string; citations: string[] }> {
  const { conversations } = deps.connector;
  const offer = nonce.messageId === undefined ? undefined : await conversations.findMessage(staff.person.personId, nonce.messageId);
  const cited = offer?.refs?.citations;
  const citations = Array.isArray(cited) ? cited.filter((value): value is string => typeof value === "string") : [];
  const before = await conversations.listMessages(staff.person.personId, { ...(offer === undefined ? {} : { toSim: offer.sentAtSim }), descending: true, limit: 20 });
  const asked = before.find((message: Message) => message.direction === "IN" && message.messageId !== staff.message.messageId && (message.text ?? message.transcript?.text) !== undefined);
  const question = asked?.text ?? asked?.transcript?.text;
  return question === undefined ? { citations } : { question, citations };
}

async function supervisorAction(action: SupervisorAction, caseId: string, staff: StaffMessage, deps: StaffDeps, message: Message = staff.message): Promise<ButtonOutcome> {
  const found = await deps.connector.cases.getCase(caseId);
  if (found === undefined || found.clockId !== staff.clockId) return "OBJECT_GONE";
  await deps.queue.enqueue({
    type: "SUPERVISOR_ACTION",
    action,
    eventId: staff.eventId,
    clockId: staff.clockId,
    ispId: staff.ispId,
    installerId: found.installerId,
    supervisorId: staff.person.personId,
    caseId,
    message: messageRefOf(message),
  });
  return "SUPERVISOR_QUEUED";
}

/** Runs a resolved button tap (the nonce already matched this phone, world and role). */
export async function handleButton(nonce: Nonce, staff: StaffMessage, deps: StaffDeps): Promise<ButtonOutcome> {
  const object = nonce.object;
  const onOrder = object.kind === "WORK_ORDER" ? { ...actionInput(staff), workOrderId: object.id } : undefined;
  switch (nonce.action) {
    case "CONSULT_SUPERVISOR":
      if (onOrder === undefined) return "OBJECT_GONE";
      await deps.actions.openConsultCase({ ...onOrder, ...(await consultBasis(nonce, staff, deps)) });
      return "CASE_OPENED";
    case "CLOSE_INSTALLATION": {
      if (onOrder === undefined) return "OBJECT_GONE";
      const outcome = await deps.actions.closeInstallation(onOrder);
      if (outcome.ok) return "INSTALLATION_CLOSED";
      if (outcome.code !== "NOT_COMPLETE") return "CLOSE_FAILED";
      await deps.notices.send(noticeTo(staff, "closeNotComplete", esMX.closeNotComplete(outcome.missing), { refs: { items: [...outcome.missing], workOrderId: object.id } }));
      return "CLOSE_NOT_COMPLETE";
    }
    case "CUSTOMER_OK":
      if (onOrder === undefined) return "OBJECT_GONE";
      await deps.actions.recordCustomerOk(onOrder);
      return "CUSTOMER_OK";
    case "VIEW_ORDERS":
      await queueOrdersRequested(staff, deps);
      return "ORDERS_REQUESTED";
    case "TAKE_CASE":
    case "DECLINE_CASE":
    case "CLOSE_CASE":
      return object.kind === "CASE" ? supervisorAction(nonce.action, object.id, staff, deps) : "OBJECT_GONE";
    case "CHOOSE_CASE": {
      if (object.kind !== "CASE") return "OBJECT_GONE";
      const pending = nonce.messageId === undefined ? undefined : await deps.connector.conversations.findMessage(staff.person.personId, nonce.messageId);
      return pending === undefined ? "OBJECT_GONE" : supervisorAction("RELAY", object.id, staff, deps, pending);
    }
    default:
      await deps.queue.enqueue({ type: "INBOUND_MESSAGE", eventId: staff.eventId, clockId: staff.clockId, ispId: staff.ispId, installerId: staff.person.personId, message: messageRefOf(staff.message) });
      return "QUEUED";
  }
}
