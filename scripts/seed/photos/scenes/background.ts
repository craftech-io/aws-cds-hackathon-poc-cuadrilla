// Procedural backgrounds: plastered wall, wooden table and sidewalk, made of SVG noise
// (`feTurbulence`) with a seed from the photo's stream. No image of anything real and nothing that
// depends on the network or on AWS (ADR-0006).
import { fmt } from "../prng";
import type { BackgroundKind } from "../schema";

const W = 1280;
const H = 960;

interface Layer {
  /** `baseFrequency` of the noise ("x" or "x y"). */
  readonly frequency: string;
  readonly octaves: number;
  readonly type: "fractalNoise" | "turbulence";
  /** Color the noise darkens or lightens with. */
  readonly color: readonly [number, number, number];
  /** Alpha = gain × noise + bias. */
  readonly gain: number;
  readonly bias: number;
}

const PALETTE: Readonly<Record<Exclude<BackgroundKind, "none">, { base: string; layers: readonly Layer[] }>> = {
  wall: {
    base: "#d8ccb6",
    layers: [
      { frequency: "0.006", octaves: 4, type: "fractalNoise", color: [0.42, 0.36, 0.28], gain: 0.9, bias: -0.38 },
      { frequency: "0.09", octaves: 2, type: "fractalNoise", color: [0.98, 0.96, 0.9], gain: 0.7, bias: -0.3 },
    ],
  },
  wood: {
    base: "#94643a",
    layers: [
      { frequency: "0.0022 0.07", octaves: 4, type: "fractalNoise", color: [0.28, 0.16, 0.08], gain: 1.6, bias: -0.6 },
      { frequency: "0.001 0.02", octaves: 2, type: "turbulence", color: [0.85, 0.62, 0.38], gain: 0.8, bias: -0.1 },
    ],
  },
  sidewalk: {
    base: "#a4a29c",
    layers: [
      { frequency: "0.012", octaves: 3, type: "fractalNoise", color: [0.3, 0.3, 0.29], gain: 1.2, bias: -0.48 },
      { frequency: "0.28", octaves: 1, type: "fractalNoise", color: [0.2, 0.2, 0.19], gain: 0.9, bias: -0.42 },
    ],
  },
};

function layer(id: string, spec: Layer, seed: number): string {
  const [r, g, b] = spec.color;
  const matrix = `0 0 0 0 ${fmt(r)} 0 0 0 0 ${fmt(g)} 0 0 0 0 ${fmt(b)} ${fmt(spec.gain)} 0 0 0 ${fmt(spec.bias)}`;
  return [
    `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">`,
    `<feTurbulence type="${spec.type}" baseFrequency="${spec.frequency}" numOctaves="${spec.octaves}" seed="${seed}"/>`,
    `<feColorMatrix type="matrix" values="${matrix}"/>`,
    `</filter>`,
    `<rect width="${W}" height="${H}" filter="url(#${id})"/>`,
  ].join("");
}

/** A 1280 × 960 `<svg>` with the background `kind`, or a plain dark fill for `none`. */
export function backgroundSvg(kind: BackgroundKind, seed: number): string {
  if (kind === "none") return `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#101214"/></svg>`;
  const palette = PALETTE[kind];
  const layers = palette.layers.map((spec, index) => layer(`bg-noise-${index}`, spec, (seed + index * 7919) % 100000));
  const joints = kind === "sidewalk" ? `<path d="M0 ${fmt(H * 0.62)}L${W} ${fmt(H * 0.58)}" stroke="#7f7d78" stroke-width="7" opacity="0.7"/>` : "";
  const planks = kind === "wood" ? `<path d="M0 ${fmt(H * 0.33)}H${W}M0 ${fmt(H * 0.71)}H${W}" stroke="#4a2e17" stroke-width="5" opacity="0.55"/>` : "";
  return `<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${palette.base}"/>${layers.join("")}${joints}${planks}</svg>`;
}
