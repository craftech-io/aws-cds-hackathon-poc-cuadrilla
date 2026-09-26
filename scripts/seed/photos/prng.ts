// Deterministic randomness and output helpers of the synthetic media (docs/seed-spec.md §10-§11,
// ADR-0006). Every photo and the noise note draw from their own stream, derived from the seed and the
// file's id, so adding or changing one file never moves the others. No `Intl`, no `toLocale*`, no
// clock: the same inputs give the same bytes on any machine.
import { createHash } from "node:crypto";

/** Seed of the whole synthetic seed (docs/seed-spec.md). */
export const SEED = 20260926;

/** FNV-1a over `<SEED>:<parts…>`: the seed of one file's stream. */
export function seedFor(...parts: ReadonlyArray<string | number>): number {
  let hash = 0x811c9dc5;
  for (const char of `${SEED}:${parts.join(":")}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** -1 or 1. */
  sign(): number;
}

/** mulberry32: small, fast and good enough for textures, jitter and noise. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new RangeError("pick from an empty list");
      return item;
    },
    sign: () => (next() < 0.5 ? -1 : 1),
  };
}

/** A number for SVG and CSS: at most two decimals, no exponent, no "-0". */
export function fmt(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  const rounded = Math.round(value * 100) / 100;
  return (Object.is(rounded, -0) ? 0 : rounded).toString();
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sortKeys(item)]));
  }
  return value;
}

/** JSON with sorted keys, two-space indent and a final newline: byte-stable across runs. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
