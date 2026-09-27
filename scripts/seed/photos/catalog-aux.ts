// Renders outside the set (docs/seed-spec.md §10.1), with the same templates and their own seeds so
// no byte ever matches a photo of the set:
//
//   ph-hist-01..36   the accepted evidence of the 12 orders closed on 12/10 (wo-24801..24812), one per
//                    photo item; wo-24805 has two photos the validator was unsure of and a supervisor
//                    validated by hand (its two OVERRIDDEN items)
//   ph-hist-37..40   the rejected attempts of 12/10 behind the seeded profiles: two GLARE and one
//                    BLURRY for Karina, one CROPPED for Rogelio (docs/seed-spec.md §5)
//   ph-seed-<item>-<nn>  presets and "Saltar a escena": 01-08 look like a PASS, 09-16 like a REJECT
//   ph-story-<nn>    the main story's own renders that no other group has: 01 is the rejected photo of
//                    the ONU label of wo-24817, glare over its serial (packages/bff/src/story/main-story.ts,
//                    the landing's walkthrough and hero)
import { type OpticalClass, PhotoItem, type RejectReason, seedPhotoId } from "@cuadrilla/shared";
import { DEMO_ORDERS } from "./catalog-set";
import { createRng, seedFor } from "./prng";
import { labelFields } from "./scenes/label";
import type { Degradation, Drawn, PhotoSpec } from "./schema";

/** One closed order of 12/10: first three for each installer (docs/seed-spec.md §7). */
export interface HistoricalOrder {
  readonly workOrderId: string;
  readonly serial: string;
  readonly opticalClass: OpticalClass;
}

/** wo-24801..24806 in the north zone (B+), wo-24807..24812 in the south zone (C+). */
export const HISTORICAL_ORDERS: readonly HistoricalOrder[] = Array.from({ length: 12 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return { workOrderId: `wo-248${number}`, serial: `DEMO3E1B08${number}`, opticalClass: index < 6 ? "B+" : "C+" };
});

const ITEMS = PhotoItem.options;
const RANGE: Readonly<Record<OpticalClass, readonly [number, number]>> = { "B+": [-23.5, -18], "C+": [-26.5, -20] };

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function drawnFor(item: PhotoItem, serial: string, readingDbm: number): Drawn {
  if (item === "POWER_READING_PHOTO") return { template: "meter", readingDbm, wavelengthNm: 1490 };
  if (item === "ONU_LABEL_PHOTO") return { template: "label", ...labelFields(serial) };
  return { template: "rosette", lidOpen: false };
}

interface AuxLook {
  readonly degradations: readonly Degradation[];
  readonly expectedVerdict: PhotoSpec["expectedVerdict"];
  readonly expectedReason: RejectReason | null;
}

const LOOKS_PASS: AuxLook = { degradations: [], expectedVerdict: "PASS", expectedReason: null };

function looksRejected(reason: RejectReason, degradations: readonly Degradation[]): AuxLook {
  return { degradations, expectedVerdict: "REJECT", expectedReason: reason };
}

function auxPhoto(photoId: string, group: "hist" | "seed" | "story", item: PhotoItem, drawn: Drawn, look: AuxLook, context: { serial: string; opticalClass: OpticalClass; rxDbm: number; workOrderId: string | null }, description: string): PhotoSpec {
  return {
    photoId,
    group,
    item,
    drawn,
    degradations: [...look.degradations],
    expectedVerdict: look.expectedVerdict,
    expectedReason: look.expectedReason,
    acceptedReasons: [],
    acceptsUnsure: look.expectedReason === "UNREADABLE",
    opticalClass: context.opticalClass,
    orderSerial: context.serial,
    orchestratorRxDbm: context.rxDbm,
    operState: "ONLINE",
    workOrderId: context.workOrderId,
    description,
  };
}

const UNSURE_ON_24805: Readonly<Partial<Record<PhotoItem, AuxLook>>> = {
  POWER_READING_PHOTO: { degradations: [{ kind: "glare", target: "value", opacity: 0.55, spread: 1.2 }], expectedVerdict: "UNSURE", expectedReason: null },
  ROSETTE_PHOTO: { degradations: [{ kind: "underexposure", brightness: 0.3 }], expectedVerdict: "UNSURE", expectedReason: null },
};

