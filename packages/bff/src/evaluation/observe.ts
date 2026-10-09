// What a question of `EV-01` left in its world (docs/test-plan.md §4.3 and §5): read from persisted state
// and the audit log, never from the model's wording. Each question has an installer and an order of its
// own, so everything of the installer's thread, the order's cases and audit, and the installer's turns
// since the question was sent belongs to that question.
//
//   replies       content messages to the installer (no read acks, no reactions, none held or denied)
//   citations     `refs.citations` of each message (plus "§XXX-00" in its text, as the pipeline reads it)
//   turnSections  sections `search_procedures` returned in those turns (`Runtime/TURN#…/RESULT#`)
//   cases         cases opened on the order; the ones a tap of "Consultar a mi supervisor" opened apart
//   guardrail     `GUARDRAIL_BLOCK` audited on the order (policy and denied topics)
//   usage         turns, tokens, turns that ended in `max_tokens`, scores and coverage of `Retrieve`
import { z } from "zod";
import type { Message } from "../domain/conversations";
import type { EvalDeps } from "./ports";
import type { ObservedCase, ObservedReply, QuestionObservation } from "./score";

type Data = EvalDeps["connector"];

export interface RetrieveStats {
  readonly scores: readonly number[];
  readonly coverage: Readonly<Record<"FOUND" | "NONE" | "UNAVAILABLE", number>>;
}

export interface QuestionUsage {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly maxTokensTurns: number;
}

export interface QuestionReading {
  readonly observation: QuestionObservation;
  readonly usage: QuestionUsage;
  readonly retrieve: RetrieveStats;
  /** From the question's arrival to the first content message to the installer (`FirstReplyLatency`). */
  readonly firstReplyLatencyMs?: number;
  /** The texts the agent wrote: the runner checks them against ADR-0023's words, never persisted. */
  readonly agentTexts: readonly string[];
}

export interface ReadWindow {
  readonly installerId: string;
  readonly workOrderId: string;
  /** Real instant the question was sent: anything older belongs to another attempt. */
  readonly sinceReal: string;
  readonly inboundMessageId?: string;
  /** Real instant of the tap, when the runner tapped the offer. */
  readonly tapAtReal?: string;
}

const NOT_CONTENT = new Set(["READ_ACK", "REACTION"]);
const NOT_REPLY_KINDS = new Set(["READ_ACK", "VERDICT_REACTION"]);
const NOT_SENT = new Set(["DENIED", "FAILED", "DEFERRED"]);
const Refs = z.looseObject({ citations: z.array(z.string()).optional() });
const Buttons = z.looseObject({ buttons: z.array(z.looseObject({ id: z.string(), action: z.string() })).optional() });
const SearchOutput = z.looseObject({ coverage: z.enum(["FOUND", "NONE", "UNAVAILABLE"]).optional(), passages: z.array(z.looseObject({ sectionId: z.string(), score: z.number().optional() })).default([]) });
const BlockDetail = z.looseObject({ policy: z.string().default("UNLISTED"), topics: z.array(z.string()).default([]) });

const after = (instant: string | undefined, since: string): boolean => instant !== undefined && Date.parse(instant) >= Date.parse(since);

/** When a message happened in real time: the transport's stamp, else the row's. */
const realOf = (message: Message): string => message.sentAtReal ?? message.createdAt;

function replyOf(message: Message): ObservedReply | undefined {
  if (message.direction !== "OUT" || NOT_CONTENT.has(message.content) || NOT_SENT.has(message.status)) return undefined;
  if (message.kind !== undefined && NOT_REPLY_KINDS.has(message.kind)) return undefined;
  const author = message.author === "AGENT" ? "AGENT" : message.author === "SYSTEM" ? "SYSTEM" : undefined;
  if (author === undefined) return undefined;
  const refs = Refs.safeParse(message.refs ?? {});
  const interactive = Buttons.safeParse(message.interactive ?? {});
  return {
    messageId: message.messageId,
    author,
    ...(message.kind === undefined ? {} : { kind: message.kind }),
    text: message.text ?? "",
    citations: refs.success ? (refs.data.citations ?? []) : [],
    buttons: interactive.success ? (interactive.data.buttons ?? []).map((button) => ({ action: button.action, nonce: button.id })) : [],
    ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
  };
}

