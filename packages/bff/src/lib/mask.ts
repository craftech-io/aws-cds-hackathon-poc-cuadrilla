// The one masker of sensitive data (docs/architecture.md §9.1 and §13, "PII"). Every consumer shares
// these patterns so they can never drift apart:
//
//   - channels/normalizer.ts masks every inbound text and transcript with `maskSensitive` (phones,
//     CLABE, cards, CURP, RFC) before persisting it and before building the turn envelope;
//   - lib/log.ts masks every log line with `maskText(…, LOG_KINDS)` (the same kinds plus emails);
//   - the certificate writer masks every text field before G3;
//   - infra/guardrail-policies.ts builds the G1 and G3 regexes (ANONYMIZE) from `GUARDRAIL_REGEXES`.
//
// The guardrail kinds (CURP, RFC, CLABE) are masked with exactly the regex the guardrail receives,
// and every match is masked (no extra validation), so a text that went through the normalizer never
// triggers a guardrail regex again (`mask.test.ts` checks it). Bedrock does not support lookarounds
// in custom regexes and some engines give `\d` a Unicode meaning, so those patterns only use `[0-9]`,
// `\b` and plain groups, and spell both cases because they take no flags. Cards (Luhn) are not a
// guardrail regex (G1 and G3 block them with the managed card type), so they may validate.
//
// Pure module on purpose: no imports, so the SST program can load it from infra/.

export const MASK_KINDS = ["EMAIL", "PHONE", "CLABE", "CARD", "CURP", "RFC"] as const;
export type MaskKind = (typeof MASK_KINDS)[number];

/** Typed markers that replace a masked value (`[CURP]`, `[CLABE]`, …); the model and the logs see only these. */
export const MASK_MARKERS: Readonly<Record<MaskKind, string>> = {
  EMAIL: "[EMAIL]",
  PHONE: "[TELEFONO]",
  CLABE: "[CLABE]",
  CARD: "[TARJETA]",
  CURP: "[CURP]",
  RFC: "[RFC]",
};

/** What the normalizer masks before persisting and before the envelope (CLAUDE.md, "contenido hostil"). */
export const SENSITIVE_KINDS: readonly MaskKind[] = ["PHONE", "CLABE", "CARD", "CURP", "RFC"];

/** What a log line never carries. Emails and phones go first so their digits are not read as documents. */
export const LOG_KINDS: readonly MaskKind[] = MASK_KINDS;

/** Kinds the guardrails anonymize with a custom regex; phones, emails and cards are managed types. */
export const GUARDRAIL_KINDS = ["CLABE", "CURP", "RFC"] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

// CLABE: 18 digits (bank 3, branch 3, account 11, check 1), compact, split as the bank prints it
// (3-3-11-1) or in groups of four. The check digit is not validated: G1 masks every match, so must we.
const CLABE_SOURCE = "\\b(?:[0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{11}[ -]?[0-9]|[0-9]{4}(?:[ -][0-9]{4}){3}[ -][0-9]{2})\\b";
// CURP: 4 letters, birth date (6 digits), sex (H, M or X), state (2 letters), 3 consonants, a
// differentiator and a check digit; 18 characters, in either case.
const CURP_SOURCE = "\\b[A-Za-z]{4}[0-9]{6}[HMXhmx][A-Za-z]{5}[A-Za-z0-9][0-9]\\b";
// RFC: 3 (company) or 4 (person) letters, date (6 digits) and a 3-character homoclave.
const RFC_SOURCE = "\\b[A-Za-zÑñ&]{3,4}[0-9]{6}[A-Za-z0-9]{3}\\b";

export interface GuardrailRegex {
  readonly kind: GuardrailKind;
  /** `name` of the `regexesConfig` entry (1-100 characters). */
  readonly name: string;
  /** `pattern` of the entry (1-500 characters, no lookarounds). */
  readonly pattern: string;
  readonly description: string;
}

/** Custom regexes of G1 and G3 (`sensitiveInformationPolicy.regexesConfig`, ANONYMIZE), docs/design-brief.md §5.5. */
export const GUARDRAIL_REGEXES: readonly GuardrailRegex[] = [
  { kind: "CLABE", name: "MX_CLABE", pattern: CLABE_SOURCE, description: "Mexican interbank account key (CLABE): 18 digits, compact or grouped" },
  { kind: "CURP", name: "MX_CURP", pattern: CURP_SOURCE, description: "Mexican population registry key (CURP): 18 characters with birth date, sex and state" },
  { kind: "RFC", name: "MX_RFC", pattern: RFC_SOURCE, description: "Mexican tax id (RFC): 3 or 4 letters, 6-digit date and 3-character homoclave" },
];

