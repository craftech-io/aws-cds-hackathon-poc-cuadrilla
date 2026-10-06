// The output JSON of a Transcribe batch job, read with zod (docs/architecture-integrations.md §5, steps
// 3-4): the text is `results.transcripts[0].transcript`; the confidence is the average `confidence` of
// the `pronunciation` items (punctuation carries none). Transcribe writes numbers as strings. The text
// is masked (CURP, RFC, CLABE, cards, phones) before it leaves this module, so nothing downstream ever
// holds the raw transcript; it is also cut to what a `Message.transcript` holds.
import { z } from "zod";
import { maskSensitive } from "../lib/mask";
import { MAX_TRANSCRIPT_CHARS, MIN_TRANSCRIPT_CONFIDENCE } from "./config";

const Confidence = z.coerce.number().min(0).max(1);

const Item = z.looseObject({
  type: z.string(),
  alternatives: z.array(z.looseObject({ confidence: Confidence.optional(), content: z.string().optional() })).default([]),
});

export const TranscribeOutput = z.looseObject({
  results: z.looseObject({
    transcripts: z.array(z.looseObject({ transcript: z.string() })).default([]),
    items: z.array(Item).default([]),
  }),
});

export interface ReadTranscript {
  /** Masked text, trimmed and cut to `MAX_TRANSCRIPT_CHARS`. */
  readonly text: string;
  /** Average confidence of the pronounced words (4 decimals); 0 when there are none. */
  readonly confidence: number;
  /** Empty text or an average below 0.55 (decided on the unrounded average). */
  readonly unclear: boolean;
  /** Kinds of sensitive data that were masked (the worker audits them; never the values). */
  readonly maskedKinds: readonly string[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Parses the bytes of an output file; throws on anything that is not Transcribe's JSON. */
export function readTranscript(bytes: Uint8Array): ReadTranscript {
  const output = TranscribeOutput.parse(JSON.parse(decoder.decode(bytes)));
  const raw = output.results.transcripts.map((entry) => entry.transcript).join(" ").trim();
  const scores = output.results.items.filter((item) => item.type === "pronunciation").map((item) => item.alternatives[0]?.confidence ?? 0);
  const confidence = scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const masked = maskSensitive(raw);
  // Empty text or a confidence below 0.55: the installer is asked to repeat or write it (FL-018 a). The
  // tolerance keeps the floating-point noise of an average from moving a 0.55 below the threshold.
  const unclear = raw.length === 0 || confidence < MIN_TRANSCRIPT_CONFIDENCE - 1e-9;
  return { text: masked.text.slice(0, MAX_TRANSCRIPT_CHARS), confidence: Math.round(confidence * 10_000) / 10_000, unclear, maskedKinds: masked.kinds };
}
