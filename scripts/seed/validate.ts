// `npm run seed:validate` (docs/seed-spec.md §14): the invariants of the seed on the committed data
// directory and the committed media. Exit 1 on any violated invariant. With `CI=true` an absent
// `FORBIDDEN_TERMS` list fails invariant 11 instead of skipping it; terms are never printed.
//
//   npm run seed:validate
//   npm run seed:validate -- --dir <data dir>     a copy written with `seed:generate -- --out <dir>`
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../channels/cli-args";
import { DATA_DIR, fromRoot } from "./lib/paths";
import { bundleOf, readDataDir } from "./validate/bundle";
import { envFromProcess, failed, report, runInvariants } from "./validate/index";

async function main(): Promise<void> {
  let dir = fromRoot(DATA_DIR);
  parseFlags(process.argv.slice(2), { "--dir": (value) => (dir = resolve(value())) });
  const results = await runInvariants(bundleOf(readDataDir(dir)), envFromProcess());
  console.log(report(results));
  const failures = failed(results);
  if (failures.length > 0) {
    console.error(`seed:validate: ${failures.length} invariant(s) violated.`);
    process.exit(1);
  }
  console.log(`seed:validate: ${results.length} invariant(s) hold.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
