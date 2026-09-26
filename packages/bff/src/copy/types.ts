// Shape of a copy pack: every fixed text the product sends or shows to the staff, in one language.
// `es-MX.ts` is the pack that is sent; `en-gloss.ts` is its English gloss for the simulator and the
// readers of the glossary (ADR-0013). Both implement this interface, so a text missing from either
// one is a compile error instead of a blank bubble. No tool, adapter, worker or prompt carries an
// inline string.
import type { CaseReason, ChecklistItem, HazardCategory, PersonRole, PhotoItem, RejectReason, Symptom } from "@cuadrilla/shared";
import type { PrefilterBlockKind } from "../lib/mask";

/** A row of an interactive WhatsApp list: title ≤ 24 characters, description ≤ 72 (buttons.ts). */
export interface ListRowText {
  readonly title: string;
  readonly description: string;
}

/** Staff roles that talk to Cuadrilla on WhatsApp. */
export type StaffRole = Extract<PersonRole, "INSTALLER" | "SUPERVISOR">;

/** What the `{{4}}` of `caso_escalado` / `caso_reasignado` is built from: never free text of the model. */
export interface CaseReasonInput {
  readonly reason: CaseReason;
  /** Symptom of a `DIAGNOSIS_ATTEMPTS` case. */
  readonly symptom?: Symptom;
  /** Checklist item of a `PHOTO_ATTEMPTS` case. */
  readonly item?: PhotoItem;
  /** What an `OTHER` case opened by the pre-G1 block carried (lib/mask.ts `prefilterBlock`, FL-078). */
  readonly sensitive?: PrefilterBlockKind;
}

export interface CaseBriefInput {
  /** Short label of the case ("C-0412"). */
  readonly caseLabel: string;
  readonly workOrderNumber: string;
  readonly installerFirstName: string;
  /** `caseReason(...)` of the case. */
  readonly reasonText: string;
  /** Summary verified by G2 and the deterministic checks, or the fixed one built by code. */
  readonly summary: string;
}

export interface OrderChoiceInput {
  readonly workOrderNumber: string;
  /** "09:00 a 11:00" (`formatWindow`). */
  readonly windowText: string;
  readonly neighborhood: string;
}

export interface CaseChoiceInput {
  readonly caseLabel: string;
  readonly workOrderNumber: string;
  readonly installerFirstName: string;
}

export interface CopyPack {
  // ---- Brand (ADR-0018): the partner's name is always a parameter, never a literal ----------------
  /** "Cuadrilla · Powered by Craftech", or "Cuadrilla for <partner> · Powered by Craftech". */
  brandLine(partnerName?: string): string;
  /** Mandatory co-branding notice: synthetic manual, policies and data, not the partner's. */
  syntheticDemoNotice(partnerName: string): string;
  /** Neutral mode: the operator is fictitious and every datum is synthetic. */
  readonly fictitiousOperatorNotice: string;
  /** Tag after the operator's name in neutral mode ("ficticia"). */
  readonly fictitiousTag: string;
  /** Tag after the partner's name in co-branding ("demo sintética"). */
  readonly syntheticDemoTag: string;

