// The hostile-input contract of every untrusted text (CLAUDE.md, "Todo contenido entrante es hostil";
// docs/design-brief.md §5.2): what an installer types, what Transcribe heard in a voice note, a
// photo caption, a supervisor's words relayed back to a turn. Channel-agnostic and pure: no SDK, no
// clock. In order:
//
//   1. clean   NFC; line breaks unified; control, zero-width, bidi-override and Unicode tag
//              characters removed (they hide instructions a person never sees);
//   2. mask    lib/mask.ts `maskSensitive` (phones, CLABE, cards, CURP, RFC) BEFORE anything is
//              persisted or sent to a model; a card also yields the pre-G1 block (`prefilterBlock`);
//   3. clip    2,000 characters by code point (after masking, so a cut never frees half a value);
//   4. seal    `<`, `>` and `&` escaped, inside a block named `inbound-<6 hex>` chosen per turn. The
//              name is declared only in the envelope's `<session delim="…"/>` header and is re-drawn
//              until it appears in no content, so no text can name, close or imitate its own block.
//
// agent/envelope.ts (WP-32) assembles the envelope with `sessionHeader` and `untrustedBlocks`.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { SessionToken } from "@cuadrilla/shared";
import { type MaskKind, MASK_MARKERS, type PrefilterBlock, maskSensitive, prefilterBlock } from "../lib/mask";

/** Longest untrusted text a turn receives (docs/design-brief.md §5.2). */
export const MAX_UNTRUSTED_CHARS = 2_000;

/** What an untrusted block carries; the `kind` attribute of the block. */
export const UntrustedKind = z.enum(["TEXT", "VOICE_TRANSCRIPT", "IMAGE_CAPTION", "SUPERVISOR_TEXT"]);
export type UntrustedKind = z.infer<typeof UntrustedKind>;

// ---- Clean, mask, clip ---------------------------------------------------------------------------

// C0 controls but tab and line feed, DEL and C1; soft hyphen; zero-width and direction marks;
// bidi embeddings, overrides and isolates; word joiner and invisible operators; BOM; Unicode tags
// (U+E0000-U+E007F, "ASCII smuggling"). Variation selectors stay: emoji need them.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]|\uDB40[\uDC00-\uDC7F]/g;

/** Unicode-clean text: what a person sees, without the characters that hide content from them. */
export function cleanText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(/[\t\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const PARTIAL_MARKER = /\[[A-Z]*$/;
const MARKER_PREFIXES = new Set(Object.values(MASK_MARKERS).flatMap((marker) => [...marker].map((_, index) => marker.slice(0, index + 1))));

/** Clips by code point, never splitting an emoji or leaving half a mask marker at the end. */
export function clipText(text: string, max: number = MAX_UNTRUSTED_CHARS): { readonly text: string; readonly truncated: boolean } {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`invalid clip length ${max}`);
  const points = [...text];
  if (points.length <= max) return { text, truncated: false };
  let clipped = points.slice(0, max).join("");
  const tail = PARTIAL_MARKER.exec(clipped)?.[0];
  if (tail !== undefined && MARKER_PREFIXES.has(tail)) clipped = clipped.slice(0, -tail.length);
  return { text: clipped.trimEnd(), truncated: true };
}

export interface NormalizedText {
  /** Cleaned, masked and clipped: the only form that is persisted, logged or put in an envelope. */
  readonly text: string;
  readonly truncated: boolean;
  /** Kinds that were masked, in masking order (the worker audits them). */
  readonly maskedKinds: readonly MaskKind[];
  readonly maskedCounts: Readonly<Partial<Record<MaskKind, number>>>;
  /** Present when the text must not reach G1 nor the Harness (a card: FL-078 b). */
  readonly block: PrefilterBlock | undefined;
}

/** Steps 1-3 for one untrusted text (a message, a transcript, a caption). */
export function normalizeUntrusted(raw: string, max: number = MAX_UNTRUSTED_CHARS): NormalizedText {
  const masked = maskSensitive(cleanText(raw));
  const clipped = clipText(masked.text, max);
  return { text: clipped.text, truncated: clipped.truncated, maskedKinds: masked.kinds, maskedCounts: masked.counts, block: prefilterBlock(masked) };
}

// ---- Seal ----------------------------------------------------------------------------------------

/** `<`, `>` and `&` as entities: an untrusted text can never open or close a tag of the envelope. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** An attribute value: the markup entities plus the double quote. */
export function escapeAttribute(value: string): string {
  return escapeMarkup(value).replace(/"/g, "&quot;");
}

export const DELIMITER_PREFIX = "inbound-";
export const DELIMITER_PATTERN = /^inbound-[0-9a-f]{6}$/;
const MAX_DRAWS = 64;

export type RandomBytes = (size: number) => Uint8Array;

export interface UntrustedBlockInput {
  readonly kind: UntrustedKind;
  /** Output of `normalizeUntrusted` (the sealer escapes it). */
  readonly text: string;
  readonly truncated: boolean;
  /** Transcribe's average confidence of a voice note, 0-1. */
  readonly confidence?: number;
}

function blockBody(input: UntrustedBlockInput): { readonly attributes: string; readonly content: string } {
  const kind = UntrustedKind.parse(input.kind);
  const confidence = input.confidence === undefined ? "" : ` confidence="${z.number().min(0).max(1).parse(input.confidence).toFixed(2)}"`;
  return { attributes: ` channel="WHATSAPP" kind="${kind}"${confidence} truncated="${input.truncated ? "true" : "false"}"`, content: escapeMarkup(input.text) };
}

/**
 * A block name per turn whose suffix appears in no sealed content, in any case: a text that guesses
 * or copies a delimiter only makes the sealer draw another one.
 */
export function drawDelimiter(sealedContents: readonly string[], random: RandomBytes = randomBytes): string {
  const haystack = sealedContents.join("\n").toLowerCase();
  for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
    const suffix = Buffer.from(random(3)).toString("hex");
    if (suffix.length === 6 && !haystack.includes(suffix)) return `${DELIMITER_PREFIX}${suffix}`;
  }
  throw new Error("no delimiter suffix is absent from the untrusted content");
}

export interface SealedUntrusted {
  /** The block name, declared only in `sessionHeader`. */
  readonly delim: string;
  /** One `<delim …>escaped text</delim>` per input, in order. */
  readonly blocks: readonly string[];
}

/** Step 4 for every untrusted text of one turn: one delimiter, absent from all of them. */
export function untrustedBlocks(inputs: readonly UntrustedBlockInput[], random: RandomBytes = randomBytes): SealedUntrusted {
  const bodies = inputs.map(blockBody);
  const delim = drawDelimiter(bodies.map((body) => body.content), random);
  return { delim, blocks: bodies.map((body) => `<${delim}${body.attributes}>${body.content}</${delim}>`) };
}

/** First line of the envelope: the turn's signed token and the only place the block name is declared. */
export function sessionHeader(sessionToken: string, delim: string): string {
  if (!DELIMITER_PATTERN.test(delim)) throw new RangeError("not a delimiter drawn by the normalizer");
  return `<session token="${escapeAttribute(SessionToken.parse(sessionToken))}" delim="${delim}"/>`;
}
