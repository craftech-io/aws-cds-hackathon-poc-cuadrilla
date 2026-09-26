// Builds `manifest.json` from the files of the seed (lib/manifest.ts): what the loader compares to
// decide what changed, and what `seed:validate` checks the files against (invariant 15).
import { readFileSync } from "node:fs";
import { DATA_LAYOUT, MANUAL_VERSION, MEDIA_FILES, fromRoot, tableFile, worldFile } from "../lib/paths";
import { fingerprint, type Manifest } from "../lib/manifest";
import { SEED_TABLES, TableFile } from "../lib/tables";
import { TEMPLATE_NAMES } from "../lib/worlds";
import { SEED, sha256Hex } from "../photos/prng";
import { GENERATOR, GENERATOR_VERSION, PRODUCT, SEED_CLOCK } from "./context";
import type { Media } from "./media";
import { WORLD_START_SIM } from "./time";

function required(files: ReadonlyMap<string, string>, path: string): string {
  const text = files.get(path);
  if (text === undefined) throw new RangeError(`seed file ${path} was not built`);
  return text;
}

export function buildManifest(files: ReadonlyMap<string, string>, media: Media, invariants: readonly number[]): Manifest {
  const tables = Object.fromEntries(
    SEED_TABLES.map((table) => {
      const text = required(files, tableFile(table));
      return [table, { count: TableFile.parse(JSON.parse(text)).count, sha256: sha256Hex(text) }];
    }),
  ) as Manifest["tables"];
  const manualFiles = Object.fromEntries([...files].filter(([path]) => path.startsWith(`${DATA_LAYOUT.manual}/`)).map(([path, text]) => [path, sha256Hex(text)]));
  const questions = required(files, DATA_LAYOUT.questions);
  const photos = required(files, DATA_LAYOUT.photos);
  const disk = (path: string): string => sha256Hex(readFileSync(fromRoot(path)));
  return {
    product: PRODUCT,
    generator: GENERATOR,
    generatorVersion: GENERATOR_VERSION,
    seed: SEED,
    clock: { generatedAt: SEED_CLOCK, worldStartSim: WORLD_START_SIM },
    tables,
    manual: { version: MANUAL_VERSION, sections: Object.keys(manualFiles).filter((path) => path.endsWith(".md")).length, fingerprint: fingerprint(manualFiles), files: manualFiles },
    eval: {
      questions: { count: (JSON.parse(questions) as { questions: unknown[] }).questions.length, sha256: sha256Hex(questions) },
      photos: { count: (JSON.parse(photos) as { photos: unknown[] }).photos.length, sha256: sha256Hex(photos) },
    },
    worlds: Object.fromEntries(TEMPLATE_NAMES.map((name) => [name, sha256Hex(required(files, worldFile(name)))])),
    media: {
      photos: { datasheet: disk(MEDIA_FILES.photoDatasheet), auxDatasheet: disk(MEDIA_FILES.auxDatasheet), set: media.set.length, aux: media.aux.photos.length },
      voices: { datasheet: disk(MEDIA_FILES.audioDatasheet), notes: media.audio.notes.length },
    },
    validation: { passed: true, invariants: [...invariants] },
  };
}
