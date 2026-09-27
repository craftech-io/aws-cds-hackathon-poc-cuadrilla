// The main story, message by message (docs/seed-spec.md §7, docs/design-brief.md §4): Rogelio's
// Tuesday 13/10/2026 with work order 24817 (voice note, diagnosis, a policy question, a question the
// manual does not cover, the photos and the certificate), work order 24818 (the ladder: Adriana, then
// Héctor, and his instruction over the bridge) and the safety sequence of work order 24819 at 15:10.
//
// One source for the landing renders, the quick messages and the steps of the guided tour, and the
// scenario oracles. Every entry is labelled: `fixedCopy` comes from copy/ through render.ts (never
// retyped), `exampleAgentReply` is what the agent answers in this story (the product writes it with
// the model), `storyText` is what a person writes, records or instructs. Every entry carries its
// English gloss: the gloss of copy/ for a fixed text, written next to the Spanish for the rest.
// Nothing here names the operator: it is "la operadora" at runtime (ADR-0018).
import type { PhotoItem, RejectReason, Verdict, WaButtonAction } from "@cuadrilla/shared";
import { VERDICT_REACTIONS } from "../copy/buttons";
import { buttonText, copyText, documentText, relayPrefix, templateButtons, templateText } from "./render";
import type { BilingualText, CopyRef, DocumentRef, StoryEntry, StoryOrderNumber, StoryParty, StoryPerson, StoryPersonInfo, StoryScene, StorySceneId, TemplateRef } from "./types";

/** People of the story, by the id the `guest` template clones; their names are fictitious. */
export const STORY_PEOPLE: Readonly<Record<StoryPerson, StoryPersonInfo>> = {
  "inst-rogelio": { firstName: "Rogelio", role: "INSTALLER" },
  "sup-adriana": { firstName: "Adriana", role: "SUPERVISOR" },
  "sup-hector": { firstName: "Héctor", role: "SUPERVISOR" },
  "zc-marisol": { firstName: "Marisol", role: "ZONE_CHIEF" },
};

/** The customer of work order 24817, whom the voice note names. */
export const STORY_CUSTOMER = { customerId: "cust-10421", lastName: "Treviño", workOrderNumber: "24817" } as const;

/** Label of the case of work order 24818 as texts and templates show it. */
export const STORY_CASE_LABEL = "C-0412";

const ROGELIO = STORY_PEOPLE["inst-rogelio"].firstName;
const ADRIANA = STORY_PEOPLE["sup-adriana"].firstName;
const HECTOR = STORY_PEOPLE["sup-hector"].firstName;
const MARISOL = STORY_PEOPLE["zc-marisol"].firstName;

/** Where and when an entry happens. */
interface Where {
  readonly id: string;
  readonly scene: StorySceneId;
  /** `HH:MM:SS` of 13/10/2026 in Mexico City. */
  readonly at: string;
  readonly order: StoryOrderNumber;
  readonly from: StoryParty;
  readonly to: StoryParty;
}

function base(where: Where, channel: "WHATSAPP" | "EMAIL" = "WHATSAPP") {
  return { id: where.id, scene: where.scene, atSim: `2026-10-13T${where.at}-06:00`, workOrderNumber: where.order, channel, from: where.from, to: where.to };
}

function said(where: Where, text: BilingualText): StoryEntry {
  return { ...base(where), kind: "TEXT", label: "storyText", text: text.es, glossEn: text.en, citations: [], buttons: [] };
}

function reply(where: Where, text: BilingualText, citations: readonly string[], buttons: readonly WaButtonAction[] = []): StoryEntry {
  return { ...base(where), kind: "TEXT", label: "exampleAgentReply", text: text.es, glossEn: text.en, citations, buttons };
}

function fixed(where: Where, copy: CopyRef, buttons: readonly WaButtonAction[] = []): StoryEntry {
  return { ...base(where), kind: "COPY", label: "fixedCopy", copy, text: copyText(copy, "es"), glossEn: copyText(copy, "en"), buttons };
}