const EMAIL_SOURCE = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
// E.164 as people write it ("+" and 8 to 15 digits, with at most two separators between digits), or
// a Mexican 10-digit national number: area code of 2 digits and 8 more (55 1234 5678) or of 3 and 7
// (222 123 4567), with an optional parenthesis around the area code, or dictated in pairs as a
// transcript writes it (55 12 34 56 78). Never inside a longer run of digits.
const PHONE_SOURCE = [
  "\\+[0-9](?:[ .()-]{0,2}[0-9]){7,14}(?![0-9])",
  "(?<![0-9])\\(?[0-9]{2}\\)?[ .-]?[0-9]{4}[ .-]?[0-9]{4}(?![0-9])",
  "(?<![0-9])\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?![0-9])",
  "(?<![0-9])[0-9]{2}(?:[ .-][0-9]{2}){4}(?![0-9])",
].join("|");
// Card: 13 to 19 digits, optionally grouped by spaces or dashes; never right after "+" (a phone).
const CARD_SOURCE = "(?<![0-9+])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])";

/** Source of the regex of each kind; the guardrail kinds are the exact strings of `GUARDRAIL_REGEXES`. */
export const MASK_SOURCES: Readonly<Record<MaskKind, string>> = {
  EMAIL: EMAIL_SOURCE,
  PHONE: PHONE_SOURCE,
  CLABE: CLABE_SOURCE,
  CARD: CARD_SOURCE,
  CURP: CURP_SOURCE,
  RFC: RFC_SOURCE,
};

/** A fresh global regex of a kind (a shared global regex would carry `lastIndex` between callers). */
export function maskPattern(kind: MaskKind): RegExp {
  return new RegExp(MASK_SOURCES[kind], "g");
}

/** Luhn check over the digits of `value` (separators are ignored). */
export function luhnValid(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 12) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

type Replacer = (match: string) => { masked: string; hit: boolean };

function replacerOf(kind: MaskKind): Replacer {
  const marker = MASK_MARKERS[kind];
  if (kind === "CARD") return (match) => (luhnValid(match) ? { masked: marker, hit: true } : { masked: match, hit: false });
  return () => ({ masked: marker, hit: true });
}

export interface MaskResult {
  readonly text: string;
  /** How many values of each kind were replaced (kinds with none are absent). */
  readonly counts: Readonly<Partial<Record<MaskKind, number>>>;
  /** Kinds that were replaced at least once, in masking order (the normalizer audits them). */
  readonly kinds: readonly MaskKind[];
}

// Upper bound of the fixpoint loop: a replacement only removes characters, so the second pass
// already finds nothing; the bound keeps a pathological input from looping.
const MAX_PASSES = 4;

/**
 * Replaces every value of `kinds` with its typed marker. Kinds run in the order of `MASK_KINDS`
 * (emails and phones before documents, CLABE before cards, CURP before RFC), and the passes repeat
 * until nothing changes, so no match of a masked kind is left behind.
 */
export function maskSensitive(text: string, kinds: readonly MaskKind[] = SENSITIVE_KINDS): MaskResult {
  const selected = MASK_KINDS.filter((kind) => kinds.includes(kind));
  const counts: Partial<Record<MaskKind, number>> = {};
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const before = current;
    for (const kind of selected) {
      const replace = replacerOf(kind);
      current = current.replace(maskPattern(kind), (match) => {
        const { masked, hit } = replace(match);
        if (hit) counts[kind] = (counts[kind] ?? 0) + 1;
        return masked;
      });
    }
    if (current === before) break;
  }
  return { text: current, counts, kinds: selected.filter((kind) => counts[kind] !== undefined) };
}

/** `maskSensitive(text, kinds).text`. */
export function maskText(text: string, kinds: readonly MaskKind[] = SENSITIVE_KINDS): string {
  return maskSensitive(text, kinds).text;
}

/** True when `text` still holds a value that `maskSensitive(text, kinds)` would replace. */
export function containsSensitive(text: string, kinds: readonly MaskKind[] = SENSITIVE_KINDS): boolean {
  return maskSensitive(text, kinds).kinds.length > 0;
}

const MARKER_PATTERN = new RegExp(`(?:${Object.values(MASK_MARKERS).map((marker) => marker.replace(/[[\]]/g, "\\$&")).join("|")})`, "g");

/** Removes the markers (the language detector and length checks ignore them). */
export function stripMaskMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, " ");
}
