// Fixed inputs of the generator and the one way it builds a row (docs/seed-spec.md §1-§2): the seed
// and its clock, deterministic ULIDs and, for every domain entity, the key, GSI attributes and stored
// form the connector's codec computes (connector/codecs.ts), so the seed and the product never
// disagree on where a row lives. What depends on the world epoch is left to the loader.
import { encodeUlid } from "@cuadrilla/shared";
import { encodeRow } from "../../../packages/bff/src/connector/codecs";
import type { EntityName } from "../../../packages/bff/src/domain/common";
import { CHECK_EPOCH, LOADER_STAMPED } from "../lib/conformance";
import type { SeedItem } from "../lib/tables";
import { createRng, seedFor, sha256Hex, type Rng } from "../photos/prng";

/** The product the seed belongs to (docs/seed-spec.md §1): never the SST app's name (ADR-0023). */
export const PRODUCT = "cuadrilla";
export const GENERATOR = "scripts/seed/generate.ts";
export const GENERATOR_VERSION = "1.0.0";

/** The seed's own clock: `generatedAt` of every file and the record metadata of every row. */
export const SEED_CLOCK = "2026-09-26T00:00:00.000Z";

/** Record metadata of a seeded row (docs/architecture.md §5). */
export const SEED_META = { createdAt: SEED_CLOCK, updatedAt: SEED_CLOCK, version: 1, synthetic: true } as const;

/**
 * A domain row: the entity's fields plus metadata, stored at the key and with the GSI attributes its
 * codec computes. Fields stamped by the loader (the world epoch) are computed with a placeholder and
 * then dropped.
 */
export function row(entity: EntityName, fields: Readonly<Record<string, unknown>>): SeedItem {
  const stamped = LOADER_STAMPED[entity] ?? [];
  const withMeta = { entity, ...SEED_META, ...fields };
  const encoded = encodeRow(entity, stamped.includes("worldEpoch") ? { ...withMeta, worldEpoch: CHECK_EPOCH } : withMeta);
  const out: SeedItem = { ...encoded.fields, ...encoded.gsi, ...encoded.key };
  for (const field of stamped) delete out[field];
  return out;
}

/** A deterministic ULID: the instant's milliseconds and 80 bits of the hash of the seed, the instant and the labels. */
export function ulidAt(instant: string, ...labels: ReadonlyArray<string | number>): string {
  const entropy = Buffer.from(sha256Hex(`${seedFor(instant, ...labels)}:${instant}:${labels.join(":")}`), "hex").subarray(0, 10);
  return encodeUlid(Date.parse(instant), new Uint8Array(entropy));
}

/** The random stream of one part of the seed; adding a part never moves the others. */
export function rngFor(...labels: ReadonlyArray<string | number>): Rng {
  return createRng(seedFor("generate", ...labels));
}