function voice(where: Where, voiceId: string, durationSec: number, text: BilingualText): StoryEntry {
  return { ...base(where), kind: "VOICE", label: "storyText", voiceId, durationSec, text: text.es, glossEn: text.en };
}

function photo(where: Where, item: PhotoItem, photoId: string | null, verdict: Verdict, reason: RejectReason | null, text: BilingualText): StoryEntry {
  return { ...base(where), kind: "PHOTO", label: "storyText", item, photoId, verdict, reason, reaction: VERDICT_REACTIONS[verdict], text: text.es, glossEn: text.en };
}

function tap(where: Where, action: WaButtonAction): StoryEntry {
  return { ...base(where), kind: "BUTTON", label: "fixedCopy", action, text: buttonText(action, "es"), glossEn: buttonText(action, "en") };
}

function template(where: Where, ref: TemplateRef): StoryEntry {
  return { ...base(where), kind: "TEMPLATE", label: "fixedCopy", template: ref, text: templateText(ref, "es"), glossEn: templateText(ref, "en"), buttons: templateButtons(ref) };
}

function relay(where: Where, source: StoryEntry, author: StoryPerson): StoryEntry {
  const person = STORY_PEOPLE[author];
  return { ...base(where), kind: "RELAY", label: "storyText", relayOf: source.id, author, text: `${relayPrefix(person, "es")}${source.text}`, glossEn: `${relayPrefix(person, "en")}${source.glossEn}` };
}

/** A document text of copy/; documents have no gloss in copy/, so it is written here (ADR-0013). */
function document(where: Where, ref: DocumentRef, glossEn: string): StoryEntry {
  return { ...base(where, ref.kind === "ZONE_CHIEF_ALERT" ? "EMAIL" : "WHATSAPP"), kind: "DOCUMENT", label: "fixedCopy", document: ref, text: documentText(ref), glossEn };
}

// ---- S1 · 09:20, work order 24817: the voice note and the diagnosis ---------------------------------

const s1 = (id: string, at: string, from: StoryParty, to: StoryParty): Where => ({ id: `s1-${id}`, scene: "S1", at, order: "24817", from, to });

const S1: readonly StoryEntry[] = [
  voice(s1("voice-note", "09:20:00", "inst-rogelio", "cuadrilla"), "vn-01", 3.188, {
    es: "Ya estoy con la señora Treviño, la ONU no prende la luz PON.",
    en: "I'm at Mrs. Treviño's home; the ONU's PON light won't turn on.",
  }),
  reply(
    s1("diagnosis-reply", "09:21:00", "cuadrilla", "inst-rogelio"),
    {
      es: "La red reporta la ONU sin señal (LOS). Revisa que el cordón de parcheo esté bien conectado en la roseta y en la ONU, hasta escuchar el clic; limpia los conectores SC/APC de los dos extremos y revisa que el cable no tenga curvas cerradas (Manual v1, §DIAG-02).",
      en: "The network reports the ONU with no signal (LOS). Check that the patch cord is firmly plugged into the rosette and the ONU until it clicks; clean the SC/APC connectors at both ends and check that the cable has no tight bends (Manual v1, §DIAG-02).",
    },
    ["DIAG-02"],
  ),
  said(s1("connector-cleaned", "09:33:00", "inst-rogelio", "cuadrilla"), { es: "Ya limpié el conector, ya prende.", en: "I cleaned the connector; it lights up now." }),
  reply(
    s1("onu-online-reply", "09:34:00", "cuadrilla", "inst-rogelio"),
    {
      es: "Listo, la ONU ya está en línea con −21,4 dBm. Para cerrar mándame 3 fotos: la lectura del medidor, la etiqueta de la ONU y la roseta (Manual v1, §EVI-01).",
      en: "Done, the ONU is online at −21.4 dBm. To close, send me 3 photos: the meter reading, the ONU label and the rosette (Manual v1, §EVI-01).",
    },
    ["EVI-01"],
  ),
];

