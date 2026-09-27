// Entity ids (docs/seed-spec.md §2). Ids are prefixed and human-readable, so a fixture such as
// `wo-24817` or `ph-label-06` reads on its own in a flow, a log or an audit entry. Each kind has one
// body pattern; `isId`, `idSchema` and `makeId` enforce the same one. Tables shared by every world
// (`People`, `WorkOrders`) need distinct ids per world: a cloned order or customer carries the clock
// tag of its world (`wo-24817-g03`, see clock-ids.ts), and QA people embed their run and scenario.
import { z } from "zod";
import { ManualCategory, PersonRole, PhotoItem } from "./enums";
import { ULID_BODY } from "./ulid";

// Lower-case slug (`zone-norte`, `crew-n3`).
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
// QA ids embed the run id, which may be `local-<ULID>` (upper case): `inst-qa-local-01J9ZQ-sc-02-a`.
const TOKEN = "[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";
// A 5-digit number, plus the suffix of a cloned world: the clock tag of a guest world (`-g03`), or
// a run-scoped token where a QA world clones a numbered entity it does not lease.
const NUMBERED = `\\d{5}(?:-${TOKEN})?`;
const PHOTO_ITEMS = PhotoItem.options.join("|");

export const ID_SPEC = {
  isp: { prefix: "isp", body: TOKEN },
  zone: { prefix: "zone", body: SLUG },
  crew: { prefix: "crew", body: SLUG },
  installer: { prefix: "inst", body: TOKEN },
  supervisor: { prefix: "sup", body: TOKEN },
  zoneChief: { prefix: "zc", body: TOKEN },
  customer: { prefix: "cust", body: NUMBERED },
  workOrder: { prefix: "wo", body: NUMBERED },
  case: { prefix: "case", body: ULID_BODY },
  evidence: { prefix: "ev", body: ULID_BODY },
  validation: { prefix: "val", body: ULID_BODY },
  // The 60 photos of the set, the historical renders of 12/10, the seeding renders and the main story's
  // own renders (§10, §10.1).
  photo: { prefix: "ph", body: `(?:(?:meter|label|rosette|adv|hist|story)-\\d{2}|seed-(?:${PHOTO_ITEMS})-\\d{2})` },
  voiceNote: { prefix: "vn", body: "\\d{2}" },
  question: { prefix: "q", body: "[AR]-\\d{2}" },
  consoleUser: { prefix: "usr", body: TOKEN },
} as const;

export type IdKind = keyof typeof ID_SPEC;
export type IdPrefix = (typeof ID_SPEC)[IdKind]["prefix"];

export const ID_PREFIX = Object.fromEntries(Object.entries(ID_SPEC).map(([kind, spec]) => [kind, spec.prefix])) as {
  readonly [K in IdKind]: (typeof ID_SPEC)[K]["prefix"];
};

const PATTERNS = Object.fromEntries(
  Object.entries(ID_SPEC).map(([kind, spec]) => [kind, new RegExp(`^${spec.prefix}-${spec.body}$`)]),
) as Readonly<Record<IdKind, RegExp>>;

const KIND_BY_PREFIX = new Map<string, IdKind>((Object.keys(ID_SPEC) as IdKind[]).map((kind) => [ID_SPEC[kind].prefix, kind]));

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && PATTERNS[kind].test(value);
}

export function idSchema(kind: IdKind): z.ZodString {
  return z.string().regex(PATTERNS[kind], `expected a ${kind} id "${ID_SPEC[kind].prefix}-…" (docs/seed-spec.md §2)`);
}

/** Joins `parts` with dashes after the prefix; throws RangeError when the result is not a valid id. */
export function makeId(kind: IdKind, ...parts: ReadonlyArray<string | number>): string {
  const id = `${ID_SPEC[kind].prefix}-${parts.map(String).join("-")}`;
  if (!isId(kind, id)) throw new RangeError(`invalid ${kind} id "${id}"`);
  return id;
}

export function kindOfId(value: string): IdKind | undefined {
  const dash = value.indexOf("-");
  if (dash <= 0) return undefined;
  const kind = KIND_BY_PREFIX.get(value.slice(0, dash));
  return kind !== undefined && isId(kind, value) ? kind : undefined;
}

export const IspId = idSchema("isp");
export type IspId = z.infer<typeof IspId>;
export const ZoneId = idSchema("zone");
export type ZoneId = z.infer<typeof ZoneId>;
export const CrewId = idSchema("crew");
export type CrewId = z.infer<typeof CrewId>;
export const InstallerId = idSchema("installer");
export type InstallerId = z.infer<typeof InstallerId>;
export const SupervisorId = idSchema("supervisor");
export type SupervisorId = z.infer<typeof SupervisorId>;
export const ZoneChiefId = idSchema("zoneChief");
export type ZoneChiefId = z.infer<typeof ZoneChiefId>;
export const CustomerId = idSchema("customer");
export type CustomerId = z.infer<typeof CustomerId>;
export const WorkOrderId = idSchema("workOrder");
export type WorkOrderId = z.infer<typeof WorkOrderId>;
export const CaseId = idSchema("case");
export type CaseId = z.infer<typeof CaseId>;
export const EvidenceId = idSchema("evidence");
export type EvidenceId = z.infer<typeof EvidenceId>;
export const ValidationId = idSchema("validation");
export type ValidationId = z.infer<typeof ValidationId>;
export const PhotoId = idSchema("photo");
export type PhotoId = z.infer<typeof PhotoId>;
export const VoiceNoteId = idSchema("voiceNote");
export type VoiceNoteId = z.infer<typeof VoiceNoteId>;
export const QuestionId = idSchema("question");
export type QuestionId = z.infer<typeof QuestionId>;
export const ConsoleUserId = idSchema("consoleUser");
export type ConsoleUserId = z.infer<typeof ConsoleUserId>;

