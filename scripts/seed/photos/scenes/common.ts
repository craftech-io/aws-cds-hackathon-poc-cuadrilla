// Building blocks every scene shares: the scene shape (SVG in its own coordinates plus the regions a
// degradation can aim at), a few SVG element helpers and the LCD digits of the power meter. Scenes
// are pure functions of their drawn values and a seed: no fonts, no clock, no I/O.
import { fmt } from "../prng";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A subject drawn in its own coordinates (0,0)-(width,height); content may overflow (cables). */
export interface Scene {
  readonly width: number;
  readonly height: number;
  /** SVG content, without the outer `<svg>` element. */
  readonly svg: string;
  /** Regions a degradation can target (value, serial, connector…), in scene coordinates. */
  readonly regions: Readonly<Record<string, Rect>>;
}

export function rect(r: Rect, attrs: string, radius = 0): string {
  return `<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.w)}" height="${fmt(r.h)}" rx="${fmt(radius)}" ${attrs}/>`;
}

export function circle(cx: number, cy: number, r: number, attrs: string): string {
  return `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" ${attrs}/>`;
}

/** A vertical linear gradient `id` from `top` to `bottom`. */
export function verticalGradient(id: string, top: string, bottom: string): string {
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`;
}

/** A screw head with a cross slot. */
export function screw(cx: number, cy: number, r: number): string {
  const s = r * 0.55;
  return `${circle(cx, cy, r, `fill="#d7d7d0" stroke="#a9a9a2" stroke-width="${fmt(r * 0.18)}"`)}<path d="M${fmt(cx - s)} ${fmt(cy)}L${fmt(cx + s)} ${fmt(cy)}M${fmt(cx)} ${fmt(cy - s)}L${fmt(cx)} ${fmt(cy + s)}" stroke="#8e8e88" stroke-width="${fmt(r * 0.2)}" stroke-linecap="round"/>`;
}

// ---- Seven-segment LCD digits -------------------------------------------------------------------

const SEGMENTS_BY_CHAR: Readonly<Record<string, string>> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
  "-": "g",
  " ": "",
};

export interface DigitStyle {
  readonly height: number;
  readonly width: number;
  readonly thickness: number;
  readonly on: string;
  /** Faint unlit segments, as a real LCD shows them. */
  readonly off: string;
}

function horizontal(x0: number, y: number, w: number, t: number): string {
  const g = t * 0.2;
  const pts = [
    [x0 + g + t / 2, y],
    [x0 + g + t, y - t / 2],
    [x0 + w - g - t, y - t / 2],
    [x0 + w - g - t / 2, y],
    [x0 + w - g - t, y + t / 2],
    [x0 + g + t, y + t / 2],
  ];
  return pts.map(([px, py]) => `${fmt(px ?? 0)},${fmt(py ?? 0)}`).join(" ");
}

function vertical(x: number, ys: number, ye: number, t: number): string {
  const g = t * 0.2;
  const pts = [
    [x, ys + g + t / 2],
    [x + t / 2, ys + g + t],
    [x + t / 2, ye - g - t],
    [x, ye - g - t / 2],
    [x - t / 2, ye - g - t],
    [x - t / 2, ys + g + t],
  ];
  return pts.map(([px, py]) => `${fmt(px ?? 0)},${fmt(py ?? 0)}`).join(" ");
}

function segmentPoints(segment: string, x0: number, y0: number, s: DigitStyle): string {
  const { width: w, height: h, thickness: t } = s;
  const left = x0 + t / 2;
  const right = x0 + w - t / 2;
  switch (segment) {
    case "a":
      return horizontal(x0, y0 + t / 2, w, t);
    case "g":
      return horizontal(x0, y0 + h / 2, w, t);
    case "d":
      return horizontal(x0, y0 + h - t / 2, w, t);
    case "f":
      return vertical(left, y0, y0 + h / 2, t);
    case "e":
      return vertical(left, y0 + h / 2, y0 + h, t);
    case "b":
      return vertical(right, y0, y0 + h / 2, t);
    case "c":
      return vertical(right, y0 + h / 2, y0 + h, t);
    default:
      throw new RangeError(`unknown segment ${segment}`);
  }
}

/** Advance of a digit and of the decimal point, for right-aligned values. */
export function lcdAdvance(char: string, s: DigitStyle): number {
  return char === "." ? s.thickness * 1.8 : s.width + s.thickness;
}

/** A reading such as "-21.40" in LCD digits, right-aligned so its last digit ends at `right`. */
export function lcdValue(value: string, right: number, top: number, s: DigitStyle): string {
  const chars = [...value];
  const total = chars.reduce((sum, char) => sum + lcdAdvance(char, s), 0) - s.thickness;
  let x = right - total;
  const parts: string[] = [];
  for (const char of chars) {
    if (char === ".") {
      parts.push(rect({ x: x + s.thickness * 0.1, y: top + s.height - s.thickness, w: s.thickness, h: s.thickness }, `fill="${s.on}"`));
    } else {
      const lit = SEGMENTS_BY_CHAR[char];
      if (lit === undefined) throw new RangeError(`no LCD glyph for "${char}"`);
      for (const segment of "abcdefg") {
        parts.push(`<polygon points="${segmentPoints(segment, x, top, s)}" fill="${lit.includes(segment) ? s.on : s.off}"/>`);
      }
    }
    x += lcdAdvance(char, s);
  }
  // A slight slant, pivoting on the baseline, like most segment displays.
  const pivotY = top + s.height;
  return `<g transform="translate(${fmt(right)} ${fmt(pivotY)}) skewX(-6) translate(${fmt(-right)} ${fmt(-pivotY)})">${parts.join("")}</g>`;
}
