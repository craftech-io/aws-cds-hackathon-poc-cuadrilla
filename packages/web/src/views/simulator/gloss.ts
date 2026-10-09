// The English gloss of what the phone shows (ADR-0013): behind "EN", a guest who does not read Spanish
// follows the story. The gloss is never written here: it comes from the BFF's one source of each text,
// matched against the Spanish the bubble shows:
//
//   1. the main story's messages (story/main-story.ts, `glossEn` next to each one)
//   2. button labels (copy/buttons.ts)
//   3. the six templates (copy/templates.ts → `TEMPLATE_GLOSS`, same placeholders)
//   4. every fixed text of copy/es-MX.ts (→ copy/en-gloss.ts, same key and arguments)
//   5. a relayed message: the fixed prefix of the bridge, then the gloss of what was relayed
//
// A free reply of the agent has no gloss (the model writes it in Spanish only), so it shows no "EN".
// No React here: gloss.test.ts.
import { BUTTON_LABELS, PHOTO_ITEM_BUTTONS } from "@cuadrilla/bff/copy/buttons";
import { TEMPLATE_GLOSS, enGloss } from "@cuadrilla/bff/copy/en-gloss";
import { esMX } from "@cuadrilla/bff/copy/es-MX";
import { TEMPLATES } from "@cuadrilla/bff/copy/templates";
import type { CopyPack, StaffRole } from "@cuadrilla/bff/copy/types";
import { MAIN_STORY } from "@cuadrilla/bff/story/main-story";
import { CaseReason, ChecklistItem, PhotoItem, RejectReason, Symptom, type TemplateName } from "@cuadrilla/shared";

/** Spanish → English of every whole text the copy produces with fixed or enumerable arguments. */
type Dictionary = Map<string, string>;

function put(dictionary: Dictionary, es: string, en: string): void {
  if (es !== "" && !dictionary.has(es)) dictionary.set(es, en);
}

/** String leaves of a copy pack and its gloss, key by key (`hazard.ELECTRICAL`, `optInRequired`, …). */
function leaves(dictionary: Dictionary, es: unknown, en: unknown): void {
  if (typeof es === "string" && typeof en === "string") return put(dictionary, es, en);
  if (es === null || en === null || typeof es !== "object" || typeof en !== "object") return;
  for (const [key, value] of Object.entries(es)) leaves(dictionary, value, (en as Record<string, unknown>)[key]);
}

/** Every subset of the checklist, for "Faltan: …" (closeNotComplete keeps the checklist order itself). */
function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((all, item) => [...all, ...all.map((subset) => [...subset, item])], [[]]);
}

type CaseReasonInput = Parameters<CopyPack["caseReason"]>[0];

function caseReasons(): CaseReasonInput[] {
  return CaseReason.options.flatMap((reason): CaseReasonInput[] => {
    if (reason === "DIAGNOSIS_ATTEMPTS") return Symptom.options.map((symptom) => ({ reason, symptom }));
    if (reason === "PHOTO_ATTEMPTS") return [{ reason }, ...PhotoItem.options.map((item) => ({ reason, item }))];
    if (reason === "OTHER") return [{ reason }, { reason, sensitive: "CARD" as const }];
    return [{ reason }];
  });
}

function buildDictionary(): Dictionary {
  const dictionary: Dictionary = new Map();
  for (const entry of MAIN_STORY) if (entry.channel === "WHATSAPP") put(dictionary, entry.text, entry.glossEn);
  for (const label of [...Object.values(BUTTON_LABELS), ...Object.values(PHOTO_ITEM_BUTTONS)]) put(dictionary, label.es, label.en);
  leaves(dictionary, esMX, enGloss);
  for (const reason of RejectReason.options) for (const item of PhotoItem.options) put(dictionary, esMX.rejectReason(reason, item), enGloss.rejectReason(reason, item));
  for (const missing of subsets(ChecklistItem.options)) put(dictionary, esMX.closeNotComplete(missing), enGloss.closeNotComplete(missing));
  for (const input of caseReasons()) put(dictionary, esMX.caseReason(input), enGloss.caseReason(input));
  return dictionary;
}

let cached: Dictionary | undefined;
const dictionary = (): Dictionary => (cached ??= buildDictionary());

// ---- Texts with free arguments (names, hours, order numbers) ----------------------------------------

const MARK = "\u0000";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Pattern {
  readonly regex: RegExp;
  readonly gloss: (values: readonly string[]) => string;
}

/**
 * A regex of a text with `count` free arguments: the Spanish built with markers in their place, each
 * argument a lazy group the first time it appears and a back-reference when the text repeats it.
 */
