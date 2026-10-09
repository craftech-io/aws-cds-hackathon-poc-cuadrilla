// Loads the synthetic seed into the stage (docs/seed-spec.md §15). Runs inside `sst shell --stage poc`
// (the package script), so every table, bucket, secret, the Knowledge Base and the Memory come from the
// linked resources; idempotent by fingerprint. CI runs it after every deploy; the operator runs it with
// the logos of the design partner, from local paths outside the repository.
//
//   npm run seed:load                                   loads when the fingerprint changed
//   npm run seed:load -- --force                        loads anyway (the demo world is reset: epoch + 1)
//   npm run seed:load -- --stage poc --brand-logo-on-light <path> --brand-logo-on-dark <path>
//
// What it writes and in which order: scripts/seed/load/run.ts. Nothing it prints carries a phone, an
// email or a secret.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLoadArgs } from "./load/args";
import { readSeedFromDisk } from "./load/disk";
import { runLoad } from "./load/run";

async function main(): Promise<void> {
  const args = parseLoadArgs(process.argv.slice(2));
  const seed = readSeedFromDisk();
  const report = (line: string): void => void process.stdout.write(`seed:load: ${line}\n`);
  const { stagePorts } = await import("./load/stage");
  const result = await runLoad(seed, args, stagePorts(seed, report));
  report(result.skipped ? "nothing new to load" : `done (fingerprint ${result.fingerprint.slice(0, 12)})`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`seed:load: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}
