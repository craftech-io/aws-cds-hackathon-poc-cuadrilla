// World templates uploaded by the IaC (ADR-0025 §2, docs/architecture.md §6): every
// `scripts/seed/data/worlds/*.json` (generated and validated by the seed, WP-61) goes to
// `Seed/worlds/<name>.json` with its sha256 as object metadata, like the Transcribe vocabulary of
// infra/media.ts. The world factory (GuestWorlds now, the full factory of WP-39 later) reads the
// template it needs and checks it against the digest of the `WorldTemplates` link, so a template
// changed in the bucket by hand is refused instead of seeding a world. The seed loader no longer
// uploads templates.
//
// The files are read from the repository on every deploy: a template changed in git changes its
// digest, and Pulumi uploads it again.
//
// Verify:
//   aws --profile craftech-demos s3api head-object --bucket <Seed> --key worlds/guest.json   → Metadata.sha256

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { evidenceBucket, mediaBucket, seedBucket } from "./storage";

/** Where the seed writes the templates (docs/seed-spec.md §3). */
export const WORLD_TEMPLATES_DIR = "scripts/seed/data/worlds";
/** Their prefix in the Seed bucket (infra/storage-keys.ts `BUCKET_SPECS.Seed`). */
export const WORLD_TEMPLATES_PREFIX = "worlds/";
/** Every guest world is built from this one. */
export const GUEST_TEMPLATE = "guest";

export interface UploadedTemplate {
  readonly key: string;
  readonly sha256: string;
}

const pascal = (name: string): string => name.replace(/(^|[-_.])([a-z0-9])/g, (_all, _separator: string, char: string) => char.toUpperCase());

function upload(file: string): [string, UploadedTemplate] {
  const name = file.replace(/\.json$/, "");
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`World template "${file}" must be named with lowercase letters, digits and dashes.`);
  const path = `${WORLD_TEMPLATES_DIR}/${file}`;
  const sha256 = createHash("sha256").update(readFileSync(join($cli.paths.root, path))).digest("hex");
  const key = `${WORLD_TEMPLATES_PREFIX}${file}`;
  new aws.s3.BucketObjectv2(`WorldTemplate${pascal(name)}`, {
    bucket: seedBucket.name,
    key,
    source: $asset(path),
    contentType: "application/json; charset=utf-8",
    metadata: { sha256 },
  });
  return [name, { key, sha256 }];
}

const files = readdirSync(join($cli.paths.root, WORLD_TEMPLATES_DIR))
  .filter((file) => file.endsWith(".json"))
  .sort();
if (!files.includes(`${GUEST_TEMPLATE}.json`)) throw new Error(`${WORLD_TEMPLATES_DIR}/${GUEST_TEMPLATE}.json is missing: run npm run seed:generate.`);

export const worldTemplates: Readonly<Record<string, UploadedTemplate>> = Object.fromEntries(files.map(upload));

/**
 * `Resource.WorldTemplates.templates.<name>.{key, sha256}` and the names of the buckets the world factory
 * and its destroyer reach only through fenced grants (`Seed/*` of WORLDS, `Media` and `Evidence` under
 * `guest/`), so those buckets are never linked whole. Grants nothing.
 */
export const WorldTemplates = new sst.Linkable("WorldTemplates", {
  properties: { templates: worldTemplates, buckets: { Seed: seedBucket.name, Media: mediaBucket.name, Evidence: evidenceBucket.name } },
});
