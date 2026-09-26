// Shape of `scripts/seed/audio/datasheet.json` (docs/seed-spec.md §11): where each voice note comes
// from, its checksum, its measured duration and the transcript the LF Transcribe fake returns.
import { VoiceNoteId } from "@cuadrilla/shared";
import { z } from "zod";

export const VOICES_GENERATOR = "scripts/seed/voices.ts";
export const AUDIO_DATASHEET_FILE = "scripts/seed/audio/datasheet.json";

/** Parameters of `SynthesizeSpeech` (docs/seed-spec.md §11). */
export const POLLY_PARAMS = { engine: "neural", languageCode: "es-MX", outputFormat: "ogg_opus", sampleRate: "48000" } as const;

export const PollySource = z
  .object({
    engine: z.literal(POLLY_PARAMS.engine),
    languageCode: z.literal(POLLY_PARAMS.languageCode),
    voiceId: z.enum(["Mia", "Andres"]),
    outputFormat: z.literal(POLLY_PARAMS.outputFormat),
    sampleRate: z.literal(POLLY_PARAMS.sampleRate),
    textType: z.enum(["text", "ssml"]),
  })
  .strict();

export const CodeSource = z
  .object({
    generator: z.literal("scripts/seed/audio/noise.ts"),
    seed: z.literal(20260926),
    /** sha256 of the PCM before encoding: the part that is reproducible on any machine. */
    pcmSha256: z.string().regex(/^[0-9a-f]{64}$/),
    encoder: z.literal("ffmpeg libopus 32 kb/s, bitexact"),
  })
  .strict();

export const VoiceEntry = z
  .object({
    voiceId: VoiceNoteId,
    file: z.string().regex(/^scripts\/seed\/audio\/vn-\d{2}\.ogg$/),
    mime: z.literal("audio/ogg"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.int().positive(),
    durationSec: z.number().positive(),
    channels: z.literal(1),
    source: z.enum(["polly", "code"]),
    polly: PollySource.nullable(),
    code: CodeSource.nullable(),
    /** Who speaks, as the console shows it ("Andrés"), or `null` for noise. */
    speaker: z.string().nullable(),
    text: z.string(),
    repeat: z.int().min(1),
    /** What the LF Transcribe fake returns for this note. */
    transcript: z.object({ text: z.string(), confidence: z.number().min(0).max(1) }).strict(),
    use: z.string().min(1),
    flows: z.array(z.string().regex(/^FL-\d{3}$/)).min(1),
  })
  .strict();
export type VoiceEntry = z.infer<typeof VoiceEntry>;

export const AudioDatasheet = z
  .object({
    generator: z.literal(VOICES_GENERATOR),
    generatorVersion: z.literal("1.0.0"),
    seed: z.literal(20260926),
    region: z.literal("us-east-1"),
    origin: z.string().min(1),
    notes: z.array(VoiceEntry),
  })
  .strict();
export type AudioDatasheet = z.infer<typeof AudioDatasheet>;
