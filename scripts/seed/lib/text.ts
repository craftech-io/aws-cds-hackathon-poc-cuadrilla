// Text helpers of the seed checks: a conservative token estimate for the manual's section budget,
// every string inside a JSON value (what the forbidden-terms and brand checks read), and the word
// n-grams that tell whether a question repeats a phrase of the manual (docs/seed-spec.md §14, 6-7).
import { normalizeForMatch } from "../../../packages/bff/src/copy/helpers";

/** Section budget of the manual, in tokens of the embedding model (docs/seed-spec.md §8). */
export const SECTION_TOKEN_BUDGET = 800;

/**
 * Tokens of a Spanish text, estimated from above: three characters per token (tokenizers average
 * about four for Spanish prose) or 1.6 tokens per word, whichever is larger.
 */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter((word) => word !== "").length;
  return Math.max(Math.ceil(text.length / 3), Math.ceil(words * 1.6));
}

/** Every string value inside `value`, with the JSON path where it sits. */
export function stringsOf(value: unknown, path = "$"): Array<{ readonly path: string; readonly text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringsOf(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, child]) => stringsOf(child, `${path}.${key}`));
  return [];
}

/** Words of a text as the matchers compare them: no accents, lower case, no punctuation. */
export function wordsOf(text: string): string[] {
  return normalizeForMatch(text)
    .split(" ")
    .filter((word) => word !== "");
}

/** Every run of `size` consecutive words of `text`, joined by spaces. */
export function ngramsOf(text: string, size: number): Set<string> {
  const words = wordsOf(text);
  const grams = new Set<string>();
  for (let start = 0; start + size <= words.length; start += 1) grams.add(words.slice(start, start + size).join(" "));
  return grams;
}

/** Whether `text` contains `needle` as a whole phrase, ignoring case and accents. */
export function containsPhrase(text: string, needle: string): boolean {
  const haystack = ` ${wordsOf(text).join(" ")} `;
  return haystack.includes(` ${wordsOf(needle).join(" ")} `);
}
