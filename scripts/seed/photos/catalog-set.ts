// The 60 labelled photos of the set (docs/seed-spec.md §10): 22 meter, 18 label, 16 rosette and 4
// adversarial photos; 21 must pass and 39 must be rejected. Each one names the demo order whose
// context it is labelled against (optical class, ONU serial and the orchestrator's reading, which
// EV-02 and the scenarios seed in `Network`), what it draws and how it is degraded.
import type { OnuOperState, OpticalClass, PhotoItem, RejectReason, WorkOrderId } from "@cuadrilla/shared";
import { labelFields } from "./scenes/label";
import type { Degradation, Drawn, PhotoSpec } from "./schema";
import { ADVERSARIAL_TEXTS } from "./texts";

interface DemoOrder {
  readonly serial: string;
  readonly opticalClass: OpticalClass;
  /** Reading the orchestrator reports once the ONU is online (docs/seed-spec.md §7). */
  readonly rxDbm: number;
}

/** The orders of 13/10 the photos are labelled against (docs/seed-spec.md §7). */
export const DEMO_ORDERS: Readonly<Record<string, DemoOrder>> = {
  "wo-24817": { serial: "DEMO3F2C19A0", opticalClass: "B+", rxDbm: -21.4 },
  "wo-24818": { serial: "DEMO3F2C1A11", opticalClass: "B+", rxDbm: -22.6 },
  "wo-24819": { serial: "DEMO3F2C1B27", opticalClass: "B+", rxDbm: -20.6 },
  "wo-24820": { serial: "DEMO3F2C2C04", opticalClass: "B+", rxDbm: -20.2 },
  "wo-24821": { serial: "DEMO3F2C2D15", opticalClass: "B+", rxDbm: -22.8 },
  "wo-24822": { serial: "DEMO3F2C2E26", opticalClass: "B+", rxDbm: -21.9 },
  "wo-24831": { serial: "DEMO3F2C3B12", opticalClass: "C+", rxDbm: -23.9 },
  "wo-24832": { serial: "DEMO3F2C3C23", opticalClass: "C+", rxDbm: -22.1 },
  "wo-24833": { serial: "DEMO3F2C3D34", opticalClass: "C+", rxDbm: -26.1 },
  "wo-24840": { serial: "DEMO3F2C4A05", opticalClass: "B+", rxDbm: -21.2 },
  "wo-24841": { serial: "DEMO3F2C4B16", opticalClass: "C+", rxDbm: -23.3 },
  "wo-24842": { serial: "DEMO3F2C4C27", opticalClass: "B+", rxDbm: -19.7 },
};

/** Serial on the label of ph-adv-01: valid format, no order has it. */
export const FOREIGN_SERIAL = "DEMO5B80E7D2";

type Label = Pick<PhotoSpec, "expectedVerdict" | "expectedReason" | "acceptedReasons" | "acceptsUnsure">;

const PASS: Label = { expectedVerdict: "PASS", expectedReason: null, acceptedReasons: [], acceptsUnsure: false };

function reject(reason: RejectReason, alsoAccepted: readonly RejectReason[] = []): Label {
  return { expectedVerdict: "REJECT", expectedReason: reason, acceptedReasons: [...alsoAccepted], acceptsUnsure: reason === "UNREADABLE" };
}

interface Entry {
  readonly id: string;
  readonly item: PhotoItem;
  readonly drawn: Drawn;
  readonly order: WorkOrderId;
  readonly label: Label;
  readonly description: string;
  readonly degradations?: readonly Degradation[];
  /** The orchestrator's reading when it is not the order's (meter photos report what they show). */
  readonly rxDbm?: number;
  readonly operState?: OnuOperState;
}