// ---- S2 · 09:36, work order 24817: a policy question, and one the manual does not cover ------------

const s2 = (id: string, at: string, from: StoryParty, to: StoryParty): Where => ({ id: `s2-${id}`, scene: "S2", at, order: "24817", from, to });

const S2: readonly StoryEntry[] = [
  said(s2("policy-question", "09:36:00", "inst-rogelio", "cuadrilla"), {
    es: "La señora quiere la roseta en el otro cuarto, ¿se le cobra?",
    en: "The customer wants the rosette in the other room; is she charged for that?",
  }),
  reply(
    s2("policy-reply", "09:37:00", "cuadrilla", "inst-rogelio"),
    {
      es: "Hasta 15 m de cable interior, cambiar la roseta de lugar no tiene costo; si hacen falta más de 15 m, el tramo extra lleva un cargo de extensión en su siguiente factura (Manual v1, §COM-04). Tú nunca cobras en sitio (Manual v1, §COM-02).",
      en: "Up to 15 m of indoor cable, moving the rosette is free; if more than 15 m are needed, the extra length carries an extension charge on her next bill (Manual v1, §COM-04). You never collect payment on site (Manual v1, §COM-02).",
    },
    ["COM-04", "COM-02"],
  ),
  said(s2("uncovered-question", "09:38:00", "inst-rogelio", "cuadrilla"), {
    es: "¿Y le dejo la contraseña de administrador de la ONU?",
    en: "And should I leave her the ONU's admin password?",
  }),
  reply(
    s2("uncovered-reply", "09:39:00", "cuadrilla", "inst-rogelio"),
    { es: "No está en el manual, así que no te lo puedo confirmar. ¿Lo consulto con tu supervisora?", en: "It isn't in the manual, so I can't confirm it. Shall I check with your supervisor?" },
    [],
    ["CONSULT_SUPERVISOR", "NO_THANKS"],
  ),
];

// ---- S3 · 09:46, work order 24817: the photo check and the customer's sign-off ---------------------

const s3 = (id: string, at: string, from: StoryParty, to: StoryParty): Where => ({ id: `s3-${id}`, scene: "S3", at, order: "24817", from, to });
const GLARE_ON_LABEL: CopyRef = { key: "rejectReason", reason: "GLARE", item: "ONU_LABEL_PHOTO" };

const S3: readonly StoryEntry[] = [
  photo(s3("meter-photo", "09:46:00", "inst-rogelio", "cuadrilla"), "POWER_READING_PHOTO", "ph-meter-01", "PASS", null, { es: "Foto de la pantalla del medidor", en: "Photo of the meter's screen" }),
  photo(s3("label-glare-photo", "09:47:00", "inst-rogelio", "cuadrilla"), "ONU_LABEL_PHOTO", "ph-story-01", "REJECT", "GLARE", {
    es: "Foto de la etiqueta de la ONU, con reflejo",
    en: "Photo of the ONU label, with glare",
  }),
  fixed(s3("glare-reason", "09:47:20", "cuadrilla", "inst-rogelio"), GLARE_ON_LABEL),
  photo(s3("label-photo", "09:48:00", "inst-rogelio", "cuadrilla"), "ONU_LABEL_PHOTO", "ph-label-01", "PASS", null, {
    es: "Foto de la etiqueta de la ONU, sin reflejo",
    en: "Photo of the ONU label, without glare",
  }),
  photo(s3("rosette-photo", "09:50:00", "inst-rogelio", "cuadrilla"), "ROSETTE_PHOTO", "ph-rosette-02", "PASS", null, { es: "Foto de la roseta instalada", en: "Photo of the installed rosette" }),
  reply(
    s3("sign-off-offer", "09:51:00", "cuadrilla", "inst-rogelio"),
    {
      es: `Las tres fotos quedaron validadas. Cuando la señora Treviño revise la instalación y esté conforme, toca ${buttonText("CUSTOMER_OK", "es")}.`,
      en: `All three photos are validated. When Mrs. Treviño has checked the installation and is satisfied, tap ${buttonText("CUSTOMER_OK", "en")}.`,
    },
    [],
    ["CUSTOMER_OK"],
  ),
  tap(s3("sign-off", "09:55:00", "inst-rogelio", "cuadrilla"), "CUSTOMER_OK"),
  reply(
    s3("close-offer", "09:56:00", "cuadrilla", "inst-rogelio"),
    {
      es: `Listo, el checklist de la orden 24817 está completo. Toca ${buttonText("CLOSE_INSTALLATION", "es")} para generar el acta.`,
      en: `Done, the checklist of order 24817 is complete. Tap ${buttonText("CLOSE_INSTALLATION", "en")} to generate the certificate.`,
    },
    [],
    ["CLOSE_INSTALLATION"],
  ),
];

