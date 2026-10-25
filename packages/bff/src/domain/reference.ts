// `Reference` table (docs/architecture.md §5, docs/seed-spec.md §12): versioned catalogs the seed
// writes and the product reads: WhatsApp templates, rate card, name checks, photo rubric, safety
// lexicon, manual index, KB threshold, evaluation set and the text of each reject reason.
// Keys are `REF#<type>#<scope>` + the key of the type. Content-heavy catalogs keep the fields
// the code relies on strict and accept the rest (`loose`), so the seed can carry its own detail.
// A catalog's own version (`v001`) is `<catalog>Version`: `version` is the row's optimistic lock.
import { z } from "zod";
import {
  CalendarDate,
  ManualCategory,
  ManualSectionId,
  OnuOperState,
  OpticalClass,
  PhotoId,
  PhotoItem,
  QuestionId,
  RejectReason,
  TemplateName,
  Verdict,
  VersionTag,
} from "@cuadrilla/shared";
import { NonEmptyText, Sha256Hex, defineEntity } from "./common";

/** Meta's review state of a template; `LOCAL_ONLY` for a template not registered with Meta (P-01 step 8). */
export const TemplateReviewStatus = z.enum(["LOCAL_ONLY", "PENDING", "APPROVED", "REJECTED"]);
export type TemplateReviewStatus = z.infer<typeof TemplateReviewStatus>;

/** `REF#TEMPLATE#WHATSAPP` · `<name>`: one of the six `UTILITY` templates in `es_MX`. */
export const Template = defineEntity("Template", {
  name: TemplateName,
  language: z.literal("es_MX"),
  category: z.literal("UTILITY"),
  body: NonEmptyText.max(1024),
  examples: z.array(NonEmptyText.max(200)).default([]),
  buttons: z.array(NonEmptyText.max(25)).max(3).default([]),
  header: z.object({ format: z.literal("DOCUMENT"), sampleS3Key: z.string().optional() }).optional(),
  status: TemplateReviewStatus,
  metaTemplateId: z.string().max(64).optional(),
}).loose();
export type Template = z.infer<typeof Template>;

/** `REF#RATECARD#GLOBAL` · `<resource>`: a price with its official source (WP-49); `null` while provisional. */
export const RateCard = defineEntity("RateCard", {
  key: z.string().min(1).max(200),
  price: z.number().min(0).nullable(),
  unit: NonEmptyText.max(80),
  source: z.string().max(500).optional(),
  asOf: CalendarDate.optional(),
  provisional: z.boolean(),
}).loose();
export type RateCard = z.infer<typeof RateCard>;

/** `REF#NAMECHECK#GLOBAL` · `<term>`: every invented name with the search that verified it. */
export const NameCheck = defineEntity("NameCheck", {
  term: NonEmptyText.max(200),
  kind: NonEmptyText.max(40),
  checkedAt: CalendarDate,
  result: z.enum(["CLEAR", "CONFLICT"]),
}).loose();
export type NameCheck = z.infer<typeof NameCheck>;

/** `REF#RUBRIC#v<nnn>` · `<item>`: what a photo of the item must show and how it is checked. */
export const Rubric = defineEntity("Rubric", {
  rubricVersion: VersionTag,
  item: PhotoItem,
  mustShow: z.array(NonEmptyText.max(300)).min(1),
}).loose();
export type Rubric = z.infer<typeof Rubric>;

/** `REF#SAFETY_LEXICON#v<nnn>` · `<entryKey>`: a versioned copy of the safety lexicon of `copy/`. */
export const SafetyLexicon = defineEntity("SafetyLexicon", {
  lexiconVersion: VersionTag,
  entryKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
}).loose();
export type SafetyLexicon = z.infer<typeof SafetyLexicon>;

/** `REF#MANUALINDEX#v<nnn>` · `<sectionId>`: sections of the manual in force. */
export const ManualIndex = defineEntity("ManualIndex", {
  manualVersion: VersionTag,
  sectionId: ManualSectionId,
  title: NonEmptyText.max(200),
  category: ManualCategory,
  sha256: Sha256Hex.optional(),
}).loose();
export type ManualIndex = z.infer<typeof ManualIndex>;

/** `REF#KBTHRESHOLD#v<nnn>` · `META`: score threshold of `search_procedures`. */
export const KbThreshold = defineEntity("KbThreshold", {
  thresholdVersion: VersionTag,
  value: z.number().min(0).max(1),
  provisional: z.boolean(),
}).loose();
export type KbThreshold = z.infer<typeof KbThreshold>;

/** `REF#EVAL#QUESTIONS` · `<questionId>`: one of the 50 questions of `EV-01`. */
export const EvalQuestion = defineEntity("EvalQuestion", {
  questionId: QuestionId,
  type: z.enum(["A", "R"]),
  text: NonEmptyText.max(1000),
  expectedSections: z.array(ManualSectionId).default([]),
  acceptedOutcomes: z.array(NonEmptyText.max(64)).min(1),
}).loose();
export type EvalQuestion = z.infer<typeof EvalQuestion>;

/** `REF#EVAL#PHOTOS` · `<photoId>`: one of the 60 labelled photos of `EV-02`. */
export const EvalPhoto = defineEntity("EvalPhoto", {
  photoId: PhotoId,
  expectedVerdict: Verdict,
  expectedReason: RejectReason.optional(),
  opticalClass: OpticalClass.optional(),
  orchestratorRxDbm: z.number().optional(),
  operState: OnuOperState.optional(),
}).loose();
export type EvalPhoto = z.infer<typeof EvalPhoto>;

/** `REF#REJECT_REASON_COPY#es-MX` · `<reason>`: the actionable text of a reject reason (from `copy/`). */
export const RejectReasonCopy = defineEntity("RejectReasonCopy", {
  reason: RejectReason,
  locale: z.literal("es-MX"),
  text: NonEmptyText.max(500),
}).loose();
export type RejectReasonCopy = z.infer<typeof RejectReasonCopy>;

/** Schemas of the reference catalogs by entity (the generic writer of the connector). */
export const REFERENCE_ENTITIES = { Template, RateCard, NameCheck, Rubric, SafetyLexicon, ManualIndex, KbThreshold, EvalQuestion, EvalPhoto, RejectReasonCopy } as const;
export type ReferenceEntityName = keyof typeof REFERENCE_ENTITIES;
