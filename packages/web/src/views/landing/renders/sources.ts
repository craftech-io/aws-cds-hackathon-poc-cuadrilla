// The one door through which texts enter the landing's renders (docs/landing-spec.md §6.1): the
// messages of the main story (packages/bff/src/story/main-story.ts, each labelled fixedCopy,
// exampleAgentReply or storyText), the product texts of copy/ (the BFF's and the console's) and the
// manual section the gallery shows, read from the seed. Nothing in renders/ writes a visible text of its
// own; landing.test.ts renders every render and checks each text against these sources.
import { PHOTO_ITEM_BUTTONS, BUTTON_LABELS } from "@cuadrilla/bff/copy/buttons";
import { CERTIFICATE_LABELS, EMAIL_SENDER_NAMES, certificateFileName } from "@cuadrilla/bff/copy/es-MX-documents";
import { esMX } from "@cuadrilla/bff/copy/es-MX";
import { STORY_CASE_LABEL, STORY_CUSTOMER, STORY_PEOPLE, sceneEntries, storyEntry } from "@cuadrilla/bff/story/main-story";
import type { StoryEntry, StoryParty, StoryPerson, StorySceneId } from "@cuadrilla/bff/story/types";
import { ChecklistItem, ContactRule, type WaButtonAction } from "@cuadrilla/shared";
import { PRODUCT_NAME, copy } from "../../../copy/console";
import { formatSimTime, simTimeParts } from "../../../lib/world-clock";
import manualSection from "../../../../../../scripts/seed/data/manual/v001/DIAG-02.md?raw";

export { storyEntry };
export type { StoryEntry, StorySceneId };

/** The chat's contact: the product, as WhatsApp shows the business. */
export const CONTACT_NAME = PRODUCT_NAME;

export type PhoneOwner = Exclude<StoryPerson, "zc-marisol">;

export function firstNameOf(party: StoryParty): string {
  return party === "cuadrilla" ? PRODUCT_NAME : STORY_PEOPLE[party].firstName;
}

/** `HH:MM` of an entry, as a phone shows it. */
export function clockOf(entry: StoryEntry): string {
  return simTimeParts(entry.atSim).time;
}

/** `HH:MM:SS` of an entry, as the outbox shows the second an email went out. */
export function secondsOf(entry: StoryEntry): string {
  return entry.atSim.slice(11, 19);
}

export function buttonLabel(action: WaButtonAction): string {
  return BUTTON_LABELS[action].es;
}

/**
 * Whether the landing types the entry out (M2): the agent's example replies and what a person writes
 * in S1, S2 and Héctor's instruction. A fixed text of the product always appears whole.
 */
export function isTyped(entry: StoryEntry): boolean {
  if (entry.kind !== "TEXT") return false;
  return entry.label === "exampleAgentReply" || entry.scene === "S1" || entry.scene === "S2" || entry.id === "s5-hector-instruction";
}

/** Where a photo of the story is served: a smaller copy of the seed photo, or none for a moment without one. */
export function photoSource(entry: Extract<StoryEntry, { kind: "PHOTO" }>): string | undefined {
  return entry.photoId === null ? undefined : `/landing/renders/photos/${entry.photoId}.jpg`;
}

export interface PhoneMessage {
  readonly entry: StoryEntry;
  /** `out`: the phone's owner sent it. */
  readonly direction: "in" | "out";
  readonly time: string;
  readonly typed: boolean;
  readonly buttons: readonly string[];
}

function buttonsOf(entry: StoryEntry): readonly WaButtonAction[] {
  return entry.kind === "TEXT" || entry.kind === "COPY" || entry.kind === "TEMPLATE" ? entry.buttons : [];
}

/** The entries, in order, as the phone of `owner` shows them. */
export function phoneMessages(owner: PhoneOwner, ids: readonly string[]): PhoneMessage[] {
  return ids.map((id) => {
    const entry = storyEntry(id);
    if (entry.channel !== "WHATSAPP" || (entry.from !== owner && entry.to !== owner)) throw new RangeError(`${id} is not on the phone of ${owner}`);
    return { entry, direction: entry.from === owner ? "out" : "in", time: clockOf(entry), typed: isTyped(entry), buttons: buttonsOf(entry).map(buttonLabel) };
  });
}

/** The entry whose English gloss is the one caption of each scene in the English landing (§6.1). */
export const SCENE_CAPTION_ENTRY: Readonly<Record<StorySceneId, string>> = {
  S1: "s1-diagnosis-reply",
  S2: "s2-uncovered-reply",
  S3: "s3-glare-reason",
  S4: "s4-certificate",
  S5: "s5-case-escalated",
  S6: "s6-safety-instruction",
};

export function sceneCaption(scene: StorySceneId): string {
  return storyEntry(SCENE_CAPTION_ENTRY[scene]).glossEn;
}

/** First instant of a scene and its work order: the narrative's "09:20 · Orden 24817". */
export function sceneStart(scene: StorySceneId): { readonly time: string; readonly workOrderNumber: string } {
  const first = sceneEntries(scene)[0];
  if (!first) throw new RangeError(`scene ${scene} has no entries`);
  return { time: clockOf(first), workOrderNumber: first.workOrderNumber };
}

/** "OT 24817", as the product labels an order in a list. */
export function orderLabel(workOrderNumber: string): string {
  return esMX.orderChoiceRow({ workOrderNumber, windowText: "", neighborhood: "" }).title;
}

/** Eyebrow of every console crop: the console of the operator. */
export const CONSOLE_EYEBROW = copy.app.tagline;
export const VIEW_TEXTS = copy.views;
export const CLOCK_TEXTS = copy.clock;

export function simTimeText(entry: StoryEntry): string {
  return formatSimTime(entry.atSim, copy.clock.weekdays);
}

