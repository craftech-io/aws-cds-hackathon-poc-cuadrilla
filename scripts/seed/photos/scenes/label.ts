// The label of a generic ONU ("ONU-G1"): a sticker on the white plastic body with the model, the
// serial (DEMO + 8 hex), a fictitious MAC (locally administered, prefix 02, never a vendor's), an SSID
// "RED-" + 4 characters, an example Wi-Fi key, a synthetic QR and a barcode. The same serial always
// draws the same MAC, SSID, key, QR and barcode, so every photo of one ONU shows the same label.
import { strokeText } from "../glyphs";
import { createRng, fmt, seedFor } from "../prng";
import { LABEL_TEXTS } from "../texts";
import { type Rect, type Scene, rect, verticalGradient } from "./common";

export interface LabelFields {
  readonly serial: string;
  readonly mac: string;
  readonly ssid: string;
  readonly wifiKey: string;
}

export interface LabelDrawn extends LabelFields {
  /** Lines printed on the label instead of the barcode (ph-adv-01). */
  readonly injection?: readonly string[];
}

const WIDTH = 1000;
const HEIGHT = 660;
const QR: Rect = { x: 752, y: 92, w: 136, h: 136 };
// Without 0/O, 1/I, 5/S or 8/B: an example key nobody misreads.
const KEY_ALPHABET = "ACDEFGHJKLMNPQRTUVWXYZ234679";
const HEX = "0123456789ABCDEF";

/** The label fields an ONU with `serial` prints. */
export function labelFields(serial: string): LabelFields {
  const rng = createRng(seedFor("onu-label", serial));
  const bytes = Array.from({ length: 5 }, () => `${HEX[rng.int(0, 15)]}${HEX[rng.int(0, 15)]}`);
  const key = Array.from({ length: 8 }, () => rng.pick([...KEY_ALPHABET])).join("");
  const ssid = Array.from({ length: 4 }, () => rng.pick([...KEY_ALPHABET])).join("");
  return { serial, mac: ["02", ...bytes].join(":"), ssid: `RED-${ssid}`, wifiKey: key };
}

/** A synthetic QR: the three finder squares and modules from the serial's stream (encodes nothing). */
function pseudoQr(serial: string, area: Rect): string {
  const size = 21;
  const cell = area.w / size;
  const rng = createRng(seedFor("onu-qr", serial));
  const inFinder = (r: number, c: number): boolean => (r < 8 && c < 8) || (r < 8 && c >= size - 8) || (r >= size - 8 && c < 8);
  const parts: string[] = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!inFinder(r, c) && rng.next() < 0.48) parts.push(`M${fmt(area.x + c * cell)} ${fmt(area.y + r * cell)}h${fmt(cell)}v${fmt(cell)}h${fmt(-cell)}z`);
    }
  }
  const finder = (r: number, c: number): string => {
    const x = area.x + c * cell;
    const y = area.y + r * cell;
    return `${rect({ x, y, w: 7 * cell, h: 7 * cell }, `fill="#111"`)}${rect({ x: x + cell, y: y + cell, w: 5 * cell, h: 5 * cell }, `fill="#f8f8f4"`)}${rect({ x: x + 2 * cell, y: y + 2 * cell, w: 3 * cell, h: 3 * cell }, `fill="#111"`)}`;
  };
  return `${finder(0, 0)}${finder(0, size - 7)}${finder(size - 7, 0)}<path d="${parts.join("")}" fill="#111"/>`;
}

function barcode(serial: string, area: Rect): string {
  const rng = createRng(seedFor("onu-barcode", serial));
  const unit = 3;
  const parts: string[] = [];
  let x = area.x;
  let dark = true;
  while (x < area.x + area.w - 4 * unit) {
    const width = rng.int(1, 4) * unit;
    if (dark) parts.push(`M${fmt(x)} ${fmt(area.y)}h${fmt(width)}v${fmt(area.h)}h${fmt(-width)}z`);
    x += width;
    dark = !dark;
  }
  return `<path d="${parts.join("")}" fill="#141414"/>`;
}

export function labelScene(drawn: LabelDrawn): Scene {
  const ink = { color: "#161616", weight: 0.13 } as const;
  const vents = [0, 1, 2, 3, 4, 5].map((i) => `M34 ${180 + i * 50}h28M938 ${180 + i * 50}h28`).join("");
  const bottom =
    drawn.injection === undefined
      ? barcode(drawn.serial, { x: 124, y: 500, w: 520, h: 66 })
      : drawn.injection.map((line, index) => strokeText(line, 124, 496 + index * 46, 32, { color: "#c1121f", weight: 0.17 })).join("");
  const svg = [
    `<defs>${verticalGradient("sc-plastic", "#f0efea", "#d6d5cf")}${verticalGradient("sc-sticker", "#fbfbf8", "#ecece6")}</defs>`,
    rect({ x: 0, y: 0, w: WIDTH, h: HEIGHT }, `fill="url(#sc-plastic)" stroke="#b9b8b1" stroke-width="3"`, 40),
    `<path d="${vents}" stroke="#c3c2bb" stroke-width="12" stroke-linecap="round"/>`,
    rect({ x: 80, y: 60, w: 840, h: 540 }, `fill="url(#sc-sticker)" stroke="#c9c9c1" stroke-width="2"`, 14),
    strokeText(LABEL_TEXTS.model, 124, 96, 54, { color: "#111", weight: 0.17 }),
    strokeText(LABEL_TEXTS.modelLine, 124, 180, 24, ink),
    strokeText(`${LABEL_TEXTS.serialPrefix}${drawn.serial}`, 124, 240, 42, { color: "#0d0d0d", weight: 0.16 }),
    strokeText(`${LABEL_TEXTS.macPrefix}${drawn.mac}`, 124, 316, 27, ink),
    strokeText(`${LABEL_TEXTS.ssidPrefix}${drawn.ssid}`, 124, 364, 27, ink),
    strokeText(`${LABEL_TEXTS.wifiKeyPrefix}${drawn.wifiKey}`, 124, 412, 27, ink),
    strokeText(LABEL_TEXTS.rating, 124, 458, 20, ink),
    pseudoQr(drawn.serial, QR),
    bottom,
  ].join("");
  return {
    width: WIDTH,
    height: HEIGHT,
    svg,
    regions: {
      label: { x: 80, y: 60, w: 840, h: 540 },
      serial: { x: 110, y: 228, w: 680, h: 66 },
      qr: QR,
      body: { x: 0, y: 0, w: WIDTH, h: HEIGHT },
    },
  };
}
