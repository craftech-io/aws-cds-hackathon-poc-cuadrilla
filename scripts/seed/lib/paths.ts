// Where the synthetic seed lives (docs/seed-spec.md §1). Every path is relative to the repository
// root; the layout inside the data directory is the same whether the generator writes the committed
// seed (`scripts/seed/data`) or a scratch copy (`--out <dir>`, the determinism test).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Committed output of `npm run seed:generate`. */
export const DATA_DIR = "scripts/seed/data";

/** Current version of the manual (`manual/v001/`, `MANUALINDEX#v001`, `manualVersion` of every sidecar). */
export const MANUAL_VERSION = "v001";

/** Paths inside a data directory. */
export const DATA_LAYOUT = {
  manual: `manual/${MANUAL_VERSION}`,
  questions: "eval/questions.json",
  photos: "eval/photos.json",
  worlds: "worlds",
  manifest: "manifest.json",
} as const;

/** Inputs the generator reads and the validator checks: the media of WP-18 and their datasheets. */
export const MEDIA_FILES = {
  photoDatasheet: "scripts/seed/photos/datasheet.json",
  auxDatasheet: "scripts/seed/photos/datasheet-aux.json",
  audioDatasheet: "scripts/seed/audio/datasheet.json",
  overridesExample: "scripts/seed/overrides.example.json",
} as const;

export function fromRoot(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}

export function manualFile(sectionId: string): string {
  return `${DATA_LAYOUT.manual}/${sectionId}.md`;
}

export function manualSidecarFile(sectionId: string): string {
  return `${manualFile(sectionId)}.metadata.json`;
}

export function worldFile(template: string): string {
  return `${DATA_LAYOUT.worlds}/${template}.json`;
}

export function tableFile(table: string): string {
  return `${table}.json`;
}