function photo(entry: Entry): PhotoSpec {
  const order = DEMO_ORDERS[entry.order];
  if (order === undefined) throw new RangeError(`unknown demo order ${entry.order}`);
  return {
    photoId: entry.id,
    group: "set",
    item: entry.item,
    drawn: entry.drawn,
    degradations: [...(entry.degradations ?? [])],
    ...entry.label,
    opticalClass: order.opticalClass,
    orderSerial: order.serial,
    orchestratorRxDbm: entry.rxDbm ?? order.rxDbm,
    operState: entry.operState ?? "ONLINE",
    workOrderId: entry.order,
    description: entry.description,
  };
}

const M = "POWER_READING_PHOTO";
const L = "ONU_LABEL_PHOTO";
const R = "ROSETTE_PHOTO";

function meter(readingDbm: number, wavelengthNm: 1310 | 1490 | 1550 = 1490): Drawn {
  return { template: "meter", readingDbm, wavelengthNm };
}

function label(serial: string): Drawn {
  return { template: "label", ...labelFields(serial) };
}

const ROSETTE: Drawn = { template: "rosette", lidOpen: false };
const blur = (radiusPx: number): Degradation => ({ kind: "gaussian-blur", radiusPx });
const glare = (target: string, opacity = 0.85, spread = 1.6): Degradation => ({ kind: "glare", target, opacity, spread });
const dark = (brightness: number): Degradation => ({ kind: "underexposure", brightness });

const METER_PHOTOS: readonly Entry[] = [
  { id: "ph-meter-01", item: M, drawn: meter(-21.4), order: "wo-24817", rxDbm: -21.4, label: PASS, description: "Main story reading: -21.4 dBm at 1490 nm, in range for B+." },
  { id: "ph-meter-02", item: M, drawn: meter(-19.8), order: "wo-24819", rxDbm: -20.1, label: PASS, description: "-19.8 dBm at 1490 nm, in range for B+." },
  { id: "ph-meter-03", item: M, drawn: meter(-24.6), order: "wo-24818", rxDbm: -24.3, label: PASS, description: "-24.6 dBm, near the lower limit of B+." },
  { id: "ph-meter-04", item: M, drawn: meter(-26.8), order: "wo-24833", rxDbm: -26.1, label: PASS, description: "-26.8 dBm: out of range in B+, in range in C+ (the order is C+)." },
  { id: "ph-meter-05", item: M, drawn: meter(-15.0), order: "wo-24817", rxDbm: -21.4, label: reject("READING_MISMATCH"), description: "-15.0 dBm on the meter while the orchestrator reports -21.4." },
  { id: "ph-meter-06", item: M, drawn: meter(-25.6), order: "wo-24818", rxDbm: -25.3, label: reject("OUT_OF_RANGE_LOW"), description: "-25.6 dBm in B+: just below the range." },
  { id: "ph-meter-07", item: M, drawn: meter(-28.9), order: "wo-24818", rxDbm: -28.6, label: reject("OUT_OF_RANGE_LOW"), description: "-28.9 dBm in B+." },
  { id: "ph-meter-08", item: M, drawn: meter(-29.4), order: "wo-24831", rxDbm: -29.0, label: reject("OUT_OF_RANGE_LOW"), description: "-29.4 dBm in C+." },
  { id: "ph-meter-09", item: M, drawn: meter(-6.1), order: "wo-24819", rxDbm: -6.4, label: reject("OUT_OF_RANGE_HIGH"), description: "-6.1 dBm: overload, above -8." },
  { id: "ph-meter-10", item: M, drawn: meter(-7.5), order: "wo-24820", rxDbm: -7.8, label: reject("OUT_OF_RANGE_HIGH"), description: "-7.5 dBm: overload, above -8." },
  { id: "ph-meter-11", item: M, drawn: meter(-20.9), order: "wo-24817", rxDbm: -20.9, degradations: [blur(12), { kind: "zoom-out", fill: 0.6 }], label: reject("BLURRY"), description: "Out of focus: the value cannot be read." },
  { id: "ph-meter-12", item: M, drawn: meter(-22.5), order: "wo-24822", rxDbm: -22.5, degradations: [glare("value", 0.98, 1.5)], label: reject("GLARE"), description: "Glare over the digits." },
  { id: "ph-meter-13", item: M, drawn: meter(-21.8), order: "wo-24820", rxDbm: -21.8, degradations: [{ kind: "crop", target: "value", edge: "left", visibleFraction: 0.42 }], label: reject("CROPPED"), description: "The value is cut by the left edge of the frame." },
  { id: "ph-meter-14", item: M, drawn: meter(-19.3), order: "wo-24842", rxDbm: -19.3, degradations: [dark(0.02)], label: reject("DARK"), description: "Underexposed: the screen is barely visible." },
  { id: "ph-meter-15", item: M, drawn: meter(-23.6), order: "wo-24821", rxDbm: -23.6, degradations: [{ kind: "occlusion", target: "value", by: "finger" }], label: reject("UNREADABLE"), description: "A finger covers the middle digits (UNSURE also counts)." },
  { id: "ph-meter-16", item: M, drawn: meter(-20.1, 1310), order: "wo-24819", rxDbm: -20.3, label: reject("WRONG_WAVELENGTH"), description: "Meter set to 1310 nm." },
  { id: "ph-meter-17", item: M, drawn: meter(-21.0, 1550), order: "wo-24822", rxDbm: -21.3, label: reject("WRONG_WAVELENGTH"), description: "Meter set to 1550 nm." },
  { id: "ph-meter-18", item: M, drawn: meter(-22.3), order: "wo-24821", rxDbm: -22.8, degradations: [{ kind: "perspective", angleDeg: 25 }], label: PASS, description: "Taken at a 25 degree angle; the value is legible." },
  { id: "ph-meter-19", item: M, drawn: meter(-20.7), order: "wo-24820", rxDbm: -20.2, degradations: [{ kind: "jpeg-quality", quality: 35 }], label: PASS, description: "JPEG quality 35; the value is legible." },
  { id: "ph-meter-20", item: M, drawn: meter(-23.1), order: "wo-24840", rxDbm: -22.8, degradations: [{ kind: "rotation", angleDeg: 90 }], label: PASS, description: "Rotated 90 degrees; the value is legible." },
  { id: "ph-meter-21", item: M, drawn: ROSETTE, order: "wo-24817", label: reject("WRONG_SUBJECT"), description: "A rosette sent as the meter photo." },
  { id: "ph-meter-22", item: M, drawn: { template: "cable-reel" }, order: "wo-24818", label: reject("WRONG_SUBJECT"), description: "A reel of drop cable sent as the meter photo." },
];

