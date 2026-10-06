// The bridge (docs/design-brief.md §5.8, `relay_message` / `deliver_pending_relays` / `close_case`):
// while a case is TAKEN, what the installer and the supervisor write about the order passes from one
// to the other with the author's name as prefix, masked, with no model (`CP-BRIDGE`: the agent does
// not speak meanwhile). A supervisor's message that cannot reach the installer as text (the
// installer's 24 h window is closed, `CP-WA-24H`) waits in `bridge.pendingRelays` and the installer
// gets `respuesta_supervisor`; its "Ver respuesta" delivers what waits, in order. A supervisor's
// message that reaches the installer is the fix being carried out: `SUPERVISOR_FIX` to the network
// orchestrator. "Cerrar caso" (or the console) closes the bridge, lifts a safety hold and queues
// `AGENT_TURN(CASE_CLOSED)` with what was said, so the agent resumes.
import { esMX } from "../copy/es-MX";
import type { Case, PendingRelay } from "../domain/cases";
import type { Message } from "../domain/conversations";
import { caseMessageId } from "./notify";
import type { CaseDeps, CaseMedia, CaseSendOutcome } from "./ports";
import { SUMMARY_MAX, cleanSummary } from "./summary";
import { type CaseActionInput, actorOfCase } from "./take";
import { cancelRungTimeouts } from "./timeouts";

export type RelayOutcome = "RELAYED" | "PENDING" | "NOT_TAKEN" | "NOT_HOLDER";

const SENT: ReadonlySet<Message["status"]> = new Set<Message["status"]>(["SENT", "DELIVERED", "READ"]);

function textOf(message: Message): string | undefined {
  return message.text ?? message.transcript?.text;
}

function imageOf(message: Message): CaseMedia | undefined {
  return message.media?.kind === "IMAGE" ? { bucket: "MEDIA", s3Key: message.media.s3Key, mime: message.media.mime } : undefined;
}

async function auditRelay(deps: CaseDeps, caseItem: Case, message: Message, direction: "TO_INSTALLER" | "TO_SUPERVISOR", outcome: RelayOutcome): Promise<void> {
  await deps.connector.audit.append({
    ispId: caseItem.ispId,
    clockId: caseItem.clockId,
    atSim: message.sentAtSim,
    decision: "ACTION",
    action: outcome === "PENDING" ? "RELAY_PENDING" : "RELAYED",
    ruleIds: ["CP-BRIDGE"],
    actor: `PERSON:${message.personId}`,
    messageId: message.messageId,
    refs: { caseId: caseItem.caseId, workOrderId: caseItem.workOrderId },
    detail: { direction },
  });
}

/** One relayed message: the original's masked text with the author's prefix, or its photo with the prefix as caption. */
async function relay(deps: CaseDeps, caseItem: Case, original: Message, to: string, prefix: string, atSim: string, tag = "relay"): Promise<CaseSendOutcome> {
  const base = {
    clockId: caseItem.clockId,
    ispId: caseItem.ispId,
    personId: to,
    kind: "RELAY",
    author: `PERSON:${original.personId}`,
    caseId: caseItem.caseId,
    workOrderId: caseItem.workOrderId,
    atSim,
    messageId: caseMessageId(caseItem.caseId, tag, original.messageId.replace(/[^A-Za-z0-9_.:=+/-]/g, "").slice(-80)),
    refs: { caseId: caseItem.caseId, relayOf: original.messageId },
  } as const;
  const image = imageOf(original);
  const text = textOf(original);
  if (image !== undefined) return deps.outbound.sendWhatsApp({ ...base, form: "IMAGE", media: image, caption: cleanSummary(`${prefix}${text ?? ""}`, 1024) });
  return deps.outbound.sendWhatsApp({ ...base, form: "TEXT", text: cleanSummary(`${prefix}${text ?? ""}`, 4096) });
}

/** The supervisor's fix reached the installer: the world's ONU learns it (LOW_POWER_THEN_OK). */
async function reportFix(deps: CaseDeps, caseItem: Case, atSim: string): Promise<void> {
  const order = await deps.connector.workOrders.getWorkOrder(caseItem.workOrderId);
  if (order === undefined) return;
  const outcome = await deps.network.reportPhysicalAction({ clockId: caseItem.clockId, serial: order.onuSerial, caller: "WORKER", atSim, kind: "SUPERVISOR_FIX", logger: deps.logger });
  if (outcome.kind !== "OK") deps.logger.warn("case.bridge.fix_not_reported", { caseId: caseItem.caseId, outcome: outcome.kind });
}

