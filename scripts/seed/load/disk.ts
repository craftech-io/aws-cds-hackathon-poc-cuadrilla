// The committed seed as `seed:load` reads it (docs/seed-spec.md §1): the manifest (the fingerprint), the
// rows of `Reference`, the manual, the 60 photos of the set and the renders outside it with their
// datasheets, the 12 voice notes, the evaluation set, the synthetic sample of the certificate template's
// document header and the world templates (read for the factory; the IaC uploads them, never the loader).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import { PHOTO_CATALOG_KEY, catalogOfDatasheets, type PhotoCatalog } from "../../../packages/bff/src/worlds/photo-catalog";
import type { WorldTemplateName } from "../../../packages/bff/src/worlds/templates";
import { DATA_DIR, DATA_LAYOUT, MANUAL_VERSION, MEDIA_FILES, fromRoot } from "../lib/paths";

export interface SeedFile {
  /** Key in its bucket. */
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface SeedOnDisk {
  readonly manifest: Uint8Array;
  /** `manual.fingerprint` of the manifest: the Knowledge Base is ingested again only when it changes. */
  readonly manualFingerprint: string;
  readonly reference: ReadonlyArray<Record<string, unknown> & { PK: string; SK: string }>;
  /** `manual/v<nnn>/<sectionId>.md` and its sidecar, for the `Manual` bucket. */
  readonly manual: readonly SeedFile[];
  /** Photos, voices, catalog, evaluation set and the template's sample, for the `Seed` bucket. */
  readonly seedObjects: readonly SeedFile[];
  readonly catalog: PhotoCatalog;
  readonly templates: Readonly<Record<WorldTemplateName, string>>;
}

const Manifest = z.looseObject({ manual: z.looseObject({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }) });
const Rows = z.looseObject({ items: z.array(z.looseObject({ PK: z.string(), SK: z.string() })) });
const Datasheet = z.looseObject({ photos: z.array(z.looseObject({ photoId: z.string(), file: z.string() })) });
const AuxDatasheet = Datasheet.extend({ documents: z.array(z.looseObject({ file: z.string(), seedKey: z.string(), mime: z.string() })).default([]) });
const Voices = z.looseObject({ notes: z.array(z.looseObject({ file: z.string(), mime: z.string() })) });

const bytesOf = (path: string): Uint8Array => new Uint8Array(readFileSync(fromRoot(path)));
const jsonOf = (path: string): unknown => JSON.parse(readFileSync(fromRoot(path), "utf8"));

function manualFiles(): SeedFile[] {
  const dir = `${DATA_DIR}/${DATA_LAYOUT.manual}`;
  return readdirSync(fromRoot(dir))
    .filter((name) => name.endsWith(".md") || name.endsWith(".md.metadata.json"))
    .sort()
    .map((name) => ({ key: `manual/${MANUAL_VERSION}/${name}`, body: bytesOf(`${dir}/${name}`), contentType: name.endsWith(".json") ? "application/json" : "text/markdown; charset=utf-8" }));
}

function voiceId(file: string): string {
  const id = /\/(vn-\d{2})\.ogg$/.exec(file)?.[1];
  if (id === undefined) throw new Error(`unexpected voice note file ${file}`);
  return id;
}

/** Reads every file `seed:load` publishes; throws when the seed was not generated. */
export function readSeedFromDisk(): SeedOnDisk {
  const manifestPath = `${DATA_DIR}/${DATA_LAYOUT.manifest}`;
  if (!existsSync(fromRoot(manifestPath))) throw new Error(`${manifestPath} is missing: run npm run seed:generate`);
  const manifest = bytesOf(manifestPath);
  const { manual } = Manifest.parse(JSON.parse(new TextDecoder().decode(manifest)));
  const set = jsonOf(MEDIA_FILES.photoDatasheet);
  const aux = AuxDatasheet.parse(jsonOf(MEDIA_FILES.auxDatasheet));
  const catalog = catalogOfDatasheets(set, aux);
  const photoFiles = [...Datasheet.parse(set).photos, ...aux.photos].map((photo) => ({ key: `photos/${photo.photoId}.jpg`, body: bytesOf(photo.file), contentType: "image/jpeg" }));
  const voices = Voices.parse(jsonOf(MEDIA_FILES.audioDatasheet)).notes.map((note) => ({ key: `audio/${voiceId(note.file)}.ogg`, body: bytesOf(note.file), contentType: note.mime }));
  const documents = aux.documents.map((document) => ({ key: document.seedKey, body: bytesOf(document.file), contentType: document.mime }));
  const evalFiles = [DATA_LAYOUT.questions, DATA_LAYOUT.photos].map((path) => ({ key: path, body: bytesOf(`${DATA_DIR}/${path}`), contentType: "application/json" }));
  const catalogFile = { key: PHOTO_CATALOG_KEY, body: new TextEncoder().encode(`${JSON.stringify(catalog)}\n`), contentType: "application/json" };
  const template = (name: WorldTemplateName): string => readFileSync(fromRoot(`${DATA_DIR}/${DATA_LAYOUT.worlds}/${name}.json`), "utf8");
  return {
    manifest,
    manualFingerprint: manual.fingerprint,
    reference: Rows.parse(jsonOf(`${DATA_DIR}/Reference.json`)).items,
    manual: manualFiles(),
    seedObjects: [...photoFiles, catalogFile, ...voices, ...evalFiles, ...documents],
    catalog,
    templates: { demo: template("demo"), guest: template("guest"), models: template("models"), "qa-min": template("qa-min"), eval: template("eval") },
  };
}