/** The checklist of an order as the certificate labels it, every item validated (S4). */
export const CHECKLIST = {
  title: CERTIFICATE_LABELS.checklist,
  passed: CERTIFICATE_LABELS.statusPassed,
  items: ChecklistItem.options.map((item) => esMX.checklistItem[item]),
};

/** The photo item a rejection is about, as the product names it on its buttons. */
export function photoItemLabel(entry: Extract<StoryEntry, { kind: "PHOTO" }>): string {
  return PHOTO_ITEM_BUTTONS[entry.item].es;
}

export interface OutboxRow {
  readonly key: string;
  readonly time: string;
  readonly sender: string;
  readonly recipient: string;
  readonly subject?: string;
  readonly attachment?: string;
}

/** The two emails of the certificate of 24817 (customer and operations mailbox), S4. */
export function certificateOutbox(): OutboxRow[] {
  const certificate = storyEntry("s4-certificate");
  const attachment = certificateFileName(certificate.workOrderNumber);
  return [
    { key: "customer", time: secondsOf(certificate), sender: EMAIL_SENDER_NAMES.certificates, recipient: `${CERTIFICATE_LABELS.customer} · ${STORY_CUSTOMER.lastName}`, attachment },
    { key: "ops", time: secondsOf(certificate), sender: EMAIL_SENDER_NAMES.certificates, recipient: copy.roles.OPS, attachment },
  ];
}

/** The email to the zone chief of the safety sequence, S6: its subject as the story computes it. */
export function safetyOutbox(): OutboxRow[] {
  const email = storyEntry("s6-zone-chief-email");
  return [{ key: "zone-chief", time: secondsOf(email), sender: EMAIL_SENDER_NAMES.alerts, recipient: firstNameOf(email.to), subject: email.text }];
}

/** Title of the certificate's attachment type ("PDF"), from its file name. */
export function fileTypeOf(fileName: string): string {
  return (fileName.split(".").pop() ?? "").toUpperCase();
}

export interface OrderRow {
  readonly workOrderNumber: string;
  readonly installer: string;
  readonly customer: string;
  readonly status: { readonly tone: "success" | "warning" | "danger"; readonly text: string };
}

/** Rogelio's three orders at the end of the story (gallery-orders), by the scenes that tell them. */
export function storyOrders(): OrderRow[] {
  const installer = firstNameOf("inst-rogelio");
  const escalated = sceneStart("S5").workOrderNumber;
  const hazard = sceneStart("S6").workOrderNumber;
  return [
    { workOrderNumber: STORY_CUSTOMER.workOrderNumber, installer, customer: STORY_CUSTOMER.lastName, status: { tone: "success", text: CERTIFICATE_LABELS.statusPassed } },
    {
      workOrderNumber: escalated,
      installer,
      customer: "",
      status: { tone: "warning", text: esMX.caseChoiceRow({ caseLabel: STORY_CASE_LABEL, workOrderNumber: escalated, installerFirstName: installer }).title },
    },
    { workOrderNumber: hazard, installer, customer: "", status: { tone: "danger", text: esMX.hazard.ELECTRICAL } },
  ];
}

export const ORDER_COLUMNS = {
  order: CERTIFICATE_LABELS.workOrder,
  installer: CERTIFICATE_LABELS.installer,
  customer: CERTIFICATE_LABELS.customer,
  checklist: CERTIFICATE_LABELS.checklist,
};

/** The entries of order 24817 as its timeline shows them, voice notes with their transcription. */
export function orderTimeline(): StoryEntry[] {
  return (["S1", "S2", "S3", "S4"] as const).flatMap((scene) => sceneEntries(scene)).filter((entry) => entry.workOrderNumber === "24817");
}

const CP = ContactRule.enum;

/** Contact-policy rules each outbound message of the story passed (gallery-audit). */
export const AUDIT_DECISIONS: ReadonlyArray<{ readonly entryId: string; readonly ruleIds: readonly string[] }> = [
  { entryId: "s1-diagnosis-reply", ruleIds: [CP["CP-WA-24H"], CP["CP-CITATION"]] },
  { entryId: "s2-uncovered-reply", ruleIds: [CP["CP-WA-24H"], CP["CP-CITATION"]] },
  { entryId: "s4-certificate", ruleIds: [CP["CP-CERT-EVIDENCE"], CP["CP-RECIPIENT-FENCE"]] },
  { entryId: "s5-case-escalated", ruleIds: [CP["CP-ROSTER"], CP["CP-TEMPLATE-APPROVED"]] },
  { entryId: "s5-hector-relay", ruleIds: [CP["CP-BRIDGE"]] },
  { entryId: "s6-safety-alert", ruleIds: [CP["CP-TEMPLATE-APPROVED"]] },
];

/** The measured areas the metrics view lists, as its description names them. */
export function metricAreas(): string[] {
  return copy.views.metrics.description
    .replace(/\.$/, "")
    .split(/, | y /)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export interface ManualBlock {
  readonly kind: "heading" | "note" | "paragraph" | "step";
  readonly text: string;
}

/** The section of the manual the story cites first (§DIAG-02), in blocks, from the seed's Markdown. */
export function manualBlocks(source: string = manualSection): ManualBlock[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line): ManualBlock => {
      if (line.startsWith("# ")) return { kind: "heading", text: line.slice(2) };
      if (line.startsWith("_") && line.endsWith("_")) return { kind: "note", text: line.slice(1, -1) };
      const step = /^\d+\.\s+(.*)$/.exec(line);
      if (step?.[1]) return { kind: "step", text: step[1] };
      return { kind: "paragraph", text: line };
    });
}

/** Every text the renders may show, for the check of landing.test.ts. */
export const MANUAL_SOURCE = manualSection;