async function addPending(deps: CaseDeps, caseItem: Case, pending: PendingRelay): Promise<Case> {
  if (caseItem.bridge.pendingRelays.some((item) => item.messageId === pending.messageId)) return caseItem;
  return deps.connector.cases.updateCase(caseItem.caseId, { bridge: { open: caseItem.bridge.open, pendingRelays: [...caseItem.bridge.pendingRelays, pending] } }, { status: ["TAKEN"] });
}

/** `relay_message` supervisor → installer (`SUPERVISOR_ACTION RELAY`). */
export async function relayFromSupervisor(deps: CaseDeps, caseId: string, message: Message): Promise<RelayOutcome> {
  const caseItem = await deps.connector.cases.requireCase(caseId);
  if (caseItem.status !== "TAKEN") return "NOT_TAKEN";
  if (caseItem.takenBy !== message.personId) return "NOT_HOLDER";
  const supervisor = await deps.connector.people.requirePerson(message.personId);
  const sent = await relay(deps, caseItem, message, caseItem.installerId, esMX.relayPrefix(supervisor.firstName, "SUPERVISOR"), message.sentAtSim);
  if (sent.status !== "DENIED") {
    await auditRelay(deps, caseItem, message, "TO_INSTALLER", "RELAYED");
    await reportFix(deps, caseItem, message.sentAtSim);
    return "RELAYED";
  }
  // The installer's window is closed: keep it and send the template that reopens it ("Ver respuesta").
  const hadPending = caseItem.bridge.pendingRelays.some((item) => item.from === "SUPERVISOR");
  const updated = await addPending(deps, caseItem, { messageId: message.messageId, from: "SUPERVISOR", atSim: message.sentAtSim });
  if (!hadPending) {
    const order = await deps.connector.workOrders.requireWorkOrder(caseItem.workOrderId);
    await deps.outbound.sendWhatsApp({
      clockId: caseItem.clockId,
      ispId: caseItem.ispId,
      personId: caseItem.installerId,
      kind: "SUPERVISOR_REPLY_TEMPLATE",
      author: "SYSTEM",
      caseId: caseItem.caseId,
      workOrderId: caseItem.workOrderId,
      atSim: message.sentAtSim,
      form: "TEMPLATE",
      templateName: "respuesta_supervisor",
      params: [supervisor.firstName, order.workOrderNumber],
      buttons: [{ action: "VIEW_REPLY", object: { kind: "CASE", id: caseItem.caseId } }],
      messageId: caseMessageId(caseItem.caseId, "reply-template", updated.bridge.pendingRelays.length),
      refs: { caseId: caseItem.caseId },
    });
  }
  await auditRelay(deps, caseItem, message, "TO_INSTALLER", "PENDING");
  return "PENDING";
}

/** "Ver respuesta": the supervisor's messages that waited, in order; the installer's tap opened the window. */
export async function deliverPendingRelays(deps: CaseDeps, caseId: string, atSim: string): Promise<number> {
  let caseItem = await deps.connector.cases.requireCase(caseId);
  const waiting = [...caseItem.bridge.pendingRelays].filter((item) => item.from === "SUPERVISOR").sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim));
  const holder = caseItem.takenBy;
  if (waiting.length === 0 || holder === undefined) return 0;
  const supervisor = await deps.connector.people.requirePerson(holder);
  let delivered = 0;
  for (const pending of waiting) {
    const original = await deps.connector.conversations.findMessage(holder, pending.messageId);
    const sent = original === undefined ? undefined : await relay(deps, caseItem, original, caseItem.installerId, esMX.relayPrefix(supervisor.firstName, "SUPERVISOR"), atSim, "relay-pending");
    if (sent?.status === "DENIED") break;
    caseItem = await deps.connector.cases.updateCase(
      caseItem.caseId,
      { bridge: { open: caseItem.bridge.open, pendingRelays: caseItem.bridge.pendingRelays.filter((item) => item.messageId !== pending.messageId) } },
      {},
    );
    if (sent !== undefined) delivered += 1;
  }
  if (delivered > 0 && caseItem.status === "TAKEN") await reportFix(deps, caseItem, atSim);
  return delivered;
}

/**
 * `relay_message` installer → supervisor: an installer's message on an order with a case TAKEN never
 * reaches the agent (`CP-BRIDGE`). A photo goes as a photo and is not validated. A tap on
 * "Ver respuesta" delivers what waits instead of being relayed.
 */
export async function relayFromInstaller(deps: CaseDeps, caseItem: Case, message: Message): Promise<RelayOutcome> {
  if (caseItem.status !== "TAKEN" || caseItem.takenBy === undefined) return "NOT_TAKEN";
  if (message.personId !== caseItem.installerId) return "NOT_HOLDER";
  if (message.buttonAction === "VIEW_REPLY") {
    await deliverPendingRelays(deps, caseItem.caseId, message.sentAtSim);
    return "RELAYED";
  }
  const installer = await deps.connector.people.requirePerson(message.personId);
  const sent = await relay(deps, caseItem, message, caseItem.takenBy, esMX.relayPrefix(installer.firstName, "INSTALLER"), message.sentAtSim);
  if (sent.status === "DENIED") {
    await addPending(deps, caseItem, { messageId: message.messageId, from: "INSTALLER", atSim: message.sentAtSim });
    await auditRelay(deps, caseItem, message, "TO_SUPERVISOR", "PENDING");
    return "PENDING";
  }
  await auditRelay(deps, caseItem, message, "TO_SUPERVISOR", "RELAYED");
  return "RELAYED";
}

