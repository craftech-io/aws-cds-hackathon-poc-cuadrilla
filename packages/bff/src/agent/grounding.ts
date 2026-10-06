// What G2 measures a reply against, and what a refusal of G2 leaves behind (ADR-0028 §4,
// docs/design-brief.md §5.5). The outbound pipeline (WP-28) uses both:
//
//   groundingQuery(text, language)  the `query` of G2's relevance check for a `REPLY`. A message that
//                                   asks nothing (up to three words and no "?": "hola", "ok", "gracias")
//                                   is measured against the fixed status question instead: relevance
//                                   against "hola" hovers around the threshold and refused every useful
//                                   answer to it. Anything else is measured against the installer's text.
//   g2RefusalRecord(evaluation)     the fields of the `outbound.g2_refused` log line and its `AuditLog`
//                                   entry: the reason, the grounding and relevance scores and the
//                                   thresholds. Never the refused text, the query or the grounding source.
//
// The status question is not a visible text: it only travels to `ApplyGuardrail`.
import { z } from "zod";
import { Language } from "../services/language/language";

/** The fixed status question of ADR-0028, the `query` for a message that asks nothing. */
export const STATUS_QUESTION: Readonly<Record<Language, string>> = {
  es: "¿Cómo va mi orden y qué me falta?",
  en: "How is my work order going and what is missing?",
};

/** Up to this many words without a question mark is small talk, not a question. */
export const SMALL_TALK_MAX_WORDS = 3;

/** Whether the installer's text asks something: a "?" (or "¿"), or more than three words. */
export function asksSomething(text: string): boolean {
  const trimmed = text.trim();
  if (/[?¿]/.test(trimmed)) return true;
  return trimmed.split(/\s+/).filter((word) => word !== "").length > SMALL_TALK_MAX_WORDS;
}

/** The `query` of G2 for a `REPLY` to `text`: the text itself, or the status question when it asks nothing. */
export function groundingQuery(text: string, language: Language): string {
  const parsed = Language.parse(language);
  return asksSomething(text) ? text.trim() : STATUS_QUESTION[parsed];
}

/** Why G2 refused a text: grounding or relevance below its threshold, a policy block, or a text too long to check whole. */
export const G2RefusalReason = z.enum(["GROUNDING", "RELEVANCE", "BLOCKED", "TOO_LONG"]);
export type G2RefusalReason = z.infer<typeof G2RefusalReason>;

const Score = z.number().min(0).max(1);

/**
 * A refused G2 evaluation as the pipeline holds it. Whatever else it carries (the text, the query, the
 * grounding source) is dropped: the schema strips every field it does not name.
 */
export const G2Evaluation = z.object({
  reason: G2RefusalReason,
  groundingScore: Score.optional(),
  relevanceScore: Score.optional(),
  groundingThreshold: Score,
  relevanceThreshold: Score,
});
export type G2Evaluation = z.input<typeof G2Evaluation> & Readonly<Record<string, unknown>>;

export interface G2RefusalRecord {
  readonly reason: G2RefusalReason;
  readonly groundingScore?: number;
  readonly relevanceScore?: number;
  readonly groundingThreshold: number;
  readonly relevanceThreshold: number;
}

/** The record of one refusal for `outbound.g2_refused` and `AuditLog`: reason, scores and thresholds, never the text. */
export function g2RefusalRecord(evaluation: G2Evaluation): G2RefusalRecord {
  const { reason, groundingScore, relevanceScore, groundingThreshold, relevanceThreshold } = G2Evaluation.parse(evaluation);
  return {
    reason,
    ...(groundingScore === undefined ? {} : { groundingScore }),
    ...(relevanceScore === undefined ? {} : { relevanceScore }),
    groundingThreshold,
    relevanceThreshold,
  };
}
