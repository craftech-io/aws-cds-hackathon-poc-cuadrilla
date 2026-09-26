// The only "font" of the synthetic photos: a monospaced stroke font drawn as SVG paths, so the text
// in a photo is geometry embedded in the file and never depends on the fonts of the machine that
// renders it (docs/seed-spec.md §10: "fuentes embebidas"). Each glyph is a set of polylines on a
// 4 × 6 grid (x to the right, y down, cap height 6, accents above 0), written as "x,y x,y|x,y x,y".
// The zero is slashed so a serial such as DEMO3F2C19A0 never reads "DEM0" or "A O".
import { fmt } from "./prng";

const ACUTE = "1.6,-0.4 2.8,-1.4";
const TILDE = "0.4,-0.6 1.2,-1.2 2.8,-0.6 3.6,-1.2";

const SOURCE: Readonly<Record<string, string>> = {
  " ": "",
  A: "0,6 2,0 4,6|0.7,4 3.3,4",
  B: "0,3 3,3 4,2 4,1 3,0 0,0 0,6 3,6 4,5 4,4 3,3",
  C: "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5",
  D: "0,0 0,6 2.4,6 4,4.4 4,1.6 2.4,0 0,0",
  E: "4,0 0,0 0,6 4,6|0,3 3,3",
  F: "4,0 0,0 0,6|0,3 3,3",
  G: "4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3.4 2.2,3.4",
  H: "0,0 0,6|4,0 4,6|0,3 4,3",
  I: "1,0 3,0|2,0 2,6|1,6 3,6",
  J: "4,0 4,5 3,6 1,6 0,5",
  K: "0,0 0,6|4,0 0,3.6|1.4,2.6 4,6",
  L: "0,0 0,6 4,6",
  M: "0,6 0,0 2,3.6 4,0 4,6",
  N: "0,6 0,0 4,6 4,0",
  O: "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0",
  P: "0,6 0,0 3,0 4,1 4,2.4 3,3.4 0,3.4",
  Q: "1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|2.6,4.6 4.2,6.4",
  R: "0,6 0,0 3,0 4,1 4,2.4 3,3.4 0,3.4|2,3.4 4,6",
  S: "4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5",
  T: "0,0 4,0|2,0 2,6",
  U: "0,0 0,5 1,6 3,6 4,5 4,0",
  V: "0,0 2,6 4,0",
  W: "0,0 1,6 2,2.4 3,6 4,0",
  X: "0,0 4,6|4,0 0,6",
  Y: "0,0 2,3 4,0|2,3 2,6",
  Z: "0,0 4,0 0,6 4,6",
  "0": "1.4,0 2.6,0 3.6,1 3.6,5 2.6,6 1.4,6 0.4,5 0.4,1 1.4,0|3.2,1 0.8,5",
  "1": "0.8,1.2 2,0 2,6|0.8,6 3.2,6",
  "2": "0,1 1,0 3,0 4,1 4,2.2 0,6 4,6",
  "3": "0,1 1,0 3,0 4,1 4,2 3,3 1.6,3|3,3 4,4 4,5 3,6 1,6 0,5",
  "4": "3,6 3,0 0,4.2 4,4.2",
  "5": "4,0 0.4,0 0,2.8 3,2.8 4,3.8 4,5 3,6 1,6 0,5",
  "6": "3.6,0.4 2.6,0 1,0 0,1 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,4",
  "7": "0,0 4,0 1.6,6",
  "8": "1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3 1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3",
  "9": "4,2 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,5 3,6 1.4,6 0.4,5.6",
  "-": "0.8,3 3.2,3",
  ":": "2,1.6 2,1.8|2,4.6 2,4.8",
  ".": "2,5.8 2,6",
  ",": "2.2,5.6 1.6,6.8",
  "/": "3.6,0 0.4,6",
  "!": "2,0 2,4.2|2,5.8 2,6",
  "¡": "2,0 2,0.2|2,1.8 2,6",
  "?": "0,1 1,0 3,0 4,1 4,2 2,3.4 2,4.2|2,5.8 2,6",
  "¿": "2,0 2,0.2|2,1.8 2,2.6 0,4 0,5 1,6 3,6 4,5",
  "(": "2.8,0 1.6,1.4 1.6,4.6 2.8,6",
  ")": "1.2,0 2.4,1.4 2.4,4.6 1.2,6",
  "+": "2,1.6 2,4.4|0.6,3 3.4,3",
  "=": "0.6,2.2 3.4,2.2|0.6,3.8 3.4,3.8",
  "%": "0,6 4,0|0.4,0.4 1.4,0.4 1.4,1.6 0.4,1.6 0.4,0.4|2.6,4.4 3.6,4.4 3.6,5.6 2.6,5.6 2.6,4.4",
  Á: `0,6 2,0 4,6|0.7,4 3.3,4|${ACUTE}`,
  É: `4,0 0,0 0,6 4,6|0,3 3,3|${ACUTE}`,
  Í: `1,0 3,0|2,0 2,6|1,6 3,6|${ACUTE}`,
  Ó: `1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0|${ACUTE}`,
  Ú: `0,0 0,5 1,6 3,6 4,5 4,0|${ACUTE}`,
  Ñ: `0,6 0,0 4,6 4,0|${TILDE}`,
  // Lower case only where a meter prints it ("dBm", "nm") and the wavelength symbol.
  d: "4,0 4,6|4,4.9 3,6 1,6 0,5 0,3.5 1,2.5 3,2.5 4,3.5",
  m: "0,6 0,2.5|0,3.3 0.8,2.5 1.3,2.5 2,3.2 2,6|2,3.2 2.7,2.5 3.2,2.5 4,3.3 4,6",
  n: "0,6 0,2.5|0,3.5 1,2.5 3,2.5 4,3.5 4,6",
  λ: "0.4,0 1.2,0 4,6|2.2,2.2 0,6",
  "✓": "0,3.4 1.4,5 4,0.6",
};

