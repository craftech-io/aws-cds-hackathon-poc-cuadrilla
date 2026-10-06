// Deterministic checks of a photo (docs/design-brief.md §5.10, ADR-0015). Before the model: type by
// magic bytes, size (Bedrock's image limit) and a repeated photo inside the world and its epoch
// (`VAL-DUPLICATE`, `WorkOrders GSI4`). After the model, over its validated `record_verdict`: the code
// compares what the model read with the order it never saw, and can only harden the verdict:
//
//   VAL-CONFIDENCE  confidence < 0.6, or a value the item needs that the model could not read → UNSURE
//   VAL-SUBJECT     the photo does not show the item's subject                        → WRONG_SUBJECT
//   VAL-WAVELENGTH  the meter is not at 1490 nm                                       → WRONG_WAVELENGTH
//   VAL-RANGE       the reading is outside the acceptance range of the order's class → OUT_OF_RANGE_*
//   VAL-SERIAL      the label's serial is not the order's ONU                         → SERIAL_MISMATCH
//   VAL-CROSSCHECK  the reading is more than 3 dB away from the orchestrator's        → READING_MISMATCH
//
// A model PASS becomes REJECT or UNSURE; a model REJECT never becomes PASS. `checks` names only the
// check that decided a verdict different from the model's (empty when the model's verdict stands).
import type { PhotoItem, RejectReason, RuleId, Verdict } from "@cuadrilla/shared";
import { sniffMediaType } from "../channels/whatsapp/media";
import { MEDIA_LIMITS } from "../channels/whatsapp/config";
import type { AcceptanceRange, Zone } from "../domain/isps";
import type { Evidence, PhotoReadings, WorkOrder } from "../domain/work-orders";
import type { PhotoSubject, RecordVerdict } from "./record-verdict";

export const VAL_RULE = {
  CONFIDENCE: "VAL-CONFIDENCE",
  SUBJECT: "VAL-SUBJECT",
  WAVELENGTH: "VAL-WAVELENGTH",
  RANGE: "VAL-RANGE",
  SERIAL: "VAL-SERIAL",
  CROSSCHECK: "VAL-CROSSCHECK",
  DUPLICATE: "VAL-DUPLICATE",
} as const satisfies Readonly<Record<string, RuleId>>;

export const CONFIDENCE_THRESHOLD = 0.6;
export const CROSSCHECK_TOLERANCE_DB = 3;
export const REQUIRED_WAVELENGTH_NM = 1490;
/** Bedrock's image limit, the same as a WhatsApp photo's (channels/whatsapp/config.ts). */
export const MAX_PHOTO_BYTES = MEDIA_LIMITS.imageBytes;

/** The subject a photo of each item has to show. */
export const SUBJECT_OF_ITEM: Readonly<Record<PhotoItem, PhotoSubject>> = {
  POWER_READING_PHOTO: "POWER_METER",
  ONU_LABEL_PHOTO: "ONU_LABEL",
  ROSETTE_PHOTO: "ROSETTE",
};

/** Reasons the model can see in a photo; the others need the order and only the code gives them. */
export const MODEL_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>(["BLURRY", "GLARE", "CROPPED", "DARK", "WRONG_SUBJECT", "UNREADABLE"]);

// ---- Before the model ------------------------------------------------------------------------------

export type PhotoType = "image/jpeg" | "image/png";

export type PrecheckResult = { readonly ok: true; readonly type: PhotoType } | { readonly ok: false; readonly problem: "UNSUPPORTED_TYPE" | "TOO_LARGE" };

/** Type by magic bytes (JPEG `FF D8 FF` or PNG) and size, before anything reads the photo. */
export function precheckPhoto(bytes: Uint8Array): PrecheckResult {
  if (bytes.length > MAX_PHOTO_BYTES) return { ok: false, problem: "TOO_LARGE" };
  const type = sniffMediaType(bytes);
  return type === "image/jpeg" || type === "image/png" ? { ok: true, type } : { ok: false, problem: "UNSUPPORTED_TYPE" };
}

/**
 * `VAL-DUPLICATE`: evidence with the same bytes on ANOTHER order of the same world and epoch (the
 * lookup by `SHA#<clockId>#<worldEpoch>#<sha256>` already confines it to the world). The same photo
 * sent again for the same order is not a duplicate.
 */
export function duplicateEvidence(found: readonly Evidence[], workOrderId: string): Evidence | undefined {
  return found.find((evidence) => evidence.workOrderId !== workOrderId);
}

/**
 * Acceptance range of the order's optical class (manual §MED-01): the order's own zone when it has
 * that class, else any zone of the operator with it; `undefined` when no zone defines the class.
 */
export function acceptanceRangeFor(order: Pick<WorkOrder, "zoneId" | "opticalClass">, zones: readonly Zone[]): AcceptanceRange | undefined {
  const own = zones.find((zone) => zone.zoneId === order.zoneId && zone.opticalClass === order.opticalClass);
  return (own ?? zones.find((zone) => zone.opticalClass === order.opticalClass))?.acceptanceRange;
}

/** A label's serial as it is compared: no spaces, upper case. */
export function normalizeSerial(serial: string): string {
  return serial.replace(/\s+/g, "").toUpperCase();
}

// ---- After the model -------------------------------------------------------------------------------

/** The orchestrator's view of the order's ONU when the cross-check needs it. */
export type NetworkReading = { readonly kind: "OK"; readonly rxPowerDbm?: number } | { readonly kind: "UNAVAILABLE" };

