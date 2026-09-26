// The main story (WP-61, docs/test-plan.md "story/main-story.test.ts"): every fixed text is the one of
// copy/ (imported, never retyped), every entry carries a non-empty English gloss (the gloss of copy/
// for a fixed text), no text uses a word of ADR-0023, every order, person and scene exists in the
// `guest` template, and the safety sequence of 24819 is complete, in order and within 60 s.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findNeutralTerms } from "../../../../scripts/lint/neutral-terms";
import { DEFAULT_OPERATOR_NAME, resolveBrand } from "../copy/brand";
import { BUTTON_LABELS, VERDICT_REACTIONS } from "../copy/buttons";
import { TEMPLATE_GLOSS, enGloss } from "../copy/en-gloss";
import { esMX } from "../copy/es-MX";
import { certificateFileName, zoneChiefSafetyAlert } from "../copy/es-MX-documents";
import { fillPlaceholders } from "../copy/helpers";
import { matchSafetyLexicon } from "../copy/safety-lexicon";
import { TEMPLATES } from "../copy/templates";
import { MAIN_STORY, STORY_CUSTOMER, STORY_PEOPLE, STORY_SCENES, sceneEntries, storyEntry } from "./main-story";
import { NEUTRAL_BRAND, zoneChiefAlertSubject } from "./render";
import { STORY_SCENE_IDS, type CopyRef, type DocumentRef, type StoryEntry, type TemplateRef } from "./types";

const fromRoot = (path: string): URL => new URL(`../../../../${path}`, import.meta.url);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(fromRoot(path), "utf8")) as T;

interface TemplateItem {
  readonly entity: string;
  readonly [field: string]: unknown;
}
const GUEST = readJson<{ tables: Record<string, TemplateItem[]>; scenes: Array<{ sceneId: string; advanceToSim: string }>; tour: { windowStartSim: string; windowEndSim: string } }>(
  "scripts/seed/data/worlds/guest.json",
);
/** An id as the `guest` template writes it: the world factory puts the world's clock tag in the marker. */
const cloned = (id: string): string => `${id}-{{clockTag}}`;
const itemOf = (table: string, entity: string, field: string, id: string): TemplateItem | undefined => GUEST.tables[table]?.find((item) => item.entity === entity && item[field] === cloned(id));

