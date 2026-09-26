// Small pure builders shared by the copy packs, the keyword parser, the safety lexicon and the
// outbound text checks. No `Intl` and no `toLocale*`: the seed generator imports copy/ and its output
// has to be byte-for-byte reproducible on any machine (scripts/lint/no-intl.ts).
import { ChecklistItem } from "@cuadrilla/shared";

/** Items in the order of the checklist (manual §EVI-01), without repeats. */
export function inChecklistOrder(items: readonly ChecklistItem[]): ChecklistItem[] {
  return ChecklistItem.options.filter((item) => items.includes(item));
}

/**
 * Text as the matchers compare it: accents and the tilde of "ñ" removed, lower case, every
 * character that is not a letter or a digit turned into a space, spaces collapsed. "¿Órdenes?" and
 * "ordenes" normalize to the same string.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** "a", "a y b", "a, b y c": the list as Spanish writes it. */
export function listInSpanish(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1] ?? ""}`;
}

/** "a", "a and b", "a, b and c": the same list for the English gloss. */
export function listInEnglish(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

/** Typographic minus sign (U+2212) of every negative reading the staff sees on WhatsApp. */
export const MINUS_SIGN = "−";

/**
 * "−21,4": a comma decimal with a fixed number of digits and a typographic minus. `ascii` swaps the
 * minus for "-" (the PDF writer's standard fonts have no U+2212).
 */
export function formatDecimal(value: number, digits = 1, ascii = false): string {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  const fixed = Math.abs(value).toFixed(digits).replace(".", ",");
  const negative = value < 0 && Number(fixed.replace(",", ".")) !== 0;
  return `${negative ? (ascii ? "-" : MINUS_SIGN) : ""}${fixed}`;
}

/** "−21,4 dBm". */
export function formatDbm(value: number, ascii = false): string {
  return `${formatDecimal(value, 1, ascii)} dBm`;
}

/** "09:00 a 11:00": an appointment window from two `HH:MM` strings. */
export function formatWindow(start: string, end: string): string {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(start) || !time.test(end)) throw new RangeError(`expected HH:MM times, got "${start}" and "${end}"`);
  return `${start} a ${end}`;
}

/** Number of `{{n}}` placeholders a body declares, checking they are `{{1}}`…`{{n}}` in order. */
export function placeholderCount(body: string): number {
  const found = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  found.forEach((value, index) => {
    if (value !== index + 1) throw new Error(`placeholders must be {{1}}…{{n}} in order; found {{${value}}} at position ${index + 1}`);
  });
  return found.length;
}

/** Replaces `{{1}}`…`{{n}}` with `params`, which must have exactly one value per placeholder. */
export function fillPlaceholders(body: string, params: readonly string[]): string {
  const count = placeholderCount(body);
  if (params.length !== count) throw new Error(`expected ${count} parameter(s), got ${params.length}`);
  return body.replace(/\{\{(\d+)\}\}/g, (_, index: string) => params[Number(index) - 1] ?? "");
}
