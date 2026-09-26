// `npm run landing:check` (docs/landing-spec.md §6, docs/build-plan.md WP-60): the landing's media
// manifest (packages/web/public/landing/manifest.json) against the capture ledger
// (scripts/landing/captures.json) and the files under packages/web/public:
//
//   - the manifest reads with the page's own schema (views/landing/media.ts)
//   - every `render` names the capture that replaces it: routes, viewports, the state of the world and
//     the work package that takes it
//   - every `placeholder` has its replacement date
//   - every file of a `capture` (the picture and each source of its srcsets) is under public/, is in
//     the ledger, and has the hash the ledger recorded; the entry's `sha256` is its picture's
//   - every capture of the ledger that feeds the manifest names an entry that exists
//
// Exits 1 with one line per problem; it reads files only.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LandingManifest } from "../../packages/web/src/views/landing/media";
import { CapturesFile, hashUnder, srcsetPaths } from "./captures";

const ROOT = resolve(import.meta.dirname, "../..");
export const MANIFEST_FILE = join(ROOT, "packages/web/public/landing/manifest.json");
export const CAPTURES_FILE = join(ROOT, "scripts/landing/captures.json");
export const PUBLIC_DIR = join(ROOT, "packages/web/public");

export interface CheckInput {
  /** The manifest as JSON, before any schema. */
  readonly manifest: unknown;
  readonly captures: CapturesFile;
  /** Hash of a file under public/ by its public path; `undefined` when it does not exist. */
  readonly fileHash: (path: string) => string | undefined;
}

type RawEntry = Readonly<Record<string, unknown>>;

function rawEntries(manifest: unknown): Array<[string, RawEntry]> {
  const media = (manifest as { media?: unknown } | null)?.media;
  if (media === null || typeof media !== "object") return [];
  return Object.entries(media as Record<string, unknown>).filter((entry): entry is [string, RawEntry] => entry[1] !== null && typeof entry[1] === "object");
}

/** What the schema would say, by entry and in words: a placeholder without its date, a render without its replacement. */
function entryShapeProblems(manifest: unknown): string[] {
  const problems: string[] = [];
  for (const [id, entry] of rawEntries(manifest)) {
    if (entry.status === "placeholder" && typeof entry.replaceBy !== "string") problems.push(`${id}: a placeholder without its replacement date (replaceBy)`);
    const replacement = entry.replacement as { routes?: unknown; viewports?: unknown; worldState?: unknown; by?: unknown } | undefined;
    const complete = replacement !== undefined && Array.isArray(replacement.routes) && replacement.routes.length > 0 && Array.isArray(replacement.viewports) && replacement.viewports.length > 0 && typeof replacement.worldState === "string" && replacement.worldState.trim() !== "" && typeof replacement.by === "string";
    if (!complete) problems.push(`${id}: no complete replacement (routes, viewports, world state and the work package that captures it)`);
  }
  return problems;
}

export function checkManifest(input: CheckInput): string[] {
  const problems = entryShapeProblems(input.manifest);
  const parsed = LandingManifest.safeParse(input.manifest);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `manifest ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return [...problems, ...issues];
  }
  const recorded = new Map<string, string>();
  for (const picture of Object.values(input.captures.images)) for (const [path, hash] of Object.entries(picture.files)) recorded.set(path, hash);

  for (const [id, item] of Object.entries(parsed.data.media)) {
    if (item.status !== "capture") continue;
    const paths = [item.file, ...item.sources.flatMap((source) => srcsetPaths(source.srcset))];
    for (const path of new Set(paths)) {
      const hash = input.fileHash(path);
      if (hash === undefined) problems.push(`${id}: ${path} is not under public/`);
      else if (!recorded.has(path)) problems.push(`${id}: ${path} is not in the capture ledger (scripts/landing/captures.json)`);
      else if (recorded.get(path) !== hash) problems.push(`${id}: ${path} does not have the hash the ledger recorded`);
    }
    const pictureHash = input.fileHash(item.file);
    if (item.sha256 !== undefined && pictureHash !== undefined && pictureHash !== item.sha256) problems.push(`${id}: sha256 is not the hash of ${item.file}`);
  }
  for (const [captureId, spec] of Object.entries(input.captures.captures)) {
    if (spec.manifest && parsed.data.media[spec.manifest.id] === undefined) problems.push(`capture ${captureId}: the manifest has no entry ${spec.manifest.id}`);
  }
  return problems;
}

function main(): void {
  const captures = CapturesFile.parse(JSON.parse(readFileSync(CAPTURES_FILE, "utf8")));
  const manifest: unknown = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  const problems = checkManifest({ manifest, captures, fileHash: hashUnder(PUBLIC_DIR) });
  if (problems.length > 0) {
    console.error(`landing:check: ${problems.length} problem(s) in the landing's media manifest:`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const counts = LandingManifest.parse(manifest).media;
  const byStatus = Object.values(counts).reduce<Record<string, number>>((total, item) => ({ ...total, [item.status]: (total[item.status] ?? 0) + 1 }), {});
  console.log(`landing:check: ${Object.keys(counts).length} entries (${Object.entries(byStatus).map(([status, count]) => `${count} ${status}`).join(", ")}), every file with its hash.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