/** Rejected attempts of 12/10: [order index, item, reason, degradations]. */
const HISTORICAL_REJECTIONS: ReadonlyArray<readonly [number, PhotoItem, RejectReason, readonly Degradation[], string]> = [
  [3, "ONU_LABEL_PHOTO", "GLARE", [{ kind: "glare", target: "serial", opacity: 0.98, spread: 1.5 }], "first GLARE rejection behind Karina's profile"],
  [3, "ONU_LABEL_PHOTO", "GLARE", [{ kind: "glare", target: "serial", opacity: 0.97, spread: 1.9 }], "second GLARE rejection behind Karina's profile"],
  [5, "POWER_READING_PHOTO", "BLURRY", [{ kind: "gaussian-blur", radiusPx: 10 }], "BLURRY rejection behind Karina's profile"],
  [1, "ROSETTE_PHOTO", "CROPPED", [{ kind: "crop", target: "connector", edge: "bottom", visibleFraction: 0 }], "CROPPED rejection behind Rogelio's profile"],
];

export function historicalPhotoSpecs(): PhotoSpec[] {
  const specs: PhotoSpec[] = [];
  HISTORICAL_ORDERS.forEach((order, orderIndex) => {
    const rng = createRng(seedFor("hist", order.workOrderId));
    const [low, high] = RANGE[order.opticalClass];
    const readingDbm = roundTenth(rng.range(low, high));
    ITEMS.forEach((item, itemIndex) => {
      const photoId = `ph-hist-${String(orderIndex * 3 + itemIndex + 1).padStart(2, "0")}`;
      const look = (order.workOrderId === "wo-24805" ? UNSURE_ON_24805[item] : undefined) ?? LOOKS_PASS;
      const context = { ...order, rxDbm: roundTenth(readingDbm + rng.range(-0.4, 0.4)) };
      const kind = look.expectedVerdict === "PASS" ? "accepted evidence" : "evidence validated by hand after an UNSURE verdict";
      specs.push(auxPhoto(photoId, "hist", item, drawnFor(item, order.serial, readingDbm), look, context, `12/10 ${kind} of ${order.workOrderId}.`));
    });
  });
  HISTORICAL_REJECTIONS.forEach(([orderIndex, item, reason, degradations, why], index) => {
    const order = HISTORICAL_ORDERS[orderIndex];
    if (order === undefined) throw new RangeError(`no historical order at ${orderIndex}`);
    const readingDbm = roundTenth(createRng(seedFor("hist-reject", index)).range(...RANGE[order.opticalClass]));
    const photoId = `ph-hist-${String(37 + index).padStart(2, "0")}`;
    specs.push(auxPhoto(photoId, "hist", item, drawnFor(item, order.serial, readingDbm), looksRejected(reason, degradations), { ...order, rxDbm: readingDbm }, `12/10 rejected attempt on ${order.workOrderId}: ${why}.`));
  });
  return specs;
}

/** Serials the PASS-looking label renders show, in `nn` order (the day's orders, then again). */
const SEED_LABEL_ORDERS = ["wo-24817", "wo-24818", "wo-24819", "wo-24820", "wo-24821", "wo-24822", "wo-24831", "wo-24832"] as const;

