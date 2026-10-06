// The single normalizer of facts and words (docs/test-plan.md §4.3 "Normalizador único"): what the
// outbound verification compares and what the scenario runner's oracles compare, so a reading the
// pipeline accepts is the reading the oracle accepts. Pure, no `Intl`, importable from scripts/.
//
//   case and accents   lower case, accents and the tilde of "ñ" removed ("Órdenes" = "ordenes")
//   minus              every dash before a number and the word "menos" become U+2212 ("−21,4")
//   decimals           a decimal point or comma between digits becomes a comma ("21.4" = "21,4");
//                      a separator followed by exactly three digits is a thousands one and goes away
//   vocabulary         the spelled-out forms of the Transcribe vocabulary become what it displays
//                      ("o ene u" = "onu", "de be eme" = "dbm", "catorce noventa" = "1490")
//   spaces             collapsed; punctuation other than `: , − / $ § % .` becomes a space
import { VOCABULARY_ROWS } from "../../copy/transcribe-vocabulary";

/** Typographic minus of every canonical negative number. */
export const CANONICAL_MINUS = "−";

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

/** Spoken forms of the vocabulary (hyphens or spaces between the parts), longest first, with their written form. */
const VOCABULARY: readonly (readonly [RegExp, string])[] = VOCABULARY_ROWS.filter((row) => row.displayAs !== undefined)
  .map((row) => {
    const parts = stripAccents(row.phrase.toLowerCase()).split("-");
    return { parts, display: stripAccents((row.displayAs ?? "").toLowerCase()) };
  })
  .sort((a, b) => b.parts.join(" ").length - a.parts.join(" ").length)
  .map(({ parts, display }) => [new RegExp(`(?<![a-z0-9])${parts.join("[\\s-]+")}(?![a-z0-9])`, "g"), display] as const);

/** The canonical form of `text` for comparing facts and words. */
export function normalizeFacts(text: string): string {
  let value = stripAccents(text.toLowerCase());
  for (const [pattern, display] of VOCABULARY) value = value.replace(pattern, display);
  value = value
    // "menos 21.4" and every dash glued to (or one space before) a number: a minus sign.
    .replace(/(?<![a-z0-9])menos\s+(?=\d)/g, CANONICAL_MINUS)
    .replace(/(?<![\p{L}\d])[-‐‑‒–—−]\s?(?=\d)/gu, CANONICAL_MINUS)
    // Thousands separators (exactly three digits after, no more digits) go; decimal ones become a comma.
    .replace(/(\d)[.,](\d{3})(?!\d)/g, "$1$2")
    .replace(/(\d)[.,](\d{1,2})(?!\d)/g, "$1,$2")
    .replace(/[^\p{L}\d:,−/$§%.\s]/gu, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value;
}

/** The numeric value of a canonical number ("−21,4" → −21.4), or `undefined`. */
export function numberOf(canonical: string): number | undefined {
  const match = /^(−)?(\d+)(?:,(\d+))?$/.exec(canonical.trim());
  if (match === null) return undefined;
  const value = Number(`${match[2] ?? "0"}.${match[3] ?? "0"}`);
  return match[1] === undefined ? value : -value;
}

/** Whether every word (or phrase) appears in `text` once both are normalized: the oracle of transcripts. */
export function containsWords(text: string, words: readonly string[]): boolean {
  const haystack = ` ${normalizeFacts(text)} `;
  return words.every((word) => haystack.includes(` ${normalizeFacts(word)} `));
}
