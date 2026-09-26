// `npm run seed:generate` (docs/seed-spec.md §1, §15): the whole synthetic seed from a fixed seed
// (20260926) and fixed inputs: the table files, the manual v001 with its sidecars, the evaluation
// set, the five world templates and the manifest. The same inputs give the same bytes in any process
// on any machine (no `Intl`, no clock, sorted keys). The seed is validated before anything is
// written; a violated invariant writes nothing. Photos and voices are separate steps (`seed:photos`,
// `seed:voices`) whose committed datasheets this one reads.
//
//   npm run seed:generate                      writes scripts/seed/data
//   npm run seed:generate -- --out <dir>       writes a copy elsewhere (the determinism test)
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../channels/cli-args";
import { buildSeed } from "./generate/build";
import { buildManifest } from "./generate/manifest";
import { writeSeed } from "./generate/writer";
import { DATA_DIR, DATA_LAYOUT, fromRoot } from "./lib/paths";
import { stableJson } from "./photos/prng";
import { bundleOf } from "./validate/bundle";
import { MANIFEST_INVARIANT, envFromProcess, failed, report, runInvariants } from "./validate/index";

async function main(): Promise<void> {
  let out = fromRoot(DATA_DIR);
  let quiet = false;
  parseFlags(process.argv.slice(2), { "--out": (value) => (out = resolve(value())), "--quiet": () => (quiet = true) });
  const built = buildSeed();
  const results = await runInvariants(bundleOf(built.files, built.media), envFromProcess(), { skip: [MANIFEST_INVARIANT] });
  const failures = failed(results);
  if (failures.length > 0) {
    console.error(report(results));
    console.error(`seed:generate: ${failures.length} invariant(s) violated; nothing was written.`);
    process.exit(1);
  }
  const files = new Map(built.files);
  files.set(DATA_LAYOUT.manifest, stableJson(buildManifest(built.files, built.media, results.map((result) => result.id))));
  const summary = writeSeed(out, files);
  if (!quiet) console.log(report(results));
  console.log(`seed:generate: ${summary.written} file(s) written to ${out}${summary.removed.length > 0 ? `, ${summary.removed.length} stale file(s) removed` : ""}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