async function retrieveOf(data: Data, turnIds: readonly string[]): Promise<{ readonly sections: string[]; readonly stats: RetrieveStats }> {
  const sections = new Set<string>();
  const scores: number[] = [];
  const coverage = { FOUND: 0, NONE: 0, UNAVAILABLE: 0 };
  for (const turnId of turnIds) {
    for (const result of await data.runtime.listTurnResults(turnId, "search_procedures")) {
      const output = SearchOutput.safeParse(result.output);
      if (!output.success) continue;
      if (output.data.coverage !== undefined) coverage[output.data.coverage] += 1;
      for (const passage of output.data.passages) {
        sections.add(passage.sectionId);
        if (passage.score !== undefined) scores.push(passage.score);
      }
    }
  }
  return { sections: [...sections].sort(), stats: { scores, coverage } };
}

async function casesOf(data: Data, window: ReadWindow): Promise<{ readonly all: ObservedCase[]; readonly tapped: string[] }> {
  const cases = (await data.cases.listCasesOfWorkOrder(window.workOrderId)).filter((entry) => after(entry.createdAt, window.sinceReal));
  const all = cases.map((entry) => ({ caseId: entry.caseId, kind: entry.kind, reason: entry.reason }));
  const tapped = window.tapAtReal === undefined ? [] : cases.filter((entry) => after(entry.createdAt, window.tapAtReal ?? "")).map((entry) => entry.caseId);
  return { all, tapped };
}

async function guardrailOf(data: Data, window: ReadWindow): Promise<QuestionObservation["guardrail"]> {
  const blocks = (await data.audit.listByWorkOrder(window.workOrderId)).filter((row) => row.action === "GUARDRAIL_BLOCK" && after(row.atReal, window.sinceReal));
  const first = blocks[0];
  if (first === undefined) return undefined;
  const detail = BlockDetail.parse(first.detail ?? {});
  return { policy: detail.policy, topics: [...new Set(blocks.flatMap((row) => BlockDetail.parse(row.detail ?? {}).topics))] };
}

/** Everything the question left, read after the installer settled. */
export async function readQuestion(data: Data, window: ReadWindow): Promise<QuestionReading> {
  const thread = (await data.conversations.listMessages(window.installerId)).filter((message) => after(message.createdAt, window.sinceReal));
  const inbound = thread.find((message) => message.direction === "IN" && (window.inboundMessageId === undefined || message.messageId === window.inboundMessageId));
  const outbound = thread.filter((message) => replyOf(message) !== undefined).sort((a, b) => Date.parse(realOf(a)) - Date.parse(realOf(b)));
  const replies = outbound.flatMap((message) => replyOf(message) ?? []);
  const notes = (await data.conversations.listTurnNotes(window.installerId, 50)).filter((note) => after(note.createdAt, window.sinceReal));
  const turnIds = [...new Set([...notes.map((note) => note.turnId), ...replies.flatMap((reply) => (reply.turnId === undefined ? [] : [reply.turnId]))])];
  const [retrieve, cases, guardrail] = await Promise.all([retrieveOf(data, turnIds), casesOf(data, window), guardrailOf(data, window)]);
  const first = outbound[0];
  const latency = first === undefined || inbound === undefined ? undefined : Math.max(0, Date.parse(realOf(first)) - Date.parse(realOf(inbound)));
  const observation: QuestionObservation = {
    replies,
    turnSections: retrieve.sections,
    cases: cases.all,
    ...(guardrail === undefined ? {} : { guardrail }),
    safetyInstruction: replies.some((reply) => reply.kind === "SAFETY_INSTRUCTION"),
    ...(window.tapAtReal === undefined ? {} : { tap: { caseIds: cases.tapped } }),
  };
  return {
    observation,
    usage: {
      turns: notes.length,
      inputTokens: notes.reduce((sum, note) => sum + (note.usage?.inputTokens ?? 0), 0),
      outputTokens: notes.reduce((sum, note) => sum + (note.usage?.outputTokens ?? 0), 0),
      maxTokensTurns: notes.filter((note) => note.stopReason === "max_tokens").length,
    },
    retrieve: retrieve.stats,
    ...(latency === undefined ? {} : { firstReplyLatencyMs: latency }),
    agentTexts: replies.filter((reply) => reply.author === "AGENT").map((reply) => reply.text),
  };
}

/** The button of an offer to escalate in the replies, if the agent made one. */
export function escalationOffer(observation: QuestionObservation): { readonly nonce: string } | undefined {
  for (const reply of observation.replies) {
    const button = reply.buttons.find((entry) => entry.action === "CONSULT_SUPERVISOR");
    if (button !== undefined) return { nonce: button.nonce };
  }
  return undefined;
}
