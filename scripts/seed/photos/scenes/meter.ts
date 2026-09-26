// A generic handheld optical power meter: rubber boot, LCD with the reading in segment digits, the
// wavelength and the unit, four buttons and the test port with a patch cord plugged in. No brand and
// no real model: the face only says "OPM" (texts.ts).
import { strokeText } from "../glyphs";
import { METER_TEXTS } from "../texts";
import { type DigitStyle, type Scene, circle, lcdValue, rect, verticalGradient } from "./common";

export interface MeterDrawn {
  readonly readingDbm: number;
  readonly wavelengthNm: number;
  /** Lines of a sticker stuck under the screen (ph-adv-02). */
  readonly sticker?: readonly string[];
  /** A finger over the middle digits (ph-meter-15). */
  readonly finger?: boolean;
}

const WIDTH = 640;
const HEIGHT = 940;
const LCD = { x: 84, y: 170, w: 472, h: 290 };
const DIGITS: DigitStyle = { height: 132, width: 64, thickness: 15, on: "#1b2315", off: "rgba(27,35,21,0.05)" };
const INK = "#1e2618";

/** "-21.40": how the meter prints a reading (two decimals, ASCII minus). */
export function meterDisplay(readingDbm: number): string {
  return readingDbm.toFixed(2);
}

function finger(): string {
  // A fingertip entering from the lower right, over the middle digits.
  return [
    `<g transform="rotate(-24 380 330)">`,
    `<rect x="250" y="270" width="900" height="124" rx="62" fill="url(#sc-skin)"/>`,
    `<rect x="262" y="286" width="92" height="86" rx="36" fill="#f0c9b4" opacity="0.85"/>`,
    `<path d="M420 290 Q 432 330 420 372 M520 288 Q 530 330 520 374" stroke="#b77a5c" stroke-width="3" fill="none" opacity="0.6"/>`,
    `</g>`,
  ].join("");
}

function sticker(lines: readonly string[]): string {
  const texts = lines.map((line, index) => strokeText(line, 320, 532 + index * 46, 30, { color: "#1a3fa0", weight: 0.16, anchor: "middle" }));
  return `<g transform="rotate(-3 320 550)">${rect({ x: 96, y: 506, w: 448, h: 50 + lines.length * 46 }, `fill="#f5e46c" stroke="#d8c44a" stroke-width="2"`, 4)}${texts.join("")}</g>`;
}

export function meterScene(drawn: MeterDrawn): Scene {
  const buttons: Array<[number, number, string]> = [
    [170, 640, METER_TEXTS.buttons[0]],
    [470, 640, METER_TEXTS.buttons[1]],
    [170, 800, METER_TEXTS.buttons[2]],
    [470, 800, METER_TEXTS.buttons[3]],
  ];
  const wavelengthText = `${METER_TEXTS.wavelengthSymbol} ${drawn.wavelengthNm}${METER_TEXTS.wavelengthUnit}`;
  const svg = [
    `<defs>${verticalGradient("sc-lcd", "#c6d2ab", "#a8b88a")}${verticalGradient("sc-boot", "#dc9f33", "#b97f1c")}${verticalGradient("sc-skin", "#e2ad8f", "#c58566")}</defs>`,
    // Patch cord and test port on top.
    `<path d="M320 -60 C 320 -200 300 -300 330 -520" stroke="#f0c419" stroke-width="18" fill="none" stroke-linecap="round"/>`,
    rect({ x: 290, y: -70, w: 60, h: 80 }, `fill="#1f9d55"`, 6),
    rect({ x: 262, y: 4, w: 116, h: 60 }, `fill="#8d9399" stroke="#62676c" stroke-width="3"`, 10),
    rect({ x: 0, y: 40, w: WIDTH, h: HEIGHT - 40 }, `fill="url(#sc-boot)" stroke="#8d6014" stroke-width="4"`, 70),
    rect({ x: 34, y: 74, w: WIDTH - 68, h: HEIGHT - 108 }, `fill="#2c3136"`, 46),
    strokeText(METER_TEXTS.model, 76, 104, 30, { color: "#e9ecef", weight: 0.15 }),
    rect({ x: 64, y: 150, w: 512, h: 330 }, `fill="#15181b"`, 18),
    rect(LCD, `fill="url(#sc-lcd)"`, 8),
    strokeText(wavelengthText, 110, 196, 32, { color: INK, weight: 0.15 }),
    strokeText(METER_TEXTS.referenceIndicator, 530, 196, 24, { color: INK, weight: 0.14, anchor: "end", opacity: 0.1 }),
    rect({ x: 470, y: 238, w: 58, h: 4 }, `fill="${INK}" opacity="0.1"`),
    lcdValue(meterDisplay(drawn.readingDbm), 530, 256, DIGITS),
    strokeText(METER_TEXTS.unit, 530, 408, 36, { color: INK, weight: 0.16, anchor: "end" }),
    ...buttons.map(([cx, cy, label]) => `${circle(cx, cy, 64, `fill="#464d54" stroke="#1d2126" stroke-width="6"`)}${strokeText(label, cx, cy - 17, 34, { color: "#eef1f3", weight: 0.14, anchor: "middle" })}`),
    drawn.sticker === undefined ? "" : sticker(drawn.sticker),
    drawn.finger === true ? finger() : "",
  ].join("");
  return {
    width: WIDTH,
    height: HEIGHT,
    svg,
    regions: {
      screen: LCD,
      value: { x: 96, y: 246, w: 450, h: 156 },
      wavelength: { x: 100, y: 186, w: 260, h: 54 },
      body: { x: 0, y: 40, w: WIDTH, h: HEIGHT - 40 },
    },
  };
}
