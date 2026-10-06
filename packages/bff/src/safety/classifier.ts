// `classify_safety` (docs/design-brief.md §5.9, ADR-0016, `SAFE-LEXICON`, `SAFE-CONSERVATIVE`): the
// deterministic classifier the worker runs on every installer text and every transcript, before G1
// and before the agent, and that the kill switch never stops. It is the versioned lexicon of
// copy/safety-lexicon.ts and nothing else: no model, no score. Conservative by design: an ambiguous
// phrase is a hazard (a false positive costs a supervisor's glance). Procedure questions that only name
// a ladder, a pole or a power line are the lexicon's negatives; the agent's `report_safety_hazard`
// covers a hazard the lexicon leaves out (the wasps of `vn-12`, FL-069).
import type { HazardCategory } from "@cuadrilla/shared";
import { SAFETY_LEXICON_VERSION, matchSafetyLexicon } from "../copy/safety-lexicon";

/** Longest text the classifier reads (a transcript is at most 2,000 characters; texts are shorter). */
export const CLASSIFIER_MAX_CHARS = 4_000;

export type SafetyClassification =
  | { readonly hazard: false; readonly lexiconVersion: string }
  | {
      readonly hazard: true;
      readonly category: HazardCategory;
      /** Lexicon entry that matched: recorded with `SAFETY_DETECTED`, never the matched text. */
      readonly entryId: string;
      readonly lexiconVersion: string;
    };

/** Whether `text` describes a hazard present on site. Never throws; an empty text is no hazard. */
export function classifySafety(text: string | undefined): SafetyClassification {
  if (text === undefined || text.trim() === "") return { hazard: false, lexiconVersion: SAFETY_LEXICON_VERSION };
  const match = matchSafetyLexicon(text.slice(0, CLASSIFIER_MAX_CHARS));
  if (match === null) return { hazard: false, lexiconVersion: SAFETY_LEXICON_VERSION };
  return { hazard: true, category: match.category, entryId: match.entryId, lexiconVersion: SAFETY_LEXICON_VERSION };
}
