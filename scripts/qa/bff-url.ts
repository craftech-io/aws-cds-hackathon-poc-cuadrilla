// The Bff's Function URL for the deploy's smoke (`SMK/10`, `--bff-url`), from THIS app's own SST state
// (scripts/qa/inventory.ts). In GitHub Actions it is masked in the log and exported as BFF_URL through
// $GITHUB_ENV; it is never printed in clear.
import { appendFileSync } from "node:fs";
import { loadInventory } from "./inventory";

async function main(): Promise<void> {
  const target = process.env.GITHUB_ENV;
  if (target === undefined || target === "") throw new Error("GITHUB_ENV is not set: this script only runs inside GitHub Actions");
  const { bffUrl } = await loadInventory();
  process.stdout.write(`::add-mask::${bffUrl}\n`);
  appendFileSync(target, `BFF_URL=${bffUrl}\n`);
  process.stdout.write("BFF_URL exported for the smoke\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
