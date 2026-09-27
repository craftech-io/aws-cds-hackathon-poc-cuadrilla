// `npm run seed:photos`: renders the 60 photos of the set, the 40 historical, the 48 seeding and the
// main story's renders with Playwright's Chromium, and writes their datasheets, the scripted validator output and
// the synthetic certificate sample (docs/seed-spec.md §10, §10.1; ADR-0006). The result is committed
// and checked by sha256 (scripts/seed/__tests__/photos.test.ts). No AWS call.
//
//   npm run seed:photos                                   render and write everything
//   npm run seed:photos -- --check                        re-render and compare with the committed files by pixels
//   npm run seed:photos -- --chromium-executable <path>   use that Chromium instead of Playwright's pinned build
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CERTIFICATE_TEMPLATE_SAMPLE_KEY } from "../../../packages/bff/src/copy/templates";
import { parseFlags } from "../../channels/cli-args";
import { ACTA_SAMPLE_FILE, actaSamplePdf } from "./acta-sample";
import { openRenderer, type PhotoRenderer } from "./browser";
import { historicalPhotoSpecs, seedPhotoSpecs, storyPhotoSpecs } from "./catalog-aux";
import { setPhotoSpecs } from "./catalog-set";
import { jpegInfo } from "./jpeg";
import { sha256Hex, stableJson } from "./prng";
import { AuxDatasheet, Datasheet, type Framing, GENERATOR, GENERATOR_VERSION, ORIGIN, PHOTO_FORMAT, type PhotoEntry, PhotoSpec, ScriptedVerdicts } from "./schema";
import { scriptedVerdicts } from "./scripted";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const PHOTOS_DIR = "scripts/seed/photos";
export const DATASHEET_FILE = `${PHOTOS_DIR}/datasheet.json`;
export const AUX_DATASHEET_FILE = `${PHOTOS_DIR}/datasheet-aux.json`;
export const SCRIPTED_FILE = `${PHOTOS_DIR}/scripted-verdicts.json`;
/** Pixel tolerance of `--check` across Chromium builds and operating systems. */
export const PIXEL_TOLERANCE = { meanAbs: 2.5, farShare: 0.02 } as const;

export function photoFile(photoId: string): string {
  return `${PHOTOS_DIR}/out/${photoId}.jpg`;
}

/** Every spec, validated at the edge, with unique ids: set first, then historical, seeding and the story's. */
export function allPhotoSpecs(): PhotoSpec[] {
  const specs = [...setPhotoSpecs(), ...historicalPhotoSpecs(), ...seedPhotoSpecs(), ...storyPhotoSpecs()].map((spec) => PhotoSpec.parse(spec));
  const ids = new Set<string>();
  for (const spec of specs) {
    if (ids.has(spec.photoId)) throw new Error(`duplicate photo id ${spec.photoId}`);
    ids.add(spec.photoId);
  }
  return specs;
}

function entry(spec: PhotoSpec, bytes: Uint8Array, framing: Framing | null): PhotoEntry {
  const info = jpegInfo(bytes);
  if (info.width !== PHOTO_FORMAT.width || info.height !== PHOTO_FORMAT.height) throw new Error(`${spec.photoId}: ${info.width}x${info.height}, expected 1280x960`);
  if (bytes.length > PHOTO_FORMAT.maxBytes) throw new Error(`${spec.photoId}: ${bytes.length} bytes, over the ${PHOTO_FORMAT.maxBytes} limit`);
  if (info.exifOrCommentSegments > 0) throw new Error(`${spec.photoId}: the render carries EXIF, XMP or comment segments`);
  return { ...spec, file: photoFile(spec.photoId), sha256: sha256Hex(bytes), bytes: bytes.length, width: PHOTO_FORMAT.width, height: PHOTO_FORMAT.height, framing, origin: ORIGIN };
}

async function renderAll(renderer: PhotoRenderer, specs: readonly PhotoSpec[]): Promise<Map<string, { bytes: Buffer; framing: Framing | null }>> {
  const rendered = new Map<string, { bytes: Buffer; framing: Framing | null }>();
  for (const spec of specs.filter((s) => s.sameBytesAs === undefined)) {
    rendered.set(spec.photoId, await renderer.render(spec));
  }
  for (const spec of specs.filter((s) => s.sameBytesAs !== undefined)) {
    const source = rendered.get(spec.sameBytesAs ?? "");
    if (source === undefined) throw new Error(`${spec.photoId}: source ${spec.sameBytesAs} was not rendered`);
    rendered.set(spec.photoId, { bytes: source.bytes, framing: null });
  }
  return rendered;
}

