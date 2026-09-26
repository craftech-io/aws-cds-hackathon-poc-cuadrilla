// Invariants of the files (docs/seed-spec.md §14): 14 `Runtime` is never seeded; 15 the manifest's
// counts and checksums match the files and the demo template is the world of the table files; 16 no
// item carries a world epoch; 20 every template runs `whatsappMode: simulated` and the overrides
// example declares at most one live world.
import { readFileSync } from "node:fs";
import { SeedOverridesValue } from "../../../packages/bff/src/lib/secret-schemas";
import { entitiesOf } from "../../../packages/bff/src/domain/registry";
import { checkOverridesExample, liveModePaths } from "../../channels/check-modes";
import { DATA_LAYOUT, MANUAL_VERSION, MEDIA_FILES, fromRoot, tableFile, worldFile } from "../lib/paths";
import { Manifest, fingerprint } from "../lib/manifest";
import { SEED_TABLES, WORLD_TABLES, type SeedItem } from "../lib/tables";
import { TEMPLATE_NAMES } from "../lib/worlds";
import { sha256Hex, stableJson } from "../photos/prng";
import type { SeedBundle } from "./bundle";
import { finding, type Invariant } from "./types";

/** Every item of the seed: the table files and the items of the demo and guest templates. */
function allItems(bundle: SeedBundle): Array<{ readonly where: string; readonly item: SeedItem }> {
  const out: Array<{ where: string; item: SeedItem }> = [];
  for (const table of SEED_TABLES) for (const item of bundle.tables[table]) out.push({ where: tableFile(table), item });
  for (const template of [bundle.demo, bundle.guest]) {
    if (template === undefined) continue;
    for (const table of WORLD_TABLES) for (const item of template.tables[table]) out.push({ where: worldFile(template.template), item });
  }
  return out;
}

function noRuntime(bundle: SeedBundle): string[] {
  const runtime = new Set<string>(entitiesOf("Runtime"));
  const errors = [...bundle.files.keys()].filter((path) => path === tableFile("Runtime")).map((path) => `${path} must not exist`);
  for (const { where, item } of allItems(bundle)) if (runtime.has(String(item.entity))) errors.push(`${where}: a ${String(item.entity)} item is Runtime state`);
  return errors;
}

function manifestMatches(bundle: SeedBundle): string[] {
  const text = bundle.files.get(DATA_LAYOUT.manifest);
  if (text === undefined) return [`${DATA_LAYOUT.manifest}: missing`];
  const parsed = Manifest.safeParse(JSON.parse(text));
  if (!parsed.success) return parsed.error.issues.slice(0, 5).map((issue) => `${DATA_LAYOUT.manifest}: ${issue.path.join(".")} ${issue.message}`);
  const manifest = parsed.data;
  const errors: string[] = [];
  const sha = (path: string): string => sha256Hex(bundle.files.get(path) ?? "");
  for (const table of SEED_TABLES) {
    const entry = manifest.tables[table];
    if (entry.count !== bundle.tables[table].length) errors.push(`manifest: ${table} count ${entry.count}, the file has ${bundle.tables[table].length} items`);
    if (entry.sha256 !== sha(tableFile(table))) errors.push(`manifest: checksum of ${tableFile(table)} differs`);
  }
  const manualFiles = Object.fromEntries([...bundle.files].filter(([path]) => path.startsWith(`${DATA_LAYOUT.manual}/`)).map(([path, content]) => [path, sha256Hex(content)]));
  if (manifest.manual.version !== MANUAL_VERSION || manifest.manual.fingerprint !== fingerprint(manualFiles)) errors.push("manifest: the manual fingerprint differs");
  if (manifest.eval.questions.sha256 !== sha(DATA_LAYOUT.questions) || manifest.eval.photos.sha256 !== sha(DATA_LAYOUT.photos)) errors.push("manifest: checksum of the evaluation set differs");
  for (const name of TEMPLATE_NAMES) if (manifest.worlds[name] !== sha(worldFile(name))) errors.push(`manifest: checksum of ${worldFile(name)} differs`);
  const disk = (path: string): string => sha256Hex(readFileSync(fromRoot(path)));
  if (manifest.media.photos.datasheet !== disk(MEDIA_FILES.photoDatasheet) || manifest.media.photos.auxDatasheet !== disk(MEDIA_FILES.auxDatasheet)) errors.push("manifest: the photo datasheets changed after generation");
  if (manifest.media.voices.datasheet !== disk(MEDIA_FILES.audioDatasheet)) errors.push("manifest: the voice datasheet changed after generation");
  if (bundle.demo !== undefined) {
    for (const table of WORLD_TABLES) if (stableJson(bundle.demo.tables[table]) !== stableJson(bundle.tables[table])) errors.push(`demo template: ${table} differs from ${tableFile(table)}`);
  }
  return errors;
}

function noEpoch(bundle: SeedBundle): string[] {
  return allItems(bundle)
    .filter(({ item }) => "worldEpoch" in item)
    .map(({ where, item }) => `${where}: ${String(item.entity)} ${String(item.PK)} carries worldEpoch`);
}

function simulatedOnly(bundle: SeedBundle): string[] {
  const errors: string[] = [];
  for (const name of TEMPLATE_NAMES) {
    const text = bundle.files.get(worldFile(name));
    if (text === undefined) continue;
    const parsed = JSON.parse(text) as unknown;
    if ((parsed as { whatsappMode?: unknown }).whatsappMode !== "simulated") errors.push(`${worldFile(name)}: whatsappMode is not "simulated"`);
    errors.push(...liveModePaths(parsed).map((path) => `${worldFile(name)}: ${path} is not "simulated"`));
  }
  for (const settings of allItems(bundle).filter(({ item }) => item.entity === "IspSettings")) {
    if (settings.item.whatsappMode !== "simulated") errors.push(`${settings.where}: IspSettings.whatsappMode is not "simulated"`);
  }
  const example = readFileSync(fromRoot(MEDIA_FILES.overridesExample), "utf8");
  errors.push(...checkOverridesExample(example));
  const overrides = SeedOverridesValue.safeParse(JSON.parse(example));
  if (!overrides.success) errors.push(`${MEDIA_FILES.overridesExample}: not a valid SeedOverrides value`);
  return errors;
}

export const FILE_INVARIANTS: readonly Invariant[] = [
  { id: 14, title: "Runtime is not seeded", check: (bundle) => finding(noRuntime(bundle)) },
  { id: 15, title: "Manifest counts and checksums; the demo template is the world of the table files", check: (bundle) => finding(manifestMatches(bundle)) },
  { id: 16, title: "No item carries a world epoch", check: (bundle) => finding(noEpoch(bundle)) },
  { id: 20, title: "Every template runs whatsappMode simulated; at most one live world in the overrides example", check: (bundle) => finding(simulatedOnly(bundle)) },
];