// ---- S4 · 10:05, work order 24817: the certificate -------------------------------------------------

const s4 = (id: string, at: string, from: StoryParty, to: StoryParty): Where => ({ id: `s4-${id}`, scene: "S4", at, order: "24817", from, to });

const S4: readonly StoryEntry[] = [
  tap(s4("close-tap", "10:05:00", "inst-rogelio", "cuadrilla"), "CLOSE_INSTALLATION"),
  document(s4("certificate", "10:05:20", "cuadrilla", "inst-rogelio"), { kind: "CERTIFICATE_FILE", workOrderNumber: "24817" }, "Installation certificate of order 24817 (PDF)"),
];

// ---- S5 · 11:50, work order 24818: the ladder and the bridge ---------------------------------------

const s5 = (id: string, at: string, from: StoryParty, to: StoryParty): Where => ({ id: `s5-${id}`, scene: "S5", at, order: "24818", from, to });
const LOW_POWER_CASE = { reason: "DIAGNOSIS_ATTEMPTS", symptom: "LOW_POWER" } as const;
const CASE_OF_24818 = { caseLabel: STORY_CASE_LABEL, installerFirstName: ROGELIO, workOrderNumber: "24818", reason: LOW_POWER_CASE } as const;

const HECTOR_INSTRUCTION = said(s5("hector-instruction", "12:04:00", "sup-hector", "cuadrilla"), {
  es: "Cambia el conector de la roseta, hay SC/APC en la caja de la camioneta.",
  en: "Replace the rosette connector; there are SC/APC connectors in the box in the van.",
});
const ROGELIO_ANSWER = said(s5("rogelio-answer", "12:15:00", "inst-rogelio", "cuadrilla"), {
  es: "Ya lo cambié y la potencia subió a −22,6 dBm.",
  en: "I replaced it and the power went up to −22.6 dBm.",
});

const S5: readonly StoryEntry[] = [
  fixed(s5("case-opened", "11:50:00", "cuadrilla", "inst-rogelio"), { key: "caseOpened", supervisorFirstName: ADRIANA }),
  template(s5("case-escalated", "11:50:00", "cuadrilla", "sup-adriana"), { name: "caso_escalado", ...CASE_OF_24818 }),
  template(s5("case-reassigned", "12:00:00", "cuadrilla", "sup-hector"), { name: "caso_reasignado", ...CASE_OF_24818 }),
  fixed(s5("case-reassigned-notice", "12:00:00", "cuadrilla", "inst-rogelio"), { key: "caseReassigned", supervisorFirstName: HECTOR }),
  tap(s5("take-case", "12:02:00", "sup-hector", "cuadrilla"), "TAKE_CASE"),
  fixed(s5("case-taken", "12:02:00", "cuadrilla", "inst-rogelio"), { key: "caseTaken", supervisorFirstName: HECTOR }),
  fixed(
    s5("case-brief", "12:02:00", "cuadrilla", "sup-hector"),
    {
      key: "caseBrief",
      caseLabel: STORY_CASE_LABEL,
      workOrderNumber: "24818",
      installerFirstName: ROGELIO,
      reason: LOW_POWER_CASE,
      summary: {
        es: "La ONU de la orden 24818 marca −29,8 dBm, fuera del rango de la zona Norte. Rogelio hizo tres pasos de §DIAG-03 sin cambio en la potencia.",
        en: "The ONU of order 24818 reads −29.8 dBm, outside the North zone's range. Rogelio did three §DIAG-03 steps with no change in the power.",
      },
    },
    ["CLOSE_CASE"],
  ),
  HECTOR_INSTRUCTION,
  relay(s5("hector-relay", "12:04:00", "cuadrilla", "inst-rogelio"), HECTOR_INSTRUCTION, "sup-hector"),
  ROGELIO_ANSWER,
  relay(s5("rogelio-relay", "12:15:00", "cuadrilla", "sup-hector"), ROGELIO_ANSWER, "inst-rogelio"),
  tap(s5("close-case", "12:17:00", "sup-hector", "cuadrilla"), "CLOSE_CASE"),
  fixed(s5("case-closed", "12:17:00", "cuadrilla", "sup-hector"), { key: "caseClosedConfirmation", workOrderNumber: "24818", installerFirstName: ROGELIO }),
];