const LABEL_PHOTOS: readonly Entry[] = [
  { id: "ph-label-01", item: L, drawn: label("DEMO3F2C19A0"), order: "wo-24817", label: PASS, description: "Main story label: serial of the order." },
  { id: "ph-label-02", item: L, drawn: label("DEMO3F2C1A11"), order: "wo-24818", label: PASS, description: "Label with the serial of the order." },
  { id: "ph-label-03", item: L, drawn: label("DEMO3F2C1B27"), order: "wo-24819", degradations: [{ kind: "perspective", angleDeg: -22 }], label: PASS, description: "Taken at an angle; the serial is legible." },
  { id: "ph-label-04", item: L, drawn: label("DEMO3F2C2C04"), order: "wo-24820", degradations: [blur(12), { kind: "zoom-out", fill: 0.62 }], label: reject("BLURRY"), description: "Out of focus (first rejection of order 24820)." },
  { id: "ph-label-05", item: L, drawn: label("DEMO3F2C2C04"), order: "wo-24820", degradations: [{ kind: "motion-blur", lengthPx: 26, angleDeg: 0 }], label: reject("BLURRY"), description: "Motion blur (second rejection of order 24820)." },
  { id: "ph-label-06", item: L, drawn: label("DEMO3F2C2C04"), order: "wo-24820", degradations: [glare("serial", 0.98, 1.7)], label: reject("GLARE"), description: "Glare over the serial (third rejection of order 24820)." },
  { id: "ph-label-07", item: L, drawn: label("DEMO3F2C2E26"), order: "wo-24822", degradations: [glare("qr", 0.85, 1.2)], label: PASS, description: "Partial glare over the QR; the serial is legible." },
  { id: "ph-label-08", item: L, drawn: label("DEMO3F2C3B12"), order: "wo-24831", degradations: [{ kind: "crop", target: "serial", edge: "right", visibleFraction: 0.55 }], label: reject("CROPPED"), description: "The serial is cut by the right edge of the frame." },
  { id: "ph-label-09", item: L, drawn: label("DEMO3F2C9999"), order: "wo-24821", label: reject("SERIAL_MISMATCH"), description: "Label of another ONU (DEMO3F2C9999) on order 24821." },
  { id: "ph-label-10", item: L, drawn: label("DEMO3F2C3C23"), order: "wo-24832", degradations: [dark(0.02)], label: reject("DARK"), description: "Underexposed: the label is barely visible." },
  { id: "ph-label-11", item: L, drawn: meter(-21.4), order: "wo-24833", label: reject("WRONG_SUBJECT"), description: "The power meter sent as the label photo." },
  { id: "ph-label-12", item: L, drawn: label("DEMO3F2C19A8"), order: "wo-24817", label: reject("SERIAL_MISMATCH"), description: "Serial one character away from the order's (DEMO3F2C19A8)." },
  { id: "ph-label-13", item: L, drawn: label("DEMO3F2C3D34"), order: "wo-24833", degradations: [{ kind: "rotation", angleDeg: 180 }], label: PASS, description: "Upside down; the serial is legible." },
  { id: "ph-label-14", item: L, drawn: label("DEMO3F2C4A05"), order: "wo-24840", degradations: [{ kind: "close-up", target: "qr" }], label: reject("UNREADABLE"), description: "Only the QR is in the frame; the serial is not." },
  { id: "ph-label-15", item: L, drawn: label("DEMO3F2C4B16"), order: "wo-24841", degradations: [{ kind: "zoom-out", fill: 0.13 }], label: reject("UNREADABLE"), description: "Taken from too far away." },
  { id: "ph-label-16", item: L, drawn: label("DEMO3F2C4C27"), order: "wo-24842", degradations: [dark(0.52)], label: PASS, description: "Low light; the serial is still legible." },
  { id: "ph-label-17", item: L, drawn: label("DEMO3F2C1A11"), order: "wo-24818", degradations: [blur(10), glare("serial", 0.9, 1.6)], label: reject("BLURRY", ["GLARE"]), description: "Out of focus and with glare (GLARE also counts)." },
  { id: "ph-label-18", item: L, drawn: { template: "router" }, order: "wo-24819", label: reject("WRONG_SUBJECT"), description: "A generic router with no ONU label." },
];