export interface CheckInput {
  readonly item: PhotoItem;
  /** `undefined` when the model gave no valid `record_verdict` (no `toolUse`, invalid output). */
  readonly record: RecordVerdict | undefined;
  readonly order: Pick<WorkOrder, "onuSerial">;
  readonly range: AcceptanceRange | undefined;
  /** Read only for a meter photo the model passed (`needsNetworkReading`). */
  readonly network?: NetworkReading;
}

export interface VerdictDecision {
  readonly verdict: Verdict;
  readonly reasonCode?: RejectReason;
  readonly checks: readonly RuleId[];
  readonly readings: PhotoReadings;
}

/** Only a meter photo that reaches the cross-check needs the orchestrator's reading (rejectChecks). */
export function needsNetworkReading(item: PhotoItem, record: RecordVerdict | undefined): boolean {
  if (item !== "POWER_READING_PHOTO" || record === undefined || record.confidence < CONFIDENCE_THRESHOLD) return false;
  return record.modelVerdict === "PASS" || record.reasonCode === null || !MODEL_REASONS.has(record.reasonCode);
}

function readingsOf(item: PhotoItem, record: RecordVerdict | undefined, onuSerial: string): PhotoReadings {
  if (record === undefined) return {};
  const serialMatches = item === "ONU_LABEL_PHOTO" && record.serial !== null ? normalizeSerial(record.serial) === normalizeSerial(onuSerial) : undefined;
  return {
    ...(record.readingDbm === null ? {} : { readingDbm: record.readingDbm }),
    ...(record.wavelengthNm === null ? {} : { wavelengthNm: record.wavelengthNm }),
    ...(record.serial === null ? {} : { serial: record.serial }),
    ...(serialMatches === undefined ? {} : { serialMatches }),
  };
}

const reject = (reasonCode: RejectReason, check: RuleId): Omit<VerdictDecision, "readings"> => ({ verdict: "REJECT", reasonCode, checks: [check] });
const unsure = (check: RuleId): Omit<VerdictDecision, "readings"> => ({ verdict: "UNSURE", checks: [check] });
const pass: Omit<VerdictDecision, "readings"> = { verdict: "PASS", checks: [] };

function meterChecks(record: RecordVerdict, input: CheckInput): Omit<VerdictDecision, "readings"> {
  const { readingDbm, wavelengthNm } = record;
  if (readingDbm === null || wavelengthNm === null) return unsure(VAL_RULE.CONFIDENCE);
  if (wavelengthNm !== REQUIRED_WAVELENGTH_NM) return reject("WRONG_WAVELENGTH", VAL_RULE.WAVELENGTH);
  if (input.range === undefined) return unsure(VAL_RULE.RANGE);
  if (readingDbm < input.range.minDbm) return reject("OUT_OF_RANGE_LOW", VAL_RULE.RANGE);
  if (readingDbm > input.range.maxDbm) return reject("OUT_OF_RANGE_HIGH", VAL_RULE.RANGE);
  const network = input.network;
  if (network?.kind !== "OK" || network.rxPowerDbm === undefined) return unsure(VAL_RULE.CROSSCHECK);
  if (Math.abs(readingDbm - network.rxPowerDbm) > CROSSCHECK_TOLERANCE_DB) return reject("READING_MISMATCH", VAL_RULE.CROSSCHECK);
  return pass;
}

function passChecks(record: RecordVerdict, input: CheckInput): Omit<VerdictDecision, "readings"> {
  if (record.confidence < CONFIDENCE_THRESHOLD) return unsure(VAL_RULE.CONFIDENCE);
  if (record.subject !== SUBJECT_OF_ITEM[input.item]) return reject("WRONG_SUBJECT", VAL_RULE.SUBJECT);
  switch (input.item) {
    case "POWER_READING_PHOTO":
      return meterChecks(record, input);
    case "ONU_LABEL_PHOTO":
      if (record.serial === null) return unsure(VAL_RULE.CONFIDENCE);
      return normalizeSerial(record.serial) === normalizeSerial(input.order.onuSerial) ? pass : reject("SERIAL_MISMATCH", VAL_RULE.SERIAL);
    case "ROSETTE_PHOTO":
      return pass;
  }
}

/**
 * A model REJECT stands with its reason when the reason is one the model can see. A REJECT whose
 * reason needs the order (or has none) is checked like a PASS: a failing check gives the reason; if
 * every check passes, the contradiction goes to a person (UNSURE), never to PASS.
 */
function rejectChecks(record: RecordVerdict, input: CheckInput): Omit<VerdictDecision, "readings"> {
  if (record.reasonCode !== null && MODEL_REASONS.has(record.reasonCode)) return { verdict: "REJECT", reasonCode: record.reasonCode, checks: [] };
  const checked = passChecks({ ...record, modelVerdict: "PASS" }, input);
  return checked.verdict === "PASS" ? unsure(VAL_RULE.CONFIDENCE) : checked;
}

/** The final verdict of a photo from the model's reading and the order. */
export function decideVerdict(input: CheckInput): VerdictDecision {
  const { record } = input;
  const readings = readingsOf(input.item, record, input.order.onuSerial);
  if (record === undefined) return { verdict: "UNSURE", checks: [], readings };
  const decided = record.modelVerdict === "PASS" ? passChecks(record, input) : rejectChecks(record, input);
  return { ...decided, readings };
}
