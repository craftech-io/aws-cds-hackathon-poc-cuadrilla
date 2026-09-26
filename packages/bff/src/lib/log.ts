// The only logger of the Lambdas: one JSON line per event with a correlation id that is born at
// the inbound event and travels through the worker, the Harness turn, the tools and the outbound
// pipeline. Redaction is not optional (docs/architecture.md §12): values are masked with the same
// masker as the normalizer and the guardrails (lib/mask.ts: E.164 and national phones, emails,
// CURP, RFC, CLABE, cards by Luhn), ONU serials are truncated, amounts and names are masked, raw
// provider events, message bodies, transcripts, session tokens, secrets and tool results are
// dropped, and an address only ever appears as a hash.
import { randomUUID } from "node:crypto";
import { LOG_KINDS, MASK_MARKERS, maskText } from "./mask";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;
export type LogSink = (line: string) => void;

export interface Logger {
  readonly correlationId: string;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Same correlation id, extra bindings on every line (tool name, channel, turn id). */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  readonly correlationId?: string;
  readonly bindings?: LogFields;
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  /** Stamp of each line; real time (a log line is not business logic). */
  readonly now?: () => Date;
}

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_DEPTH = 6;
const MAX_STRING = 2_000;
const MAX_ARRAY = 50;

/** Markers of a log line: the typed ones of lib/mask.ts plus what only the logger masks. */
export const MASK = {
  phone: MASK_MARKERS.PHONE,
  email: MASK_MARKERS.EMAIL,
  clabe: MASK_MARKERS.CLABE,
  card: MASK_MARKERS.CARD,
  curp: MASK_MARKERS.CURP,
  rfc: MASK_MARKERS.RFC,
  document: "[document]",
  amount: "[amount]",
  name: "[name]",
  omitted: "[omitted]",
  number: "[number]",
} as const;

// Keys whose value never reaches a log line, whatever it holds: raw provider payloads, message
// bodies and transcripts (they may carry personal data before the masker runs), secrets, session
// tokens, images and full tool results.
const OMITTED_KEYS = new Set([
  "event", "rawevent", "records", "record", "payload", "toolresult", "toolresults", "output", "body", "text", "html", "transcript",
  "message_body", "mime", "content", "attachments", "image", "sessiontoken", "token", "authorization", "secret", "signature",
  "password", "key", "subkey", "overrides", "seedoverrides", "brandconfig",
]);
const ADDRESS_KEYS = new Set(["address", "to", "from", "recipient", "sender", "destination", "replyto", "cc", "bcc"]);
// "name" is masked too: log a tool or resource under `tool`, `target` or `resource`, never `name`.
const NAME_KEYS = new Set(["name", "displayname", "firstname", "lastname", "fullname", "contactname", "customername"]);

function keyMarkers(): ReadonlyMap<string, string> {
  const entries: Array<readonly [readonly string[], string]> = [
    [["phone", "phonee164", "phonenumber", "msisdn"], MASK.phone],
    [["email", "emailaddress", "mailfrom"], MASK.email],
    [["clabe"], MASK.clabe],
    [["card", "cardnumber", "pan"], MASK.card],
    [["curp"], MASK.curp],
    [["rfc"], MASK.rfc],
    [["document", "documentnumber", "ine"], MASK.document],
  ];
  return new Map(entries.flatMap(([keys, marker]) => keys.map((key) => [key, marker] as const)));
}
const KEY_MARKERS = keyMarkers();

const AMOUNT_KEY = /(amount|balance|total|paid|price|charge|debt|saldo|monto|importe|cargo)/i;
// Large numbers that are not money: instants, durations, sizes and counters keep their value.
const SAFE_NUMBER_KEY = /(at|ms|seconds|sec|bytes|exp|ttl|epoch|count|seq|version|status|statuscode|attempt|attempts|size|length|day|days|tokens|used|limit)$/i;

