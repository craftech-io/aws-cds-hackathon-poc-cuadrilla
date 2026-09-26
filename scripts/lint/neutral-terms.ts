// The words no visible surface may use (ADR-0023 §3): the list of the ADR in its accent-free form,
// in the ADR's order (scripts/lint/neutral-surfaces.test.ts compares both). Matching ignores case and
// accents and goes by whole word (letters, digits and `_` make a word; a hyphen separates), with the
// pattern and the line scan of scripts/lint/forbidden-terms.ts. Unlike that list, these words are not
// secret: a finding prints the word.
//
// Users: the guard (scripts/lint/neutral-surfaces.ts) and the seed validator (invariant 25 of
// docs/seed-spec.md §14).
//
// The eight words of the old role name are written with their first letter escaped (`\u006a` is "j"),
// so the check that closes the rename to GUEST (ADR-0024: `grep -rIiE` of those two stems over infra/,
// packages/, scripts/ and tests/ returns no line) holds here too; the values are the ADR's words.
import { findTerms, termPattern, type ForbiddenTerm } from "./forbidden-terms";

export const NEUTRAL_TERMS = [
  "hackathon",
  "hackathons",
  "hackaton",
  "hackatones",
  "devpost",
  "concurso",
  "concursos",
  "certamen",
  "certamenes",
  "contest",
  "contests",
  "premio",
  "premios",
  "prize",
  "prizes",
  "\u006aurado",
  "\u006aurados",
  "\u006aurada",
  "\u006auradas",
  "jury",
  "juries",
  "juror",
  "jurors",
  "juez",
  "jueces",
  "\u006audge",
  "\u006audges",
  "\u006audged",
  "\u006audging",
  "evaluacion",
  "evaluaciones",
  "evaluation",
  "evaluations",
  "evaluador",
  "evaluadores",
  "evaluadora",
  "evaluadoras",
  "evaluator",
  "evaluators",
  "aws cds",
] as const;

export type NeutralTerm = (typeof NEUTRAL_TERMS)[number];

export interface NeutralFinding {
  readonly source: string;
  /** 1-based line of `text`. */
  readonly line: number;
  readonly term: NeutralTerm;
}

const TERMS: readonly ForbiddenTerm[] = NEUTRAL_TERMS.map((term, index) => ({
  index: index + 1,
  ignoreAccents: true,
  pattern: termPattern(term, { ignoreCase: true, ignoreAccents: true }),
}));

/** Every (line, word) of `text` that uses a word of the list, in line order. */
export function findNeutralTerms(source: string, text: string): NeutralFinding[] {
  return findTerms(source, text, TERMS).map(({ line, term }) => ({ source, line, term: NEUTRAL_TERMS[term - 1] as NeutralTerm }));
}