/** What was said over the bridge, for the agent's `CASE_CLOSED` turn: the relayed texts, masked, oldest first. */
export async function bridgeTranscript(deps: Pick<CaseDeps, "connector">, caseItem: Case): Promise<string> {
  const timeline = await deps.connector.conversations.listTimeline(caseItem.workOrderId);
  const relays = timeline
    .filter((entry): entry is Message => entry.entity === "Message" && entry.kind === "RELAY" && entry.caseId === caseItem.caseId && SENT.has(entry.status))
    .sort((a, b) => Date.parse(a.sentAtSim) - Date.parse(b.sentAtSim))
    .map((entry) => entry.text ?? "")
    .filter((text) => text !== "");
  return cleanSummary(relays.join(" / "), SUMMARY_MAX);
}

export type CloseCaseOutcome = "CLOSED" | "ALREADY_CLOSED" | "NOT_HOLDER";

/** `close_case`: by the supervisor who holds it (WhatsApp) or from the console. */
export async function closeCase(deps: CaseDeps, input: CaseActionInput): Promise<{ readonly outcome: CloseCaseOutcome; readonly caseItem: Case }> {
  const current = await deps.connector.cases.requireCase(input.caseId);
  const fromWhatsApp = input.actor.via === "WHATSAPP";
  const reply = async (text: string, notice: string, tag: string) => {
    if (input.actor.via !== "WHATSAPP") return;
    await deps.outbound.sendWhatsApp({
      clockId: current.clockId,
      ispId: current.ispId,
      personId: input.actor.supervisorId,
      kind: "SYSTEM_NOTICE",
      notice,
      author: "SYSTEM",
      caseId: current.caseId,
      workOrderId: current.workOrderId,
      atSim: input.atSim,
      form: "TEXT",
      text,
      inResponseToInbound: true,
      messageId: caseMessageId(current.caseId, tag, input.actor.supervisorId),
    });
  };
  if (current.status === "CLOSED") {
    await reply(esMX.caseAlreadyClosed, "caseAlreadyClosed", "closed");
    return { outcome: "ALREADY_CLOSED", caseItem: current };
  }
  if (fromWhatsApp && current.takenBy !== input.actor.supervisorId) return { outcome: "NOT_HOLDER", caseItem: current };

  const transcript = await bridgeTranscript(deps, current);
  const closed = await deps.connector.cases.closeCase(current.caseId, { closeSummary: transcript }, { actor: actorOfCase(input.actor), atSim: input.atSim, reason: input.actor.via });
  await cancelRungTimeouts(deps, closed.caseId, "closed");
  if (closed.kind === "SAFETY") {
    const others = (await deps.connector.cases.listCasesOfWorkOrder(closed.workOrderId)).filter((item) => item.kind === "SAFETY" && item.status !== "CLOSED" && item.caseId !== closed.caseId);
    if (others.length === 0) await deps.connector.workOrders.setOnHoldSafety(closed.workOrderId, false, { actor: actorOfCase(input.actor), atSim: input.atSim, reason: "safety case closed" });
  }
  await deps.connector.audit.append({
    ispId: closed.ispId,
    clockId: closed.clockId,
    atSim: input.atSim,
    decision: "ACTION",
    action: "CASE_CLOSED",
    ruleIds: ["LAD-CLOSE"],
    actor: actorOfCase(input.actor),
    refs: { caseId: closed.caseId, workOrderId: closed.workOrderId },
    detail: { via: input.actor.via, wasTaken: current.status === "TAKEN" },
  });
  const order = await deps.connector.workOrders.requireWorkOrder(closed.workOrderId);
  const installer = await deps.connector.people.requirePerson(closed.installerId);
  await reply(esMX.caseClosedConfirmation(order.workOrderNumber, installer.firstName), "caseClosedConfirmation", "close-confirm");
  await deps.turns.enqueueCaseClosed({
    clockId: closed.clockId,
    ispId: closed.ispId,
    installerId: closed.installerId,
    workOrderId: closed.workOrderId,
    caseId: closed.caseId,
    summary: transcript,
    atSim: input.atSim,
    eventId: `case-closed-${closed.caseId}`,
  });
  return { outcome: "CLOSED", caseItem: closed };
}