// Money as written in Spanish texts ("$ 1,250.00", "$850"); runs before the masker so the digits
// of an amount are never read as a phone or an account.
const MONEY_TEXT_PATTERN = /\$\s?[0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2})?/g;
// What the typed masker leaves: any free-standing run of 7+ digits (a number without separators
// the masker does not know, a large amount). Runs glued to letters, "-" or "_" are ids and hashes.
const LONG_DIGITS_PATTERN = /(?<![\w-])[0-9]{7,}(?![\w-])/g;
// Synthetic ONU serials (`DEMO` + 8 hex, packages/shared ids.ts) keep the prefix and the last four.
const ONU_SERIAL_PATTERN = /\b(DEMO)[0-9A-F]{4}([0-9A-F]{4})\b/g;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export function redactText(value: string): string {
  if (ISO_INSTANT_PATTERN.test(value)) return value;
  const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING}]` : value;
  return maskText(clipped.replace(MONEY_TEXT_PATTERN, MASK.amount), LOG_KINDS)
    .replace(LONG_DIGITS_PATTERN, MASK.number)
    .replace(ONU_SERIAL_PATTERN, "$1…$2");
}

function redactNumber(key: string, value: number): number | string {
  if (AMOUNT_KEY.test(key)) return MASK.amount;
  if (Math.abs(value) >= 1_000_000 && !SAFE_NUMBER_KEY.test(key)) return MASK.number;
  return value;
}

function redactError(error: Error, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: redactText(error.message) };
  for (const key of ["code", "reason", "channel", "table", "retryable"] as const) {
    const extra: unknown = Reflect.get(error, key);
    if (extra !== undefined) out[key] = redactValue(key, extra, depth + 1);
  }
  if (error.stack) out.stack = redactText(error.stack);
  if (error.cause !== undefined) out.cause = redactValue("cause", error.cause, depth + 1);
  return out;
}

function redactByKey(lowered: string, value: unknown): string | undefined {
  if (OMITTED_KEYS.has(lowered)) return MASK.omitted;
  const marker = KEY_MARKERS.get(lowered);
  if (marker !== undefined) return marker;
  if (ADDRESS_KEYS.has(lowered)) return typeof value === "string" && value.includes("@") ? MASK.email : MASK.phone;
  if (NAME_KEYS.has(lowered) && typeof value === "string") return MASK.name;
  return undefined;
}

export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const byKey = redactByKey(key.toLowerCase(), value);
  if (byKey !== undefined) return byKey;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number") return Number.isFinite(value) ? redactNumber(key, value) : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return MASK.number;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Error) return redactError(value, depth);
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return MASK.omitted;
  // A Money object is masked whole so neither the integer nor its text survives.
  if (AMOUNT_KEY.test(key) && typeof value === "object" && !Array.isArray(value)) return MASK.amount;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => redactValue(key, item, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`…[${value.length - MAX_ARRAY} more]`);
    return items;
  }
  if (value instanceof Map) return redactValue(key, Object.fromEntries(value), depth);
  if (value instanceof Set) return redactValue(key, [...value], depth);
  if (value instanceof Uint8Array) return MASK.omitted;
  return redactFields(Object.fromEntries(Object.entries(value)), depth + 1);
}

export function redactFields(fields: Readonly<Record<string, unknown>>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const redacted = redactValue(key, value, depth);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

export function newCorrelationId(): string {
  return randomUUID();
}

function defaultLevel(): LogLevel {
  // Stage flags are the only values read from the environment (CLAUDE.md).
  if (process.env.NODE_ENV === "test") return "warn";
  return "info";
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

function safeStringify(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    return value;
  });
}

const RESERVED = new Set(["level", "time", "message", "correlationId"]);

export function createLogger(options: LoggerOptions = {}): Logger {
  const correlationId = options.correlationId ?? newCorrelationId();
  const threshold = LEVEL_WEIGHT[options.level ?? defaultLevel()];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const bindings = redactFields(options.bindings ?? {});

  function write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const record: Record<string, unknown> = { level, time: now().toISOString(), correlationId, message: redactText(message) };
    for (const [key, value] of Object.entries({ ...bindings, ...redactFields(fields ?? {}) })) {
      record[RESERVED.has(key) ? `field_${key}` : key] = value;
    }
    let line: string;
    try {
      line = safeStringify(record);
    } catch (error) {
      line = JSON.stringify({ level: "error", time: now().toISOString(), correlationId, message: "log serialization failed", cause: error instanceof Error ? error.name : "unknown" });
    }
    sink(line);
  }

  return {
    correlationId,
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (extra) => createLogger({ ...options, correlationId, bindings: { ...(options.bindings ?? {}), ...extra } }),
  };
}

// Correlation id of an inbound event: reuse the one the caller sent (console → BFF → tool) when it
// looks like an id, otherwise mint one. Anything else would let a sender inject log content.
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function correlationIdFrom(candidate: unknown): string {
  return typeof candidate === "string" && CORRELATION_PATTERN.test(candidate) ? candidate : newCorrelationId();
}