// ---- S6 · 15:10, work order 24819: the safety sequence ---------------------------------------------

const s6 = (id: string, at: string, from: StoryParty, to: StoryParty): Where => ({ id: `s6-${id}`, scene: "S6", at, order: "24819", from, to });

const S6: readonly StoryEntry[] = [
  said(s6("hazard", "15:10:00", "inst-rogelio", "cuadrilla"), { es: "Hay un cable pelado en el poste, está chispeando.", en: "There's a stripped cable on the pole, and it's sparking." }),
  fixed(s6("safety-instruction", "15:10:01", "cuadrilla", "inst-rogelio"), { key: "safetyInstruction" }),
  fixed(s6("safety-case-opened", "15:10:02", "cuadrilla", "inst-rogelio"), { key: "safetyCaseOpened" }),
  template(s6("safety-alert", "15:10:03", "cuadrilla", "sup-adriana"), { name: "alerta_seguridad", workOrderNumber: "24819", installerFirstName: ROGELIO, hazard: "ELECTRICAL" }),
  document(
    s6("zone-chief-email", "15:10:03", "cuadrilla", "zc-marisol"),
    { kind: "ZONE_CHIEF_ALERT", workOrderNumber: "24819", zoneName: "Norte", zoneChiefFirstName: MARISOL, installerFirstName: ROGELIO, hazard: "ELECTRICAL", atText: "13/10 15:10" },
    "[Cuadrilla] Safety alert · Order 24819 · North zone",
  ),
];

/** Every entry of the story, in the order of the world's clock. */
export const MAIN_STORY: readonly StoryEntry[] = [...S1, ...S2, ...S3, ...S4, ...S5, ...S6];

/** The scenes of the landing's walkthrough and the scenes of "Saltar a escena" that prepare them. */
export const STORY_SCENES: readonly StoryScene[] = [
  { id: "S1", workOrderNumber: "24817", jumpScenes: ["en-sitio-0920", "paso-de-diagnostico"] },
  { id: "S2", workOrderNumber: "24817", jumpScenes: ["onu-en-linea"] },
  { id: "S3", workOrderNumber: "24817", jumpScenes: ["evidencia"] },
  { id: "S4", workOrderNumber: "24817", jumpScenes: ["checklist-completo"] },
  { id: "S5", workOrderNumber: "24818", jumpScenes: ["caso-con-supervisora", "caso-con-respaldo"] },
  { id: "S6", workOrderNumber: "24819", jumpScenes: ["tercera-visita-1510"] },
];

/** The entries of one scene, in order. */
export function sceneEntries(scene: StorySceneId): StoryEntry[] {
  return MAIN_STORY.filter((entry) => entry.scene === scene);
}

/** One entry by its id; an unknown id is a programming error. */
export function storyEntry(id: string): StoryEntry {
  const found = MAIN_STORY.find((entry) => entry.id === id);
  if (found === undefined) throw new RangeError(`no entry "${id}" in the main story`);
  return found;
}