  // ---- SYSTEM_NOTICE: registration, keywords and channel limits -----------------------------------
  /** Opt-in poster ("Envía ALTA a este número"); its version is `OPT_IN_TEXT_VERSION`. */
  readonly optInPoster: string;
  /** Welcome after "ALTA": what Cuadrilla does and how to opt out. */
  welcome(firstName: string, role: StaffRole): string;
  /** Allowlisted number without opt-in (FL-003). */
  readonly optInRequired: string;
  /** Number outside the allowlist, at most once a day (FL-004). */
  readonly unknownNumber: string;
  /** Confirmation of "BAJA", the only message an opted-out person receives (FL-005). */
  readonly optOutConfirmed: string;
  /** "TURNO" registered: the supervisor's shift window is open until `untilText` (FL-074). */
  shiftRegistered(untilText: string): string;
  /** A supervisor writes with no case taken. */
  readonly supervisorNoCase: string;
  readonly voiceUnclear: string;
  readonly voiceTooLong: string;
  readonly voiceFailed: string;
  /** Video, document, sticker, location or contact card (FL-018, FL-046). */
  readonly unsupportedMedia: string;
  /** Image over the size limit (FL-046). */
  readonly imageTooLarge: string;
  /** Image that could not be decoded or converted to JPEG. */
  readonly imageUnreadable: string;
  /** Kill switch on (ADR-0019): no Harness, Transcribe or validator; safety keeps working. */
  readonly servicePaused: string;
  /** A turn failed or ran out of time (`AGENT_FALLBACK`). */
  readonly agentFallback: string;
  /** Operator or stage turn cap reached (`TURN_CAP`). */
  readonly turnCap: string;
  /** G1 blocked the message: the Harness text never goes out (docs/design-brief.md §5.5). */
  readonly guardrailRefusal: string;
  /** "Cerrar instalación" answered `NOT_COMPLETE` (FL-050): the items come from `missing`. */
  closeNotComplete(missing: readonly ChecklistItem[]): string;
  /** A button whose nonce is foreign, used or expired (FL-094). */
  readonly buttonExpired: string;
  /** A case button on a case that is already closed (FL-062). */
  readonly caseAlreadyClosed: string;
  /** "ALTA <código>" with an unknown, used or expired code (FL-101). */
  readonly joinCodeInvalid: string;
  /** The phone is already bound to another world or registered in the live world (FL-101). */
  readonly leaseInUse: string;
  /** The phone is now bound to a person of a guest's world (FL-101). */
  leaseBound(personFirstName: string, hours: number): string;

  // ---- Safety (ADR-0016) ------------------------------------------------------------------------
  /** The fixed instruction of manual §SEG-01; the manual generator writes this text verbatim. */
  readonly safetyInstruction: string;

  // ---- CASE_NOTICE to the installer ---------------------------------------------------------------
  caseOpened(supervisorFirstName: string): string;
  caseReassigned(supervisorFirstName: string): string;
  readonly caseToZoneChief: string;
  caseTaken(supervisorFirstName: string): string;
  /** SAFETY case opened next to the instruction: supervisor and zone chief alerted. */
  readonly safetyCaseOpened: string;

  // ---- Supervisors --------------------------------------------------------------------------------
  /** CASE_TAKEN_NOTICE to the other supervisors of the case ("Ya lo tomó Héctor"). */
  caseTakenByOther(firstName: string): string;
  /** CASE_BRIEF to the supervisor who took the case, before the images and "Cerrar caso". */
  caseBrief(input: CaseBriefInput): string;
  caseClosedConfirmation(workOrderNumber: string, installerFirstName: string): string;
  /** Prefix of a relayed message on the bridge ("Héctor (supervisor): "). */
  relayPrefix(firstName: string, role: StaffRole): string;

  // ---- Deterministic choices (lists and buttons) --------------------------------------------------
  readonly orderChoicePrompt: string;
  orderChoiceRow(input: OrderChoiceInput): ListRowText;
  readonly caseChoicePrompt: string;
  caseChoiceRow(input: CaseChoiceInput): ListRowText;
  readonly itemChoicePrompt: string;

  // ---- Evidence -----------------------------------------------------------------------------------
  /** Actionable text of a rejection, by reason and by the item the photo was for. */
  rejectReason(reason: RejectReason, item: PhotoItem): string;
  /** `UNSURE`: the photo goes to human review and another one is asked for. */
  readonly photoInReview: string;

  // ---- Words that code puts in texts and template parameters --------------------------------------
  readonly checklistItem: Readonly<Record<ChecklistItem, string>>;
  readonly hazard: Readonly<Record<HazardCategory, string>>;
  readonly symptom: Readonly<Record<Symptom, string>>;
  /** Case category in words (template `{{4}}`, email subject lines). */
  caseReason(input: CaseReasonInput): string;
}