const PARTNER = resolveBrand({ mode: "cobrand", partnerDisplayName: "Socio de Prueba", partnerShortName: "Socio", logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" }, disclaimer: { es: "aviso", en: "notice" } });
const SOURCES = ["main-story.ts", "render.ts", "types.ts"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
const ms = (entry: StoryEntry): number => Date.parse(entry.atSim);

/** What copy/ says for a reference, computed here straight from `esMX` and `enGloss`. */
function expectedCopy(ref: CopyRef): { es: string; en: string } {
  switch (ref.key) {
    case "safetyInstruction":
    case "safetyCaseOpened":
      return { es: esMX[ref.key], en: enGloss[ref.key] };
    case "rejectReason":
      return { es: esMX.rejectReason(ref.reason, ref.item), en: enGloss.rejectReason(ref.reason, ref.item) };
    case "caseOpened":
    case "caseReassigned":
    case "caseTaken":
      return { es: esMX[ref.key](ref.supervisorFirstName), en: enGloss[ref.key](ref.supervisorFirstName) };
    case "caseClosedConfirmation":
      return { es: esMX.caseClosedConfirmation(ref.workOrderNumber, ref.installerFirstName), en: enGloss.caseClosedConfirmation(ref.workOrderNumber, ref.installerFirstName) };
    case "caseBrief": {
      const input = { caseLabel: ref.caseLabel, workOrderNumber: ref.workOrderNumber, installerFirstName: ref.installerFirstName };
      return {
        es: esMX.caseBrief({ ...input, reasonText: esMX.caseReason(ref.reason), summary: ref.summary.es }),
        en: enGloss.caseBrief({ ...input, reasonText: enGloss.caseReason(ref.reason), summary: ref.summary.en }),
      };
    }
  }
}

function expectedTemplate(ref: TemplateRef): { es: string; en: string } {
  const params =
    ref.name === "alerta_seguridad"
      ? { es: [ref.workOrderNumber, ref.installerFirstName, esMX.hazard[ref.hazard]], en: [ref.workOrderNumber, ref.installerFirstName, enGloss.hazard[ref.hazard]] }
      : { es: [ref.caseLabel, ref.installerFirstName, ref.workOrderNumber, esMX.caseReason(ref.reason)], en: [ref.caseLabel, ref.installerFirstName, ref.workOrderNumber, enGloss.caseReason(ref.reason)] };
  return { es: fillPlaceholders(TEMPLATES[ref.name].body, params.es), en: fillPlaceholders(TEMPLATE_GLOSS[ref.name], params.en) };
}

function expectedSubject(ref: Extract<DocumentRef, { kind: "ZONE_CHIEF_ALERT" }>, brand = resolveBrand({ mode: "neutral" })): string {
  const { workOrderNumber, zoneName, zoneChiefFirstName, installerFirstName, atText } = ref;
  return zoneChiefSafetyAlert({ brand, workOrderNumber, zoneName, zoneChiefFirstName, installerFirstName, reasonText: esMX.hazard[ref.hazard], summary: "-", caseUrl: "-", atText }).subject;
}

const ofKind = <K extends StoryEntry["kind"]>(kind: K): Array<Extract<StoryEntry, { kind: K }>> => MAIN_STORY.filter((entry): entry is Extract<StoryEntry, { kind: K }> => entry.kind === kind);

describe("fixed texts come from copy/ with their gloss", () => {
  it("every entry carries its Mexican Spanish text and a non-empty English gloss", () => {
    for (const entry of MAIN_STORY) expect({ id: entry.id, text: entry.text.trim().length > 0, gloss: entry.glossEn.trim().length > 0 }).toEqual({ id: entry.id, text: true, gloss: true });
  });

  it("a fixed text of copy/es-MX.ts is its key, and its gloss the same key of copy/en-gloss.ts with the same arguments", () => {
    const copies = ofKind("COPY");
    expect(copies.map((entry) => entry.copy.key)).toEqual(expect.arrayContaining(["rejectReason", "caseOpened", "caseReassigned", "caseTaken", "caseBrief", "caseClosedConfirmation", "safetyInstruction", "safetyCaseOpened"]));
    for (const entry of copies) expect({ id: entry.id, es: entry.text, en: entry.glossEn }).toEqual({ id: entry.id, ...expectedCopy(entry.copy) });
  });

  it("a template is its body with the parameters built from its variables, and its gloss TEMPLATE_GLOSS with the same variables", () => {
    const templates = ofKind("TEMPLATE");
    expect(templates.map((entry) => entry.template.name)).toEqual(["caso_escalado", "caso_reasignado", "alerta_seguridad"]);
    for (const entry of templates) {
      expect({ id: entry.id, es: entry.text, en: entry.glossEn }).toEqual({ id: entry.id, ...expectedTemplate(entry.template) });
      expect(entry.buttons).toEqual(TEMPLATES[entry.template.name].buttons);
    }
  });

  it("a button is its label of copy/buttons.ts; a document is the text copy/ writes, with a literal gloss", () => {
    for (const entry of ofKind("BUTTON")) expect({ es: entry.text, en: entry.glossEn }).toEqual({ es: BUTTON_LABELS[entry.action].es, en: BUTTON_LABELS[entry.action].en });
    const documents = ofKind("DOCUMENT");
    expect(documents.map((entry) => entry.document.kind)).toEqual(["CERTIFICATE_FILE", "ZONE_CHIEF_ALERT"]);
    for (const { document, text } of documents) expect(text).toBe(document.kind === "CERTIFICATE_FILE" ? certificateFileName(document.workOrderNumber) : expectedSubject(document));
  });

  it("no fixed text is retyped in the story's sources", () => {
    for (const entry of MAIN_STORY.filter((candidate) => candidate.label === "fixedCopy")) {
      for (const line of entry.text.split("\n")) expect({ id: entry.id, retyped: SOURCES.some((source) => source.includes(line)) }).toEqual({ id: entry.id, retyped: false });
    }
  });

  it("a relayed message is the bridge prefix of copy/ and the text of the entry it relays, in both languages", () => {
    const relays = ofKind("RELAY");
    expect(relays).toHaveLength(2);
    for (const entry of relays) {
      const source = storyEntry(entry.relayOf);
      const { firstName, role } = STORY_PEOPLE[entry.author];
      if (role === "ZONE_CHIEF") throw new Error("a zone chief never relays");
      expect(source.from).toBe(entry.author);
      expect(entry.text).toBe(`${esMX.relayPrefix(firstName, role)}${source.text}`);
      expect(entry.glossEn).toBe(`${enGloss.relayPrefix(firstName, role)}${source.glossEn}`);
    }
  });

  it("the subject of the email to the zone chief follows the brand it is rendered with, and the story's never names the operator", () => {
    const [email] = ofKind("DOCUMENT").filter((entry) => entry.document.kind === "ZONE_CHIEF_ALERT");
    if (email?.document.kind !== "ZONE_CHIEF_ALERT") throw new Error("no email to the zone chief");
    expect(zoneChiefAlertSubject(email.document, PARTNER)).toBe(expectedSubject(email.document, PARTNER));
    expect(NEUTRAL_BRAND.mode).toBe("neutral");
    for (const entry of MAIN_STORY) expect([entry.text, entry.glossEn].some((text) => text.includes(DEFAULT_OPERATOR_NAME))).toBe(false);
  });
});

describe("the story's own texts", () => {
  it("uses no word of ADR-0023 in any text or gloss [FL-120]", () => {
    const findings = MAIN_STORY.flatMap((entry) => [...findNeutralTerms(`${entry.id} text`, entry.text), ...findNeutralTerms(`${entry.id} glossEn`, entry.glossEn)]);
    expect(findings).toEqual([]);
  });

  it("every example reply cites manual sections that exist, writes each citation, and offers only the agent's buttons", () => {
    const agentButtons = new Set(["CONSULT_SUPERVISOR", "NO_THANKS", "CUSTOMER_OK", "CLOSE_INSTALLATION", "CHOOSE_ITEM"]);
    const replies = ofKind("TEXT").filter((entry) => entry.label === "exampleAgentReply");
    expect(replies.length).toBeGreaterThanOrEqual(3);
    for (const entry of replies) {
      for (const section of entry.citations) {
        expect(existsSync(fromRoot(`scripts/seed/data/manual/v001/${section}.md`))).toBe(true);
        expect(entry.text).toContain(`§${section}`);
        expect(entry.glossEn).toContain(`§${section}`);
      }
      for (const button of entry.buttons) expect(agentButtons.has(button)).toBe(true);
    }
    const uncovered = storyEntry("s2-uncovered-reply");
    expect(uncovered.kind === "TEXT" && uncovered.citations.length === 0 && uncovered.buttons.includes("CONSULT_SUPERVISOR")).toBe(true);
  });

  it("the voice note is vn-01 of the voice datasheet, and each photo of the set is the one of the photo datasheet", () => {
    const notes = readJson<{ notes: Array<{ voiceId: string; text: string; durationSec: number }> }>("scripts/seed/audio/datasheet.json").notes;
    for (const entry of ofKind("VOICE")) {
      const note = notes.find((candidate) => candidate.voiceId === entry.voiceId);
      expect({ text: note?.text, durationSec: note?.durationSec }).toEqual({ text: entry.text, durationSec: entry.durationSec });
    }
    const photos = readJson<{ photos: Array<{ photoId: string; item: string; workOrderId: string; expectedVerdict: string }> }>("scripts/seed/photos/datasheet.json").photos;
    for (const entry of ofKind("PHOTO")) {
      expect(entry.reaction).toBe(VERDICT_REACTIONS[entry.verdict]);
      expect(entry.verdict === "REJECT").toBe(entry.reason !== null);
      if (entry.photoId === null) continue;
      const sheet = photos.find((candidate) => candidate.photoId === entry.photoId);
      expect(sheet).toMatchObject({ item: entry.item, workOrderId: `wo-${entry.workOrderNumber}`, expectedVerdict: entry.verdict });
    }
  });
});

describe("the story and the guest template", () => {
  it("every order of the story is Rogelio's in the template, including 24819", () => {
    const numbers = [...new Set(MAIN_STORY.map((entry) => entry.workOrderNumber))];
    expect(numbers).toEqual(["24817", "24818", "24819"]);
    for (const number of numbers) expect(itemOf("WorkOrders", "WorkOrder", "workOrderId", `wo-${number}`)?.installerId).toBe(cloned("inst-rogelio"));
    const customer = itemOf("People", "Customer", "customerId", STORY_CUSTOMER.customerId);
    expect(customer?.lastName).toBe(STORY_CUSTOMER.lastName);
    expect(itemOf("WorkOrders", "WorkOrder", "workOrderId", `wo-${STORY_CUSTOMER.workOrderNumber}`)?.customerId).toBe(cloned(STORY_CUSTOMER.customerId));
  });

  it("every person of the story exists in the template with the first name and role the story gives", () => {
    const parties = new Set(MAIN_STORY.flatMap((entry) => [entry.from, entry.to]).filter((party) => party !== "cuadrilla"));
    expect([...parties].sort()).toEqual(Object.keys(STORY_PEOPLE).sort());
    for (const [id, info] of Object.entries(STORY_PEOPLE)) expect(itemOf("People", "Person", "personId", id)).toMatchObject({ firstName: info.firstName, role: info.role });
  });

  it("every scene exists in the template and prepares its scene before the scene's first entry, inside the tour window", () => {
    const jumps = new Map(GUEST.scenes.map((scene) => [scene.sceneId, Date.parse(scene.advanceToSim)]));
    expect(STORY_SCENES.map((scene) => scene.id)).toEqual([...STORY_SCENE_IDS]);
    for (const scene of STORY_SCENES) {
      const entries = sceneEntries(scene.id);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(entry.workOrderNumber).toBe(scene.workOrderNumber);
      for (const id of scene.jumpScenes) expect({ scene: scene.id, jump: id, exists: jumps.has(id) }).toEqual({ scene: scene.id, jump: id, exists: true });
      const [first] = entries;
      expect(jumps.get(scene.jumpScenes[0] ?? "") ?? Infinity).toBeLessThanOrEqual(first === undefined ? 0 : ms(first));
    }
    for (const entry of MAIN_STORY) {
      expect(ms(entry)).toBeGreaterThanOrEqual(Date.parse(GUEST.tour.windowStartSim));
      expect(ms(entry)).toBeLessThanOrEqual(Date.parse(GUEST.tour.windowEndSim));
    }
  });
});

describe("order and the safety sequence", () => {
  it("entries run in the order of the clock and of the scenes, with unique ids", () => {
    expect(new Set(MAIN_STORY.map((entry) => entry.id)).size).toBe(MAIN_STORY.length);
    for (let index = 1; index < MAIN_STORY.length; index += 1) {
      const [previous, current] = [MAIN_STORY[index - 1] as StoryEntry, MAIN_STORY[index] as StoryEntry];
      expect(ms(current)).toBeGreaterThanOrEqual(ms(previous));
      expect(STORY_SCENE_IDS.indexOf(current.scene)).toBeGreaterThanOrEqual(STORY_SCENE_IDS.indexOf(previous.scene));
    }
    expect(() => storyEntry("s9-nothing")).toThrow(RangeError);
  });

  it("24819 at 15:10: hazard message → §SEG-01 = safetyInstruction → alerta_seguridad → subject of the zone chief's email, both alerts within 60 s", () => {
    const safety = sceneEntries("S6");
    const hazard = safety.findIndex((entry) => entry.kind === "TEXT" && entry.from === "inst-rogelio");
    const instruction = safety.findIndex((entry) => entry.kind === "COPY" && entry.copy.key === "safetyInstruction");
    const alert = safety.findIndex((entry) => entry.kind === "TEMPLATE" && entry.template.name === "alerta_seguridad");
    const email = safety.findIndex((entry) => entry.kind === "DOCUMENT" && entry.document.kind === "ZONE_CHIEF_ALERT");
    expect([hazard, instruction, alert, email].every((index) => index >= 0)).toBe(true);
    expect(hazard < instruction && instruction < alert && alert <= email).toBe(true);
    const [hazardEntry, instructionEntry, alertEntry, emailEntry] = [hazard, instruction, alert, email].map((index) => safety[index] as StoryEntry) as [StoryEntry, StoryEntry, StoryEntry, StoryEntry];
    expect(hazardEntry.atSim).toBe("2026-10-13T15:10:00-06:00");
    expect(instructionEntry.text).toBe(esMX.safetyInstruction);
    expect(alertEntry.kind === "TEMPLATE" && alertEntry.template.name in TEMPLATES).toBe(true);
    expect(alertEntry.to).toBe("sup-adriana");
    expect(emailEntry.to).toBe("zc-marisol");
    expect(emailEntry.channel).toBe("EMAIL");
    for (const entry of [alertEntry, emailEntry]) expect(ms(entry) - ms(hazardEntry)).toBeLessThan(60_000);
  });

  it("the hazard message is caught by the safety lexicon with the category the alert names", () => {
    const hazard = storyEntry("s6-hazard");
    const alert = storyEntry("s6-safety-alert");
    if (alert.kind !== "TEMPLATE" || alert.template.name !== "alerta_seguridad") throw new Error("s6-safety-alert is not the alert template");
    expect(matchSafetyLexicon(hazard.text)?.category).toBe(alert.template.hazard);
    for (const entry of MAIN_STORY.filter((candidate) => candidate.from === "inst-rogelio" && candidate !== hazard && candidate.kind !== "PHOTO")) expect({ id: entry.id, match: matchSafetyLexicon(entry.text) }).toEqual({ id: entry.id, match: null });
  });
});