export function patternOf(count: number, es: (...values: string[]) => string, en: (...values: string[]) => string): Pattern {
  const markers = Array.from({ length: count }, (_, index) => `${MARK}${index}${MARK}`);
  const groupOf = new Map<number, number>();
  const source = es(...markers)
    .split(new RegExp(`(${MARK}\\d+${MARK})`))
    .map((part) => {
      const marker = new RegExp(`^${MARK}(\\d+)${MARK}$`).exec(part);
      if (marker === null) return escapeRegExp(part);
      const index = Number(marker[1]);
      const group = groupOf.get(index);
      if (group !== undefined) return `\\${group}`;
      groupOf.set(index, groupOf.size + 1);
      return "(.+?)";
    })
    .join("");
  const regex = new RegExp(`^${source}$`, "s");
  return { regex, gloss: (groups) => en(...markers.map((_, index) => groups[(groupOf.get(index) ?? 0) - 1] ?? "")) };
}

type Text1 = (value: string) => string;
type Text2 = (first: string, second: string) => string;

/** The case brief (CASE_BRIEF): its labels in English around the label, order, name, reason and summary. */
function briefPattern(): Pattern {
  const brief = (pack: CopyPack) => (caseLabel: string, workOrderNumber: string, installerFirstName: string, reasonText: string, summary: string) =>
    pack.caseBrief({ caseLabel, workOrderNumber, installerFirstName, reasonText, summary });
  const english = brief(enGloss);
  return patternOf(5, brief(esMX), (label, order, name, reason, summary) => english(label, order, name, word(reason), summary));
}

function freePatterns(): Pattern[] {
  const one = (key: "caseOpened" | "caseReassigned" | "caseTaken" | "caseTakenByOther" | "shiftRegistered") => patternOf(1, esMX[key] as Text1, enGloss[key] as Text1);
  const roles: StaffRole[] = ["INSTALLER", "SUPERVISOR"];
  return [
    one("caseOpened"),
    one("caseReassigned"),
    one("caseTaken"),
    one("caseTakenByOther"),
    one("shiftRegistered"),
    patternOf(2, esMX.caseClosedConfirmation as Text2, enGloss.caseClosedConfirmation as Text2),
    // `hours` is a number the text only interpolates: the marker stands for it like for a name.
    patternOf(2, esMX.leaseBound as unknown as Text2, enGloss.leaseBound as unknown as Text2),
    ...roles.map((role) => patternOf(1, (name) => esMX.welcome(name, role), (name) => enGloss.welcome(name, role))),
    briefPattern(),
  ];
}

let patterns: Pattern[] | undefined;

function templatePattern(name: TemplateName): Pattern {
  const body = TEMPLATES[name].body;
  const count = TEMPLATES[name].params.length;
  const fill = (text: string) => (...values: string[]) => text.replace(/\{\{(\d+)\}\}/g, (_, index: string) => values[Number(index) - 1] ?? "");
  return patternOf(count, fill(body), fill(TEMPLATE_GLOSS[name]));
}

/** A word the code put in a template's parameter (a hazard, a case reason) in English; the rest as it is. */
const word = (value: string): string => dictionary().get(value) ?? value;

/** "Héctor (supervisor): …": the bridge's prefix in English, then the gloss of the relayed text (or the text). */
function relayGloss(text: string): string | undefined {
  for (const role of ["INSTALLER", "SUPERVISOR"] as const) {
    const prefix = patternOf(2, (name, rest) => `${esMX.relayPrefix(name, role)}${rest}`, (name, rest) => `${enGloss.relayPrefix(name, role)}${rest}`);
    const match = prefix.regex.exec(text);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const relayed = match[2];
    return prefix.gloss([match[1], glossOf({ text: relayed, templateName: null }) ?? relayed]);
  }
  return undefined;
}

/** The English gloss of a bubble, or `undefined` when the text has none (a free reply of the agent). */
export function glossOf(bubble: { readonly text: string | null; readonly templateName: TemplateName | null }): string | undefined {
  const text = bubble.text?.trim();
  if (!text) return undefined;
  if (bubble.templateName !== null) {
    const template = templatePattern(bubble.templateName);
    const match = template.regex.exec(text);
    if (match !== null) return template.gloss(match.slice(1).map(word));
  }
  const whole = dictionary().get(text);
  if (whole !== undefined) return whole;
  for (const pattern of (patterns ??= freePatterns())) {
    const match = pattern.regex.exec(text);
    if (match !== null) return pattern.gloss(match.slice(1));
  }
  return relayGloss(text);
}

/** The English of a button's title, when it is one of the product's labels. */
export function buttonGloss(title: string): string | undefined {
  return dictionary().get(title);
}