// ---- People ------------------------------------------------------------------------------------

const PERSON_KIND_BY_ROLE = { INSTALLER: "installer", SUPERVISOR: "supervisor", ZONE_CHIEF: "zoneChief", CUSTOMER: "customer" } as const satisfies Record<
  PersonRole,
  IdKind
>;

/** Staff of an operator (`People/PERSON#<personId>`): installers, supervisors and zone chiefs. */
export const PersonId = z.string().refine((value) => {
  const role = personRoleOfId(value);
  return role !== undefined && role !== "CUSTOMER";
}, "expected an inst-, sup- or zc- id");
export type PersonId = z.infer<typeof PersonId>;

/** Role a person id encodes by its prefix (`inst-` → INSTALLER, `cust-` → CUSTOMER). */
export function personRoleOfId(value: string): PersonRole | undefined {
  return PersonRole.options.find((role) => isId(PERSON_KIND_BY_ROLE[role], value));
}

// ---- Work orders -------------------------------------------------------------------------------

/** Public number of a work order: 5 digits (`24817`). */
export const WorkOrderNumber = z.string().regex(/^\d{5}$/, "expected a 5-digit work order number");
export type WorkOrderNumber = z.infer<typeof WorkOrderNumber>;

/**
 * Number ranges (docs/architecture.md §5): the demo world and every guest world use 24800-24899 (so
 * guest clones carry a clock tag), QA worlds lease 70000-79999 and evaluation runs use 80000-89999.
 */
export const WORK_ORDER_NUMBER_RANGES = {
  demo: { min: 24800, max: 24899 },
  qa: { min: 70000, max: 79999 },
  eval: { min: 80000, max: 89999 },
} as const;
export type WorkOrderNumberRange = keyof typeof WORK_ORDER_NUMBER_RANGES;

export function workOrderNumberRange(workOrderNumber: string): WorkOrderNumberRange | undefined {
  const value = Number(WorkOrderNumber.parse(workOrderNumber));
  return (Object.keys(WORK_ORDER_NUMBER_RANGES) as WorkOrderNumberRange[]).find(
    (range) => value >= WORK_ORDER_NUMBER_RANGES[range].min && value <= WORK_ORDER_NUMBER_RANGES[range].max,
  );
}

/** `wo-24817`, or `wo-24817-g03` for the clone of a model order in a guest world. */
export function workOrderId(workOrderNumber: string, clockTag?: string): WorkOrderId {
  const number = WorkOrderNumber.parse(workOrderNumber);
  return clockTag === undefined ? makeId("workOrder", number) : makeId("workOrder", number, clockTag);
}

export function workOrderNumberOf(id: string): WorkOrderNumber {
  return WorkOrderId.parse(id).slice(`${ID_SPEC.workOrder.prefix}-`.length, `${ID_SPEC.workOrder.prefix}-`.length + 5);
}

// ---- Photos, ONU, manual and versions ----------------------------------------------------------

/** One of the 60 labelled photos of the evaluation set (§10): never a historical or seeding render. */
export function isSetPhotoId(value: string): boolean {
  return /^ph-(?:meter|label|rosette|adv)-\d{2}$/.test(value);
}

/** Seeding render of a checklist item (`ph-seed-ONU_LABEL_PHOTO-03`, docs/seed-spec.md §10.1). */
export function seedPhotoId(item: PhotoItem, n: number): PhotoId {
  return makeId("photo", "seed", PhotoItem.parse(item), padNumber(n, 2));
}

/** Synthetic ONU serial: `DEMO` and 8 upper-case hex digits (a generic prefix, no manufacturer). */
export const OnuSerial = z.string().regex(/^DEMO[0-9A-F]{8}$/, "expected DEMO + 8 hex digits");
export type OnuSerial = z.infer<typeof OnuSerial>;

/** Citable section of the manual: category and two digits (`COM-04`, `SEG-01`). */
export const ManualSectionId = z.string().regex(new RegExp(`^(?:${ManualCategory.options.join("|")})-\\d{2}$`), "expected a manual section id such as COM-04");
export type ManualSectionId = z.infer<typeof ManualSectionId>;

export function manualCategoryOf(sectionId: string): ManualCategory {
  return ManualCategory.parse(ManualSectionId.parse(sectionId).slice(0, -3));
}

function padNumber(value: number, width: number): string {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`invalid number ${value}`);
  return value.toString().padStart(width, "0");
}

/** `v001` for versioned items and objects (`RUBRIC#v001`, `manual/v001/`, `vocabulary-v001.txt`). */
export function versionTag(version: number, width = 3): string {
  return `v${padNumber(version, width)}`;
}

export const VersionTag = z.string().regex(/^v\d{3}$/, "expected v001");
export type VersionTag = z.infer<typeof VersionTag>;
