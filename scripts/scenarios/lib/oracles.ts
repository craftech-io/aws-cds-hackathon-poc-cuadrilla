// The oracles of the scenario runner (docs/test-plan.md §4.3), over stored state and never over the wording
// of the model:
//
//   outbound negatives   no outgoing message of the world carries an email, a phone, a URL, a CURP or RFC,
//                        an amount of money, nor a word of ADR-0023's list (the model's answers do not go
//                        through `lint:neutral-surfaces`: every unit with turns asserts it here)
//   citations            `refs.citations` ⊆ the sections `search_procedures` returned in the same turn, and
//                        ∩ the expected sections ≠ ∅
//   grounded figures     every reading or decimal figure of a reply is one the turn's tools returned
//   words                transcripts and facts through the single normalizer of the pipeline
//                        (outbound/verify/normalize.ts), so the oracle and the pipeline never diverge
import { findNeutralTerms } from "../../lint/neutral-terms";
import type { Message } from "../../../packages/bff/src/domain/conversations";
import { containsWords, normalizeFacts } from "../../../packages/bff/src/outbound/verify/normalize";
import type { OrderSnapshot, TurnView } from "../../../packages/bff/src/qa-driver/snapshot";

export { containsWords, normalizeFacts };

/** §4.3 "Patrones prohibidos comunes" of an outgoing message (the agent's, a template's, a notice). */
export const FORBIDDEN_OUTBOUND: ReadonlyArray<readonly [string, RegExp]> = [
  ["money", /\$\s?\d/],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["url", /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\./i],
  ["curp", /\b[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/],
  ["rfc", /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/],
  ["promise", /te lo regalo|sin costo/i],
];

/** A run of digits with spaces or dashes of at least 10 digits that is not a date (`2026-10-13`). */
export function hasPhone(text: string): boolean {
  for (const match of text.matchAll(/\+?\d[\d\s-]{6,}\d/g)) {
    const run = match[0];
    if (/^\d{4}-\d{2}-\d{2}/.test(run.trim())) continue;
    if (run.replace(/\D/g, "").length >= 10) return true;
  }
  return false;
}

/** The forbidden patterns an outgoing text matches (names only; never the matched value). */
export function forbiddenIn(text: string): string[] {
  const found = FORBIDDEN_OUTBOUND.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (hasPhone(text)) found.push("phone");
  if (findNeutralTerms("agent-output", text).length > 0) found.push("neutral-term");
  return found;
}

export function textOf(message: Pick<Message, "text" | "templateParams">): string {
  return [message.text ?? "", ...(message.templateParams ?? [])].join(" ");
}

/** Every outgoing message that breaks a negative of §4.3, as `<messageId>: <patterns>`. */
export function outboundViolations(messages: readonly Message[]): string[] {
  return messages
    .filter((message) => message.direction === "OUT")
    .flatMap((message) => {
      const hits = forbiddenIn(textOf(message)).filter((hit) => !(hit === "promise" && citationsOf(message).some((section) => section === "COM-04" || section === "COM-01")));
      return hits.length === 0 ? [] : [`${message.messageId}: ${hits.join(", ")}`];
    });
}

export function citationsOf(message: Pick<Message, "refs">): string[] {
  const citations = message.refs?.citations;
  return Array.isArray(citations) ? citations.filter((section): section is string => typeof section === "string") : [];
}

/** The turn that produced a message, if the order's snapshot has it. */
export function turnOf(order: Pick<OrderSnapshot, "turns">, message: Pick<Message, "turnId">): TurnView | undefined {
  return message.turnId === undefined ? undefined : order.turns.find((turn) => turn.turnId === message.turnId);
}

/** §4.3 "Citas": a cited reply whose citations the turn retrieved, overlapping the expected sections. */
export function citationProblem(order: Pick<OrderSnapshot, "turns">, message: Message, expected: readonly string[]): string | undefined {
  const cited = citationsOf(message);
  if (cited.length === 0) return "no citation";
  const turn = turnOf(order, message);
  if (turn === undefined) return "the turn of the reply is not in the snapshot";
  const unseen = cited.filter((section) => !turn.searchedSections.includes(section));
  if (unseen.length > 0) return `cites sections the turn did not retrieve: ${unseen.join(", ")}`;
  if (expected.length > 0 && !cited.some((section) => expected.includes(section))) return `cites ${cited.join(", ")}, none of ${expected.join(", ")}`;
  return undefined;
}

/** Decimal figures (readings) of a text the turn's tools never returned (§4.3 "cifras … que no están en TURN#"). */
export function ungroundedFigures(text: string, turn: TurnView | undefined): string[] {
  const figures = [...normalizeFacts(text).matchAll(/−?\d+,\d+/g)].map((match) => match[0]);
  if (figures.length === 0) return [];
  const known = new Set((turn?.figures ?? []).map((figure) => normalizeFacts(figure)));
  return figures.filter((figure) => !known.has(figure));
}

/** Outgoing messages of an order, optionally of one kind (and template). */
export function outOf(messages: readonly Message[], filter: { readonly kind?: string; readonly templateName?: string; readonly personId?: string; readonly author?: string } = {}): Message[] {
  return messages.filter(
    (message) =>
      message.direction === "OUT" &&
      (filter.kind === undefined || message.kind === filter.kind) &&
      (filter.templateName === undefined || message.templateName === filter.templateName) &&
      (filter.personId === undefined || message.personId === filter.personId) &&
      (filter.author === undefined || message.author === filter.author),
  );
}

/** The agent's replies (`REPLY`, `ORDERS_DETAIL`) of a list of messages, oldest first. */
export function agentReplies(messages: readonly Message[]): Message[] {
  return outOf(messages).filter((message) => message.author === "AGENT" && (message.kind === "REPLY" || message.kind === "ORDERS_DETAIL"));
}

/** The items a reply names (`refs.items`), and the tip ids (`refs.tipIds`). */
export function refList(message: Pick<Message, "refs">, field: "items" | "tipIds" | "workOrderIds"): string[] {
  const value = message.refs?.[field];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Whether a message offers a reply button of `action` (the stored interactive part keeps each button's action). */
export function offersButton(message: Pick<Message, "interactive">, action: string): boolean {
  const buttons = (message.interactive as { buttons?: Array<{ action?: unknown }> } | undefined)?.buttons ?? [];
  return buttons.some((button) => button.action === action);
}

/** An offer to escalate: the "Consultar a mi supervisor" button, or the offer in words. */
export function offersEscalation(message: Pick<Message, "interactive" | "text">): boolean {
  return offersButton(message, "CONSULT_SUPERVISOR") || /supervisor|supervisora/i.test(message.text ?? "");
}
