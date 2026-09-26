// Test kit of landing.test.ts: the texts a render may draw — the main story's entries and people, the
// product texts of copy/ (the BFF's and the console's, with the story's own data where a text takes
// parameters) and the manual section of the seed — and the visible texts of a rendered HTML string.
// Nothing here is drawn by the landing; the check compares what the renders draw against it.
import { BUTTON_LABELS, PHOTO_ITEM_BUTTONS } from "@cuadrilla/bff/copy/buttons";
import { enGloss } from "@cuadrilla/bff/copy/en-gloss";
import { CERTIFICATE_LABELS, EMAIL_SENDER_NAMES, certificateFileName } from "@cuadrilla/bff/copy/es-MX-documents";
import { esMX } from "@cuadrilla/bff/copy/es-MX";
import { MAIN_STORY, STORY_CASE_LABEL, STORY_CUSTOMER, STORY_PEOPLE } from "@cuadrilla/bff/story/main-story";
import { ContactRule } from "@cuadrilla/shared";
import { PRODUCT_NAME, copy } from "../../copy/console";
import { formatSimTime } from "../../lib/world-clock";
import { MANUAL_SOURCE } from "./renders/sources";

/** Every string leaf of an object (functions are skipped: their outputs are added with real data). */
function leaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(leaves);
}

function storyTexts(): string[] {
  const orders = [...new Set(MAIN_STORY.map((entry) => entry.workOrderNumber))];
  const installer = STORY_PEOPLE["inst-rogelio"].firstName;
  return [
    ...MAIN_STORY.flatMap((entry) => [entry.text, entry.glossEn, formatSimTime(entry.atSim, copy.clock.weekdays)]),
    ...Object.values(STORY_PEOPLE).map((person) => person.firstName),
    STORY_CUSTOMER.lastName,
    STORY_CASE_LABEL,
    ...orders.flatMap((workOrderNumber) => [
      esMX.orderChoiceRow({ workOrderNumber, windowText: "", neighborhood: "" }).title,
      esMX.caseChoiceRow({ caseLabel: STORY_CASE_LABEL, workOrderNumber, installerFirstName: installer }).title,
      certificateFileName(workOrderNumber),
    ]),
  ];
}

const SOURCES: readonly string[] = [
  ...storyTexts(),
  ...leaves(esMX),
  ...leaves(enGloss),
  ...leaves(BUTTON_LABELS),
  ...leaves(PHOTO_ITEM_BUTTONS),
  ...leaves(CERTIFICATE_LABELS),
  ...leaves(EMAIL_SENDER_NAMES),
  ...leaves(copy),
  PRODUCT_NAME,
  ...ContactRule.options,
  ...MANUAL_SOURCE.split("\n"),
];

const EXACT = new Set(SOURCES);

export const RENDER_CORPUS = {
  has: (text: string) => EXACT.has(text),
  /** The text is part of one source text (a line of the manual without its Markdown, a list item). */
  contains: (text: string) => SOURCES.some((source) => source.includes(text)),
};

function decode(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The texts a person can read in `html`: text nodes and accessible names (alt, aria-label, title),
 * split where the renders join two texts with " · ", without the ones that carry no words (times,
 * counts, emoji, a lone initial).
 */
export function visibleTexts(html: string): string[] {
  const nodes = [...html.matchAll(/>([^<]+)</g)].map((match) => match[1] ?? "");
  const names = [...html.matchAll(/\s(?:alt|aria-label|title)="([^"]*)"/g)].map((match) => match[1] ?? "");
  return [...nodes, ...names]
    .map(decode)
    .flatMap((text) => text.split(" · "))
    .map((text) => text.trim())
    .filter((text) => /\p{L}\p{L}/u.test(text));
}