/** Byte rules across groups: only ph-adv-04 repeats a photo of the set; no auxiliary render matches any other file. */
export function byteCollisions(entries: readonly PhotoEntry[]): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  for (const photo of entries) {
    const previous = owners.get(photo.sha256);
    if (previous !== undefined && photo.sameBytesAs !== previous) problems.push(`${photo.photoId} has the bytes of ${previous}`);
    if (previous === undefined) owners.set(photo.sha256, photo.photoId);
  }
  return problems;
}

async function check(renderer: PhotoRenderer, specs: readonly PhotoSpec[]): Promise<void> {
  let worst = { photoId: "", meanAbs: 0, farShare: 0 };
  const failures: string[] = [];
  for (const spec of specs.filter((s) => s.sameBytesAs === undefined)) {
    const { bytes } = await renderer.render(spec);
    const committed = readFileSync(join(REPO_ROOT, photoFile(spec.photoId)));
    const diff = await renderer.compare(bytes, committed);
    if (worst.photoId === "" || diff.meanAbs > worst.meanAbs) worst = { photoId: spec.photoId, ...diff };
    if (diff.meanAbs > PIXEL_TOLERANCE.meanAbs || diff.farShare > PIXEL_TOLERANCE.farShare) failures.push(`${spec.photoId}: mean ${diff.meanAbs.toFixed(2)}, far ${(diff.farShare * 100).toFixed(2)} %`);
  }
  console.log(`seed:photos --check: ${specs.length} photo(s); largest mean difference ${worst.meanAbs.toFixed(3)} (${worst.photoId}).`);
  if (failures.length > 0) {
    console.error(`seed:photos --check: ${failures.length} render(s) differ beyond the tolerance:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

function write(relativePath: string, content: string | Uint8Array): void {
  const path = join(REPO_ROOT, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function main(): Promise<void> {
  let executablePath: string | undefined;
  let checkOnly = false;
  parseFlags(process.argv.slice(2), {
    "--chromium-executable": (value) => {
      executablePath = value();
    },
    "--check": () => {
      checkOnly = true;
    },
  });
  const specs = allPhotoSpecs();
  const renderer = await openRenderer(executablePath);
  try {
    if (checkOnly) return await check(renderer, specs);
    const rendered = await renderAll(renderer, specs);
    const entries = specs.map((spec) => {
      const result = rendered.get(spec.photoId);
      if (result === undefined) throw new Error(`${spec.photoId} was not rendered`);
      return entry(spec, result.bytes, result.framing);
    });
    const collisions = byteCollisions(entries);
    if (collisions.length > 0) throw new Error(`byte collisions:\n  ${collisions.join("\n  ")}`);
    const header = {
      generator: GENERATOR,
      generatorVersion: GENERATOR_VERSION,
      seed: 20260926,
      origin: ORIGIN,
      renderer: { engine: "chromium", playwright: renderer.playwrightVersion, browserVersion: renderer.browserVersion },
      format: PHOTO_FORMAT,
    } as const;
    const pdf = actaSamplePdf();
    const datasheet = Datasheet.parse({ ...header, photos: entries.filter((e) => e.group === "set") });
    const aux = AuxDatasheet.parse({
      ...header,
      photos: entries.filter((e) => e.group !== "set"),
      documents: [
        {
          documentId: "acta-muestra",
          file: ACTA_SAMPLE_FILE,
          seedKey: CERTIFICATE_TEMPLATE_SAMPLE_KEY,
          mime: "application/pdf",
          sha256: sha256Hex(pdf),
          bytes: pdf.length,
          generator: "scripts/seed/photos/acta-sample.ts",
          description: "Synthetic sample of the document header of the acta_instalacion template, with no operator name.",
        },
      ],
    });
    for (const photo of entries) write(photo.file, rendered.get(photo.photoId)?.bytes ?? new Uint8Array());
    write(ACTA_SAMPLE_FILE, pdf);
    write(DATASHEET_FILE, stableJson(datasheet));
    write(AUX_DATASHEET_FILE, stableJson(aux));
    write(SCRIPTED_FILE, stableJson(ScriptedVerdicts.parse(scriptedVerdicts(specs))));
    console.log(`seed:photos: ${datasheet.photos.length} photos of the set, ${aux.photos.length} auxiliary renders and 1 document written (Chromium ${renderer.browserVersion}).`);
  } finally {
    await renderer.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
