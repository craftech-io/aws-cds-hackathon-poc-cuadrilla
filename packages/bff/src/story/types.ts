// Shapes of the main story (docs/seed-spec.md §7, docs/landing-spec.md §1.6 and §6.1): every message
// of Rogelio's day with work orders 24817 and 24818 and the safety sequence of 24819, in order, each
// with its scene, its simulated time, who sends it and who receives it, its Mexican Spanish text and
// its English gloss. `render.ts` turns the references to copy/ into text; `main-story.ts` holds the
// entries. The landing renders, the guided tour and the scenario oracles read the entries; nobody
// retypes their texts.
import type { HazardCategory, PersonRole, PhotoItem, RejectReason, Verdict, WaButtonAction } from "@cuadrilla/shared";
import type { CaseReasonInput } from "../copy/types";

/** The six scenes of the landing's walkthrough, in the order of the world's clock. */
export const STORY_SCENE_IDS = ["S1", "S2", "S3", "S4", "S5", "S6"] as const;
export type StorySceneId = (typeof STORY_SCENE_IDS)[number];

/** The three orders of the story, all of Rogelio on 13/10. */
export type StoryOrderNumber = "24817" | "24818" | "24819";

/**
 * What an entry is:
 *   fixedCopy          a text of the product, imported from copy/ and never retyped here
 *   exampleAgentReply  what the agent answers in this story; in the product the model writes it
 *   storyText          what a person of the story writes, records or instructs (or what a photo shows)
 */
export type StoryLabel = "fixedCopy" | "exampleAgentReply" | "storyText";

/** Cuadrilla itself, or a person of the `guest` template by the id the template clones. */
export type StoryParty = "cuadrilla" | "inst-rogelio" | "sup-adriana" | "sup-hector" | "zc-marisol";
export type StoryPerson = Exclude<StoryParty, "cuadrilla">;

export interface StoryPersonInfo {
  readonly firstName: string;
  readonly role: Exclude<PersonRole, "CUSTOMER">;
}

export interface BilingualText {
  readonly es: string;
  readonly en: string;
}

/** A text of `esMX` (copy/es-MX.ts) with its arguments; its gloss is the same key of `enGloss`. */
export type CopyRef =
  | { readonly key: "safetyInstruction" }
  | { readonly key: "safetyCaseOpened" }
  | { readonly key: "rejectReason"; readonly reason: RejectReason; readonly item: PhotoItem }
  | { readonly key: "caseOpened" | "caseReassigned" | "caseTaken"; readonly supervisorFirstName: string }
  | { readonly key: "caseClosedConfirmation"; readonly workOrderNumber: StoryOrderNumber; readonly installerFirstName: string }
  | {
      readonly key: "caseBrief";
      readonly caseLabel: string;
      readonly workOrderNumber: StoryOrderNumber;
      readonly installerFirstName: string;
      readonly reason: CaseReasonInput;
      /** The verified summary of this story: in the product, the agent writes it and G2 checks it. */
      readonly summary: BilingualText;
    };

/** A WhatsApp template of copy/templates.ts with the variables its parameters are built from. */
export type TemplateRef =
  | {
      readonly name: "caso_escalado" | "caso_reasignado";
      readonly caseLabel: string;
      readonly installerFirstName: string;
      readonly workOrderNumber: StoryOrderNumber;
      readonly reason: CaseReasonInput;
    }
  | { readonly name: "alerta_seguridad"; readonly workOrderNumber: StoryOrderNumber; readonly installerFirstName: string; readonly hazard: HazardCategory };

/** A document text of copy/es-MX-documents.ts; documents are Mexican Spanish only (ADR-0013). */
export type DocumentRef =
  | { readonly kind: "CERTIFICATE_FILE"; readonly workOrderNumber: StoryOrderNumber }
  | {
      readonly kind: "ZONE_CHIEF_ALERT";
      readonly workOrderNumber: StoryOrderNumber;
      /** Short zone name, as the subject writes it after "Zona". */
      readonly zoneName: string;
      readonly zoneChiefFirstName: string;
      readonly installerFirstName: string;
      readonly hazard: HazardCategory;
      /** "13/10 15:10". */
      readonly atText: string;
    };

interface EntryBase {
  /** Stable id: `s<scene>-<what>`. */
  readonly id: string;
  readonly scene: StorySceneId;
  /** Simulated instant, in Mexico City time (`2026-10-13T09:20:00-06:00`). */
  readonly atSim: string;
  readonly workOrderNumber: StoryOrderNumber;
  readonly channel: "WHATSAPP" | "EMAIL";
  readonly from: StoryParty;
  readonly to: StoryParty;
  readonly label: StoryLabel;
  /** Mexican Spanish, as the phone, the outbox or the console shows it. */
  readonly text: string;
  /** English gloss: the only source of the landing's English captions. The phone stays in es-MX. */
  readonly glossEn: string;
}

export type StoryEntry =
  /** A text a person writes, or an example reply of the agent (with the manual sections it cites). */
  | (EntryBase & {
      readonly kind: "TEXT";
      readonly label: "storyText" | "exampleAgentReply";
      readonly citations: readonly string[];
      readonly buttons: readonly WaButtonAction[];
    })
  /** A fixed text of copy/es-MX.ts. */
  | (EntryBase & { readonly kind: "COPY"; readonly label: "fixedCopy"; readonly copy: CopyRef; readonly buttons: readonly WaButtonAction[] })
  /** A voice note: `text` is what it says, which the phone never shows under the bubble (ADR-0023 §6). */
  | (EntryBase & { readonly kind: "VOICE"; readonly label: "storyText"; readonly voiceId: string; readonly durationSec: number })
  /** A photo: `text` describes what it shows; the validator's reaction lands on its bubble. */
  | (EntryBase & {
      readonly kind: "PHOTO";
      readonly label: "storyText";
      readonly item: PhotoItem;
      /** The photo of the set it is, when the set has one for this moment. */
      readonly photoId: string | null;
      readonly verdict: Verdict;
      readonly reason: RejectReason | null;
      /** `VERDICT_REACTIONS` of copy/buttons.ts. */
      readonly reaction: string;
    })
  /** A button the person taps: `text` is its label of copy/buttons.ts. */
  | (EntryBase & { readonly kind: "BUTTON"; readonly label: "fixedCopy"; readonly action: WaButtonAction })
  /** A WhatsApp template, with the buttons it carries. */
  | (EntryBase & { readonly kind: "TEMPLATE"; readonly label: "fixedCopy"; readonly template: TemplateRef; readonly buttons: readonly WaButtonAction[] })
  /** A message relayed over the bridge: the fixed prefix of copy/ and the text of another entry. */
  | (EntryBase & { readonly kind: "RELAY"; readonly label: "storyText"; readonly relayOf: string; readonly author: StoryPerson })
  /** A document: the certificate's file name, or the subject of an email. */
  | (EntryBase & { readonly kind: "DOCUMENT"; readonly label: "fixedCopy"; readonly document: DocumentRef });

export type StoryEntryKind = StoryEntry["kind"];

export interface StoryScene {
  readonly id: StorySceneId;
  readonly workOrderNumber: StoryOrderNumber;
  /** Scenes of "Saltar a escena" of the `guest` template that prepare it, the first one before its first entry. */
  readonly jumpScenes: readonly string[];
}
