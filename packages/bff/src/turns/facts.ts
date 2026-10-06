// What a turn's envelope says besides its untrusted text (docs/design-brief.md §5.2), read by code:
//
//   facts        the order (number, status, safety hold), its checklist, its open cases and the world's
//                simulated time; ids, enums, counts and instants only, never a phone, an email or a name
//   inbound      the installer's text or transcript, or a photo's caption, as the channel stored it (already
//                masked), cleaned and clipped again by the normalizer; a supervisor's closing summary
//   attachment   a photo the installer sent: only its candidate id and size, never the image (ADR-0015)
//
// agent/envelope.ts renders it; turns/invoke.ts gathers it.
import { createHash } from "node:crypto";
import type { AttachmentLine, EnvelopeEvent, FactLine } from "../agent/envelope";
import { normalizeUntrusted } from "../channels/normalizer";
import type { Connector } from "../connector/ports";
import type { Case } from "../domain/cases";
import type { Message } from "../domain/conversations";
import type { WorkOrder } from "../domain/work-orders";
import { MASK_MARKERS, type PrefilterBlock, prefilterBlock } from "../lib/mask";
import { MEXICO_CITY_TIME_ZONE, toZonedIso } from "../services/business-hours/zoned-time";
import type { TurnInbound, TurnRequest } from "./deps";

/** `candidateId` of `validate_install_photo`: the message id when the tool's pattern takes it, else a digest of it. */
const CANDIDATE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function candidateIdOf(messageId: string): string {
  return CANDIDATE_ID.test(messageId) ? messageId : `cand-${createHash("sha256").update(messageId, "utf8").digest("hex").slice(0, 40)}`;
}

const zonedSim = (iso: string): string => toZonedIso(new Date(iso), MEXICO_CITY_TIME_ZONE);

export function envelopeEvent(request: TurnRequest, workOrder: Pick<WorkOrder, "workOrderNumber"> | undefined): EnvelopeEvent {
  return { type: request.trigger, id: request.eventId, at: zonedSim(request.eventAtSim), ...(workOrder === undefined ? {} : { workOrder: workOrder.workOrderNumber }) };
}

export interface MessageInbound {
  readonly inbound?: TurnInbound;
  readonly attachment?: AttachmentLine;
  /** A card in the stored text: the turn is blocked before G1 (lib/mask.ts `prefilterBlock`, FL-078 b). */
  readonly block?: PrefilterBlock;
}

/** The untrusted part of an installer's stored message: text, transcript or caption, and the photo. */
export function inboundOfMessage(message: Message): MessageInbound {
  const transcript = message.transcript?.text;
  const isPhoto = message.media?.kind === "IMAGE";
  const raw = message.text ?? transcript;
  const attachment: AttachmentLine | undefined = isPhoto ? { kind: "IMAGE", candidateId: candidateIdOf(message.messageId), ...(message.media?.bytes === undefined ? {} : { bytes: message.media.bytes }) } : undefined;
  if (raw === undefined || raw.trim() === "") return attachment === undefined ? {} : { attachment };
  const normalized = normalizeUntrusted(raw);
  // The channel masked the card before storing it: the marker is what is left of it.
  const block = normalized.block ?? (normalized.text.includes(MASK_MARKERS.CARD) ? prefilterBlock({ kinds: ["CARD"] }) : undefined);
  const kind = message.text === undefined ? "VOICE_TRANSCRIPT" : isPhoto ? "IMAGE_CAPTION" : "TEXT";
  const inbound: TurnInbound = {
    text: normalized.text,
    kind,
    truncated: normalized.truncated,
    source: "INSTALLER",
    ...(kind === "VOICE_TRANSCRIPT" && message.transcript !== undefined ? { confidence: message.transcript.confidence } : {}),
  };
  return { inbound, ...(attachment === undefined ? {} : { attachment }), ...(block === undefined ? {} : { block }) };
}

/** What the supervisor said, for the `CASE_CLOSED` turn: the case's closing summary, as untrusted text. */
export function supervisorSummary(caseItem: Pick<Case, "closeSummary"> | undefined): TurnInbound | undefined {
  const summary = caseItem?.closeSummary;
  if (summary === undefined || summary.trim() === "") return undefined;
  const normalized = normalizeUntrusted(summary);
  return { text: normalized.text, kind: "SUPERVISOR_TEXT", truncated: normalized.truncated, source: "SUPERVISOR" };
}

/** State of the turn's order and world, by code. */
export async function envelopeFacts(data: Pick<Connector, "workOrders" | "cases">, input: { readonly workOrder?: WorkOrder; readonly simNow: string; readonly clockMode: string }): Promise<FactLine[]> {
  const facts: FactLine[] = [{ name: "clock", attributes: { simNow: zonedSim(input.simNow), mode: input.clockMode } }];
  const order = input.workOrder;
  if (order === undefined) {
    facts.push({ name: "order", attributes: { active: false } });
    return facts;
  }
  const [checklist, cases] = await Promise.all([data.workOrders.listChecklist(order.workOrderId), data.cases.listCasesOfWorkOrder(order.workOrderId)]);
  facts.push({ name: "order", attributes: { active: true, number: order.workOrderNumber, status: order.status, onHoldSafety: order.onHoldSafety, date: order.date } });
  for (const entry of checklist) facts.push({ name: "item", attributes: { name: entry.item, status: entry.status, attempts: entry.attempts } });
  for (const open of cases.filter((caseItem) => caseItem.status !== "CLOSED")) facts.push({ name: "case", attributes: { reason: open.reason, status: open.status, rung: open.rung } });
  return facts;
}