const SEED_REJECT_LOOKS: Readonly<Record<PhotoItem, ReadonlyArray<readonly [RejectReason, Degradation]>>> = {
  POWER_READING_PHOTO: [
    ["BLURRY", { kind: "gaussian-blur", radiusPx: 10 }],
    ["GLARE", { kind: "glare", target: "value", opacity: 0.98, spread: 1.5 }],
    ["DARK", { kind: "underexposure", brightness: 0.025 }],
    ["CROPPED", { kind: "crop", target: "value", edge: "right", visibleFraction: 0.4 }],
    ["BLURRY", { kind: "motion-blur", lengthPx: 24, angleDeg: 0 }],
    ["GLARE", { kind: "glare", target: "screen", opacity: 0.98, spread: 1.3 }],
    ["DARK", { kind: "underexposure", brightness: 0.02 }],
    ["UNREADABLE", { kind: "occlusion", target: "value", by: "finger" }],
  ],
  ONU_LABEL_PHOTO: [
    ["BLURRY", { kind: "gaussian-blur", radiusPx: 11 }],
    ["GLARE", { kind: "glare", target: "serial", opacity: 0.98, spread: 1.5 }],
    ["DARK", { kind: "underexposure", brightness: 0.02 }],
    ["CROPPED", { kind: "crop", target: "serial", edge: "right", visibleFraction: 0.5 }],
    ["BLURRY", { kind: "motion-blur", lengthPx: 28, angleDeg: 0 }],
    ["GLARE", { kind: "glare", target: "label", opacity: 0.97, spread: 1.1 }],
    ["UNREADABLE", { kind: "zoom-out", fill: 0.12 }],
    ["DARK", { kind: "underexposure", brightness: 0.02 }],
  ],
  ROSETTE_PHOTO: [
    ["BLURRY", { kind: "gaussian-blur", radiusPx: 12 }],
    ["DARK", { kind: "underexposure", brightness: 0.02 }],
    ["CROPPED", { kind: "crop", target: "connector", edge: "bottom", visibleFraction: 0 }],
    ["GLARE", { kind: "glare", target: "connector", opacity: 0.98, spread: 2.6 }],
    ["UNREADABLE", { kind: "zoom-out", fill: 0.1 }],
    ["BLURRY", { kind: "gaussian-blur", radiusPx: 18 }],
    ["DARK", { kind: "underexposure", brightness: 0.025 }],
    ["GLARE", { kind: "glare", target: "box", opacity: 0.98, spread: 1.4 }],
  ],
};

export function seedPhotoSpecs(): PhotoSpec[] {
  return ITEMS.flatMap((item) =>
    Array.from({ length: 16 }, (_, index) => {
      const nn = index + 1;
      const orderId = SEED_LABEL_ORDERS[index % 8] ?? "wo-24817";
      const order = DEMO_ORDERS[orderId];
      if (order === undefined) throw new RangeError(`unknown demo order ${orderId}`);
      // In range for both classes, so a preset may seed it on any order of the world.
      const readingDbm = roundTenth(createRng(seedFor("seed", item, nn)).range(-24.5, -14.5));
      const rejected = SEED_REJECT_LOOKS[item][index - 8];
      const look = nn <= 8 || rejected === undefined ? LOOKS_PASS : looksRejected(rejected[0], [rejected[1]]);
      const drawn = item === "ROSETTE_PHOTO" && nn === 4 ? ({ template: "rosette", lidOpen: true } as const) : drawnFor(item, order.serial, readingDbm);
      const context = { serial: order.serial, opticalClass: "B+" as const, rxDbm: readingDbm, workOrderId: null };
      return auxPhoto(seedPhotoId(item, nn), "seed", item, drawn, look, context, `Seeding render ${nn} of ${item} (${nn <= 8 ? "looks like a PASS" : `looks like a ${look.expectedReason ?? "REJECT"}`}).`);
    }),
  );
}

/** The main story's rejected label of wo-24817: the same label as ph-label-01, glare over the serial. */
export function storyPhotoSpecs(): PhotoSpec[] {
  const order = DEMO_ORDERS["wo-24817"];
  if (order === undefined) throw new RangeError("unknown demo order wo-24817");
  const look = looksRejected("GLARE", [{ kind: "glare", target: "serial", opacity: 0.98, spread: 1.5 }]);
  const context = { serial: order.serial, opticalClass: order.opticalClass, rxDbm: order.rxDbm, workOrderId: "wo-24817" };
  return [auxPhoto("ph-story-01", "story", "ONU_LABEL_PHOTO", drawnFor("ONU_LABEL_PHOTO", order.serial, order.rxDbm), look, context, "Main story: the ONU label of wo-24817 with glare over its serial, rejected before ph-label-01.")];
}
