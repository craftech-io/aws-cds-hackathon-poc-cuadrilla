// Scripted output of the photo validator for every photo of the set (docs/seed-spec.md §10), labelled
// `scripted`: what `record_verdict` returns in the U and LF fakes (the drawn values and a plausible
// model verdict) and the final verdict the deterministic checks must reach for the datasheet's order.
// Never a real model output: a snapshot of EV-02 goes in a separate file and never changes a label.
//
// The model reports what it sees; the code decides range, wavelength, serial, cross-check and
// duplicates (`VAL-*`), so for those photos the scripted model says PASS and only the checks reject.
import type { RejectReason, RuleId } from "@cuadrilla/shared";
import { type Drawn, GENERATOR, type PhotoSpec, type PhotoSubject, type RecordVerdictInput, type ScriptedVerdict, type ScriptedVerdicts } from "./schema";

/** Reasons only the deterministic checks give, with the check that gives each. */
const CODE_CHECKS: Readonly<Partial<Record<RejectReason, RuleId>>> = {
  OUT_OF_RANGE_LOW: "VAL-RANGE",
  OUT_OF_RANGE_HIGH: "VAL-RANGE",
  WRONG_WAVELENGTH: "VAL-WAVELENGTH",
  SERIAL_MISMATCH: "VAL-SERIAL",
  READING_MISMATCH: "VAL-CROSSCHECK",
  DUPLICATE_EVIDENCE: "VAL-DUPLICATE",
};

/** Confidence under the `VAL-CONFIDENCE` threshold (0.6): the finger over the digits of ph-meter-15. */
const LOW_CONFIDENCE = 0.42;

function subjectOf(drawn: Drawn): PhotoSubject {
  if (drawn.template === "meter") return "POWER_METER";
  if (drawn.template === "label") return "ONU_LABEL";
  if (drawn.template === "rosette") return "ROSETTE";
  return "OTHER";
}

function readings(drawn: Drawn): Pick<RecordVerdictInput, "readingDbm" | "wavelengthNm" | "serial"> {
  return {
    readingDbm: drawn.template === "meter" ? drawn.readingDbm : null,
    wavelengthNm: drawn.template === "meter" ? drawn.wavelengthNm : null,
    serial: drawn.template === "label" ? drawn.serial : null,
  };
}

function quality(spec: PhotoSpec): RecordVerdictInput["quality"] {
  const kinds = new Set(spec.degradations.map((d) => d.kind));
  const glareOnTarget = spec.degradations.some((d) => d.kind === "glare" && spec.expectedVerdict !== "PASS");
  const dark = spec.degradations.find((d) => d.kind === "underexposure");
  const far = spec.degradations.some((d) => (d.kind === "zoom-out" && d.fill < 0.3) || d.kind === "close-up");
  return {
    focus: kinds.has("gaussian-blur") || kinds.has("motion-blur") ? "BLURRY" : "SHARP",
    glare: glareOnTarget ? "OBSCURING" : kinds.has("glare") ? "PARTIAL" : "NONE",
    framing: kinds.has("crop") ? "CROPPED" : far ? "TOO_FAR" : "COMPLETE",
    lighting: dark === undefined ? "GOOD" : dark.brightness < 0.3 ? "DARK" : "LOW",
  };
}

function scripted(spec: PhotoSpec): ScriptedVerdict {
  const reason = spec.expectedReason;
  const check = reason === null ? undefined : CODE_CHECKS[reason];
  const occluded = spec.degradations.some((d) => d.kind === "occlusion");
  const base = { photoId: spec.photoId, item: spec.item, source: "SCRIPTED" as const, modelCalled: reason !== "DUPLICATE_EVIDENCE" };
  if (occluded) {
    // The model half-reads the digits with low confidence: VAL-CONFIDENCE sends it to human review.
    const recordVerdict: RecordVerdictInput = { subject: subjectOf(spec.drawn), quality: quality(spec), ...readings(spec.drawn), modelVerdict: "PASS", reasonCode: null, confidence: LOW_CONFIDENCE };
    return { ...base, recordVerdict, finalVerdict: "UNSURE", finalReason: null, checks: ["VAL-CONFIDENCE"] };
  }
  if (reason === null || check !== undefined) {
    const recordVerdict: RecordVerdictInput = { subject: subjectOf(spec.drawn), quality: quality(spec), ...readings(spec.drawn), modelVerdict: "PASS", reasonCode: null, confidence: 0.93 };
    return { ...base, recordVerdict, finalVerdict: spec.expectedVerdict, finalReason: reason, checks: check === undefined ? [] : [check] };
  }
  // Quality and subject: the model sees it and rejects; nothing it can read is reported.
  const recordVerdict: RecordVerdictInput = {
    subject: subjectOf(spec.drawn),
    quality: quality(spec),
    readingDbm: null,
    wavelengthNm: null,
    serial: null,
    modelVerdict: "REJECT",
    reasonCode: reason,
    confidence: reason === "WRONG_SUBJECT" ? 0.95 : 0.88,
  };
  return { ...base, recordVerdict, finalVerdict: "REJECT", finalReason: reason, checks: [] };
}

export function scriptedVerdicts(specs: readonly PhotoSpec[]): ScriptedVerdicts {
  return {
    label: "scripted",
    note: "Scripted output of the photo validator for the U and LF fakes, generated from the datasheet: drawn values and the expected verdict. Not a model output.",
    generator: GENERATOR,
    seed: 20260926,
    rubricVersion: "v001",
    verdicts: specs.filter((spec) => spec.group === "set").map(scripted),
  };
}