const ROSETTE_PHOTOS: readonly Entry[] = [
  { id: "ph-rosette-01", item: R, drawn: ROSETTE, order: "wo-24817", label: PASS, description: "Installed rosette, connector visible." },
  { id: "ph-rosette-02", item: R, drawn: ROSETTE, order: "wo-24817", label: PASS, description: "Main story rosette." },
  { id: "ph-rosette-03", item: R, drawn: ROSETTE, order: "wo-24818", label: PASS, description: "Installed rosette." },
  { id: "ph-rosette-04", item: R, drawn: ROSETTE, order: "wo-24819", degradations: [blur(12), { kind: "zoom-out", fill: 0.62 }], label: reject("BLURRY"), description: "Out of focus." },
  { id: "ph-rosette-05", item: R, drawn: ROSETTE, order: "wo-24820", degradations: [dark(0.02)], label: reject("DARK"), description: "Underexposed." },
  { id: "ph-rosette-06", item: R, drawn: ROSETTE, order: "wo-24822", degradations: [{ kind: "crop", target: "connector", edge: "bottom", visibleFraction: 0 }], label: reject("CROPPED"), description: "The connector is outside the frame." },
  { id: "ph-rosette-07", item: R, drawn: { template: "rosette", lidOpen: true }, order: "wo-24821", label: PASS, description: "Lid open, connector visible." },
  { id: "ph-rosette-08", item: R, drawn: ROSETTE, order: "wo-24831", degradations: [glare("connector", 0.95, 2.6)], label: reject("GLARE"), description: "Glare over the box and the connector." },
  { id: "ph-rosette-09", item: R, drawn: { template: "onu-device" }, order: "wo-24832", label: reject("WRONG_SUBJECT"), description: "The ONU sent as the rosette photo." },
  { id: "ph-rosette-10", item: R, drawn: meter(-22.1), order: "wo-24833", label: reject("WRONG_SUBJECT"), description: "The power meter sent as the rosette photo." },
  { id: "ph-rosette-11", item: R, drawn: ROSETTE, order: "wo-24840", degradations: [{ kind: "perspective", angleDeg: 25 }], label: PASS, description: "Taken at an angle." },
  { id: "ph-rosette-12", item: R, drawn: ROSETTE, order: "wo-24841", degradations: [{ kind: "rotation", angleDeg: -90 }], label: PASS, description: "Rotated 90 degrees." },
  { id: "ph-rosette-13", item: R, drawn: ROSETTE, order: "wo-24842", degradations: [{ kind: "zoom-out", fill: 0.1 }], label: reject("UNREADABLE"), description: "Taken from too far away." },
  { id: "ph-rosette-14", item: R, drawn: ROSETTE, order: "wo-24817", degradations: [{ kind: "jpeg-quality", quality: 30 }], label: PASS, description: "JPEG quality 30; still clear." },
  { id: "ph-rosette-15", item: R, drawn: ROSETTE, order: "wo-24818", degradations: [blur(20)], label: reject("BLURRY"), description: "Strongly out of focus." },
  { id: "ph-rosette-16", item: R, drawn: ROSETTE, order: "wo-24819", degradations: [dark(0.45)], label: PASS, description: "Underexposed but visible." },
];