type Point = readonly [number, number];
type Glyph = ReadonlyArray<readonly Point[]>;

function parseGlyph(source: string): Glyph {
  if (source === "") return [];
  return source.split("|").map((line) =>
    line.split(" ").map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) throw new Error(`bad glyph point "${pair}"`);
      return [x, y] as const;
    }),
  );
}

const GLYPHS: ReadonlyMap<string, Glyph> = new Map(Object.entries(SOURCE).map(([char, source]) => [char, parseGlyph(source)]));

/** Horizontal advance of one character, in grid units (glyph width 4 plus spacing). */
export const ADVANCE = 5.4;

export function hasGlyph(char: string): boolean {
  return GLYPHS.has(char);
}

/** Characters of `text` the font cannot draw; the texts of texts.ts must have none. */
export function missingGlyphs(text: string): string[] {
  return [...new Set([...text].filter((char) => !GLYPHS.has(char)))];
}

/** Width in pixels of `text` drawn with a cap height of `capHeight`. */
export function textWidth(text: string, capHeight: number): number {
  const count = [...text].length;
  return count === 0 ? 0 : ((count - 1) * ADVANCE + 4) * (capHeight / 6);
}

/** SVG path data of `text` with its top-left corner at (x, y). Throws on a character without glyph. */
export function textPath(text: string, x: number, y: number, capHeight: number): string {
  const unit = capHeight / 6;
  const parts: string[] = [];
  [...text].forEach((char, index) => {
    const glyph = GLYPHS.get(char);
    if (glyph === undefined) throw new RangeError(`the photo font has no glyph for "${char}"`);
    const left = x + index * ADVANCE * unit;
    for (const line of glyph) {
      parts.push(line.map(([gx, gy], i) => `${i === 0 ? "M" : "L"}${fmt(left + gx * unit)} ${fmt(y + gy * unit)}`).join(""));
    }
  });
  return parts.join("");
}

export interface TextStyle {
  readonly color: string;
  /** Stroke width as a fraction of the cap height (0.12 regular, 0.17 bold). */
  readonly weight?: number;
  readonly anchor?: "start" | "middle" | "end";
  readonly opacity?: number;
}

/** An SVG `<path>` element with `text` in the stroke font. */
export function strokeText(text: string, x: number, y: number, capHeight: number, style: TextStyle): string {
  const width = textWidth(text, capHeight);
  const left = style.anchor === "middle" ? x - width / 2 : style.anchor === "end" ? x - width : x;
  const opacity = style.opacity === undefined ? "" : ` opacity="${fmt(style.opacity)}"`;
  return `<path d="${textPath(text, left, y, capHeight)}" fill="none" stroke="${style.color}" stroke-width="${fmt(capHeight * (style.weight ?? 0.12))}" stroke-linecap="round" stroke-linejoin="round"${opacity}/>`;
}
