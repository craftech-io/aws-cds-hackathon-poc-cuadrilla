// Turns the references of the main story into the texts of copy/: a fixed text of `esMX` and its
// gloss in `enGloss` (same key, same arguments), a template body of templates.ts and its gloss in
// `TEMPLATE_GLOSS` (same variables), a button label of buttons.ts, and the document texts of
// es-MX-documents.ts. Nothing here writes a text of its own.
import type { WaButtonAction } from "@cuadrilla/shared";
import { resolveBrand, type ResolvedBrand } from "../copy/brand";
import { BUTTON_LABELS } from "../copy/buttons";
import { TEMPLATE_GLOSS, enGloss } from "../copy/en-gloss";
import { esMX } from "../copy/es-MX";
import { certificateFileName, zoneChiefSafetyAlert } from "../copy/es-MX-documents";
import { fillPlaceholders } from "../copy/helpers";
import { TEMPLATES, renderTemplateBody } from "../copy/templates";
import type { CopyPack } from "../copy/types";
import type { CopyRef, DocumentRef, StoryPersonInfo, TemplateRef } from "./types";

export type StoryLanguage = "es" | "en";

const PACKS: Readonly<Record<StoryLanguage, CopyPack>> = { es: esMX, en: enGloss };

/** The brand every document text of the story is written with: never the operator's name (ADR-0018). */
export const NEUTRAL_BRAND: ResolvedBrand = resolveBrand({ mode: "neutral" });

/** A fixed text of copy/es-MX.ts (`es`) or its gloss of copy/en-gloss.ts (`en`). */
export function copyText(ref: CopyRef, language: StoryLanguage): string {
  const pack = PACKS[language];
  switch (ref.key) {
    case "safetyInstruction":
    case "safetyCaseOpened":
      return pack[ref.key];
    case "rejectReason":
      return pack.rejectReason(ref.reason, ref.item);
    case "caseOpened":
    case "caseReassigned":
    case "caseTaken":
      return pack[ref.key](ref.supervisorFirstName);
    case "caseClosedConfirmation":
      return pack.caseClosedConfirmation(ref.workOrderNumber, ref.installerFirstName);
    case "caseBrief":
      return pack.caseBrief({
        caseLabel: ref.caseLabel,
        workOrderNumber: ref.workOrderNumber,
        installerFirstName: ref.installerFirstName,
        reasonText: pack.caseReason(ref.reason),
        summary: ref.summary[language],
      });
  }
}

/** Parameters of a template in one language, built from its variables as the product builds them. */
export function templateParams(ref: TemplateRef, language: StoryLanguage): string[] {
  const pack = PACKS[language];
  if (ref.name === "alerta_seguridad") return [ref.workOrderNumber, ref.installerFirstName, pack.hazard[ref.hazard]];
  return [ref.caseLabel, ref.installerFirstName, ref.workOrderNumber, pack.caseReason(ref.reason)];
}

/** The body of the template with its parameters (`es`), or its gloss of `TEMPLATE_GLOSS` (`en`). */
export function templateText(ref: TemplateRef, language: StoryLanguage): string {
  return language === "es" ? renderTemplateBody(ref.name, templateParams(ref, "es")) : fillPlaceholders(TEMPLATE_GLOSS[ref.name], templateParams(ref, "en"));
}

/** The quick-reply buttons a template carries. */
export function templateButtons(ref: TemplateRef): readonly WaButtonAction[] {
  return TEMPLATES[ref.name].buttons;
}

export function buttonText(action: WaButtonAction, language: StoryLanguage): string {
  return BUTTON_LABELS[action][language];
}

/** The subject of the email to the zone chief, as copy/ writes it for `brand`. */
export function zoneChiefAlertSubject(ref: Extract<DocumentRef, { kind: "ZONE_CHIEF_ALERT" }>, brand: ResolvedBrand = NEUTRAL_BRAND): string {
  return zoneChiefSafetyAlert({
    brand,
    workOrderNumber: ref.workOrderNumber,
    zoneName: ref.zoneName,
    zoneChiefFirstName: ref.zoneChiefFirstName,
    installerFirstName: ref.installerFirstName,
    reasonText: esMX.hazard[ref.hazard],
    // The body is not part of the story: only the subject is shown.
    summary: esMX.hazard[ref.hazard],
    caseUrl: "",
    atText: ref.atText,
  }).subject;
}

/** The text of a document: the certificate's file name, or the subject of the email (neutral brand). */
export function documentText(ref: DocumentRef): string {
  return ref.kind === "CERTIFICATE_FILE" ? certificateFileName(ref.workOrderNumber) : zoneChiefAlertSubject(ref);
}

/** The prefix of a message relayed over the bridge ("Héctor (supervisor): "). */
export function relayPrefix(person: StoryPersonInfo, language: StoryLanguage): string {
  if (person.role === "ZONE_CHIEF") throw new RangeError("a zone chief never talks over the bridge");
  return PACKS[language].relayPrefix(person.firstName, person.role);
}
