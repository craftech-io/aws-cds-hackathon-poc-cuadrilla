// `scripts/seed/data/manifest.json` (docs/seed-spec.md §1): the fingerprint of the seed. Counts and
// checksums of every table file, of the manual (the loader re-ingests the Knowledge Base only when
// its fingerprint changes), of the evaluation set and the world templates, of the datasheets of the
// photos and voices, and the invariants that passed when it was generated.
import { z } from "zod";
import { IsoInstant } from "@cuadrilla/shared";
import { sha256Hex } from "../photos/prng";
import { SEED_TABLES } from "./tables";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const Counted = z.object({ count: z.int().min(0), sha256: Sha }).strict();

export const Manifest = z
  .object({
    product: z.literal("cuadrilla"),
    generator: z.string().min(1),
    generatorVersion: z.string().min(1),
    seed: z.literal(20260926),
    clock: z.object({ generatedAt: IsoInstant, worldStartSim: IsoInstant }).strict(),
    tables: z.object(Object.fromEntries(SEED_TABLES.map((table) => [table, Counted])) as Record<(typeof SEED_TABLES)[number], typeof Counted>).strict(),
    manual: z.object({ version: z.string(), sections: z.int(), fingerprint: Sha, files: z.record(z.string(), Sha) }).strict(),
    eval: z.object({ questions: Counted, photos: Counted }).strict(),
    worlds: z.record(z.string(), Sha),
    media: z
      .object({
        photos: z.object({ datasheet: Sha, auxDatasheet: Sha, set: z.int(), aux: z.int() }).strict(),
        voices: z.object({ datasheet: Sha, notes: z.int() }).strict(),
      })
      .strict(),
    /** Ids of the invariants of docs/seed-spec.md §14 (1-26) that passed. */
    validation: z.object({ passed: z.literal(true), invariants: z.array(z.int().min(1).max(26)) }).strict(),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;

/** Fingerprint of a set of files: the hash of their sorted `path sha256` lines. */
export function fingerprint(files: Readonly<Record<string, string>>): string {
  return sha256Hex(
    Object.keys(files)
      .sort()
      .map((path) => `${path} ${files[path] ?? ""}`)
      .join("\n"),
  );
}
