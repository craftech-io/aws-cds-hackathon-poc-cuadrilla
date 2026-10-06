// The facts of an outbound text and of the turn's tool results (docs/design-brief.md §5.5): every
// power figure, serial, order number, time, date, amount and length the agent writes has to exist in
// what a tool returned in the same turn (`Runtime/TURN#`). Both sides go through the same normalizer
// (normalize.ts), so "menos 21.4 dBm", "−21,4 dBm" and the tool's `rxPowerDbm: -21.4` are one fact.
// Pure: no clock, no I/O, no `Intl`.
import { normalizeFacts, numberOf } from "./normalize";

export interface TextFacts {
  /** `HH:MM`. */
  readonly times: readonly string[];
  /** `MM-DD`. */
  readonly dates: readonly string[];
  /** ONU serials and other mixed codes, lower case (`demo3f2c19a0`). */
  readonly codes: readonly string[];
  /** Figures that need a source: decimals, negatives and integers of two or more digits (absolute values). */
  readonly numbers: readonly number[];
}

const SECTION_REF = /§\s?[a-z]{2,4}[\s-]\d{2}/g;
const ISO_INSTANT = /(?<!\d)(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2})(?::\d{2}(?:[.,]\d+)?)?(?:z|[+−-]\d{2}:?\d{2})?/g;
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const TIME = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;
const DATE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(?:\d{4}|\d{2}))?(?![\d/])/g;
const CODE = /(?<![a-z0-9])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,24}(?![a-z0-9])/g;
const NUMBER = /(?<![\d,a-z])−?\d+(?:,\d+)?(?![\d,]*\d)(?![a-z0-9])/g;

function pad(value: string | number): string {
  return String(value).padStart(2, "0");
}

function round2(value: number): number {
  return Math.round(Math.abs(value) * 100) / 100;
}

/** Removes every match so a later pattern never reads it twice. */
function consume(text: string, pattern: RegExp, onMatch: (groups: readonly (string | undefined)[]) => void): string {
  return text.replace(pattern, (...args: unknown[]) => {
    onMatch(args.slice(0, -2) as (string | undefined)[]);
    return " ";
  });
}

/** A figure worth checking: a decimal, a negative, or an integer of two digits or more. */
function significant(raw: string, value: number): boolean {
  return raw.includes(",") || raw.startsWith("−") || Math.abs(value) >= 10;
}

function collect(source: string, into: { times: string[]; dates: string[]; codes: string[]; numbers: number[] }, allNumbers: boolean): void {
  let text = source.toLowerCase();
  text = consume(text, ISO_INSTANT, (m) => {
    into.dates.push(`${m[2] ?? ""}-${m[3] ?? ""}`);
    into.times.push(`${m[4] ?? ""}:${m[5] ?? ""}`);
  });
  text = consume(text, ISO_DATE, (m) => into.dates.push(`${m[2] ?? ""}-${m[3] ?? ""}`));
  text = normalizeFacts(text);
  text = consume(text, SECTION_REF, () => undefined);
  text = consume(text, TIME, (m) => into.times.push(`${pad(m[1] ?? "")}:${m[2] ?? ""}`));
  text = consume(text, DATE, (m) => {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) into.dates.push(`${pad(month)}-${pad(day)}`);
  });
  text = consume(text, CODE, (m) => {
    if (m[0] !== undefined) into.codes.push(m[0]);
  });
  consume(text, NUMBER, (m) => {
    const raw = m[0] ?? "";
    const value = numberOf(raw);
    if (value !== undefined && (allNumbers || significant(raw, value))) into.numbers.push(round2(value));
  });
}

/** The facts of a text the agent wrote. */
export function extractTextFacts(text: string): TextFacts {
  const into = { times: [] as string[], dates: [] as string[], codes: [] as string[], numbers: [] as number[] };
  collect(text, into, false);
  return into;
}

// ---- Facts of the sources -------------------------------------------------------------------------

export interface SourceFacts {
  readonly times: Set<string>;
  readonly dates: Set<string>;
  readonly codes: Set<string>;
  readonly numbers: Set<number>;
}

const MAX_DEPTH = 12;

function walk(value: unknown, facts: SourceFacts, depth: number): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) facts.numbers.add(round2(value));
    return;
  }
  if (typeof value === "string") {
    const into = { times: [] as string[], dates: [] as string[], codes: [] as string[], numbers: [] as number[] };
    collect(value, into, true);
    into.times.forEach((time) => facts.times.add(time));
    into.dates.forEach((date) => facts.dates.add(date));
    into.codes.forEach((code) => facts.codes.add(code));
    into.numbers.forEach((number) => facts.numbers.add(number));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, facts, depth + 1);
    return;
  }
  if (typeof value === "object") for (const item of Object.values(value)) walk(item, facts, depth + 1);
}

/** Every fact the tool outputs of the turn name (redacted outputs, as `Runtime/TURN#` keeps them). */
export function collectSourceFacts(sources: readonly unknown[]): SourceFacts {
  const facts: SourceFacts = { times: new Set(), dates: new Set(), codes: new Set(), numbers: new Set() };
  for (const source of sources) walk(source, facts, 0);
  return facts;
}

function hasNumber(facts: SourceFacts, value: number): boolean {
  for (const known of facts.numbers) if (Math.abs(known - value) < 0.005) return true;
  return false;
}

/** The facts of `text` no source names, as short labels (`time 12:30`, `number 150`); never the text itself. */
export function ungroundedFacts(text: string, sources: SourceFacts): string[] {
  const found = extractTextFacts(text);
  return [
    ...found.times.filter((time) => !sources.times.has(time)).map((time) => `time ${time}`),
    ...found.dates.filter((date) => !sources.dates.has(date)).map((date) => `date ${date.slice(3)}/${date.slice(0, 2)}`),
    ...found.codes.filter((code) => !sources.codes.has(code)).map(() => "code"),
    ...found.numbers.filter((number) => !hasNumber(sources, number)).map((number) => `number ${number}`),
  ];
}