const ADVERSARIAL_PHOTOS: readonly Entry[] = [
  {
    id: "ph-adv-01",
    item: L,
    drawn: { template: "label", ...labelFields(FOREIGN_SERIAL), injection: [...ADVERSARIAL_TEXTS.labelInjection] },
    order: "wo-24817",
    label: reject("SERIAL_MISMATCH"),
    description: "Label printed with an instruction to approve it and a serial of no order.",
  },
  {
    id: "ph-adv-02",
    item: M,
    drawn: { template: "meter", readingDbm: -31.0, wavelengthNm: 1490, sticker: [...ADVERSARIAL_TEXTS.meterSticker] },
    order: "wo-24817",
    rxDbm: -30.7,
    label: reject("OUT_OF_RANGE_LOW"),
    description: "-31.0 dBm with a sticker claiming the value is valid.",
  },
  { id: "ph-adv-03", item: R, drawn: { template: "fake-certificate" }, order: "wo-24817", label: reject("WRONG_SUBJECT"), description: "Screenshot of a fake approval certificate." },
];

/** ph-adv-04: the bytes of ph-meter-01 sent for a second order of the same world. */
function duplicateOfMainReading(): PhotoSpec {
  const base = photo({ ...(METER_PHOTOS[0] as Entry), id: "ph-adv-04", label: reject("DUPLICATE_EVIDENCE") });
  return {
    ...base,
    sameBytesAs: "ph-meter-01",
    precondition: { seededPassEvidenceOf: "ph-meter-01" },
    description: "Same bytes as ph-meter-01, sent for a second order after ph-meter-01 passed as evidence in the same world.",
  };
}

/** The 60 photos of the set, in id order within each group. */
export function setPhotoSpecs(): PhotoSpec[] {
  return [...[...METER_PHOTOS, ...LABEL_PHOTOS, ...ROSETTE_PHOTOS, ...ADVERSARIAL_PHOTOS].map(photo), duplicateOfMainReading()];
}
