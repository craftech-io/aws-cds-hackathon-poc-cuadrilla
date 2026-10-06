// `npm run qa:logs-pii -- --since <minutes> [--term <text>]…` (docs/test-plan.md §6.1, row "Lead"; ADR-0026,
// PII): no address of a sign-up reaches the logs of the stage's Lambdas. It searches the log group of
// every function of THIS app (names from its SST state, scripts/qa/inventory.ts) with
// `FilterLogEvents` for the literal terms (by default the mailbox simulator's domain, which every
// address of the verification uses, plus each `--term`, e.g. the run's `qa-<run>` tag) over the last
// minutes. It prints how many events matched per log group, never an event.
//
//   AWS_PROFILE=<stage account> npm run qa:logs-pii -- --since 180 --term qa-wp62a1
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { FilterLogEventsCommand, ResourceNotFoundException } from "@aws-sdk/client-cloudwatch-logs";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { GetFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { parseFlags } from "../channels/cli-args";
import { loadInventory } from "./inventory";

export const DEFAULT_TERMS = ["simulator.amazonses.com"] as const;

/** A CloudWatch filter pattern that matches a literal term (quoted, inner quotes escaped). */
export function literalPattern(term: string): string {
  return `"${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Matches of a term in one log group; `undefined` when the group does not exist (never read as zero). */
export async function countMatches(logs: Pick<CloudWatchLogsClient, "send">, logGroupName: string, term: string, startTime: number): Promise<number | undefined> {
  let total = 0;
  let nextToken: string | undefined;
  try {
    do {
      const page = await logs.send(new FilterLogEventsCommand({ logGroupName, filterPattern: literalPattern(term), startTime, nextToken, limit: 100 }));
      total += page.events?.length ?? 0;
      nextToken = page.nextToken;
    } while (nextToken !== undefined && total < 1_000);
  } catch (error) {
    if (error instanceof ResourceNotFoundException || (error as { name?: string }).name === "ResourceNotFoundException") return undefined;
    throw error;
  }
  return total;
}

/**
 * The log group a function writes to: its `LoggingConfig.LogGroup` (SST names it apart from the
 * function, so `/aws/lambda/<function>` is not it), read with `GetFunctionConfiguration`.
 */
export async function logGroupOf(lambda: Pick<LambdaClient, "send">, functionName: string): Promise<string> {
  const config = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  return config.LoggingConfig?.LogGroup ?? `/aws/lambda/${functionName}`;
}

async function main(): Promise<void> {
  let sinceMinutes = 180;
  const terms: string[] = [...DEFAULT_TERMS];
  parseFlags(process.argv.slice(2), {
    "--since": (value) => {
      sinceMinutes = Number(value());
      if (!Number.isInteger(sinceMinutes) || sinceMinutes < 1 || sinceMinutes > 10_080) throw new RangeError("--since is 1 to 10080 minutes");
    },
    "--term": (value) => {
      const term = value();
      if (term.includes("@")) throw new RangeError("--term is a fragment (a run tag, a domain), never a full address");
      terms.push(term);
    },
  });
  const { CloudWatchLogsClient: Client } = await import("@aws-sdk/client-cloudwatch-logs");
  const { LambdaClient: Lambda } = await import("@aws-sdk/client-lambda");
  const logs = new Client({ region: "us-east-1", maxAttempts: 3 });
  const lambda = new Lambda({ region: "us-east-1", maxAttempts: 3 });
  const inventory = await loadInventory();
  const startTime = Date.now() - sinceMinutes * 60_000;
  let hits = 0;
  let searched = 0;
  const missing: string[] = [];
  for (const fn of inventory.functions) {
    const group = await logGroupOf(lambda, fn);
    let exists = true;
    for (const term of terms) {
      const count = await countMatches(logs, group, term, startTime);
      if (count === undefined) {
        exists = false;
        break;
      }
      if (count > 0) console.error(`  ${group}: ${count} event(s) with term #${terms.indexOf(term) + 1}`);
      hits += count;
    }
    if (exists) searched += 1;
    else missing.push(fn);
  }
  // A function that never ran has no group yet: listed, so a wrong group name can never pass as "0 events".
  for (const fn of missing) console.log(`  no log group yet: ${fn}`);
  console.log(`qa:logs-pii: ${searched} of ${inventory.functions.length} log group(s) × ${terms.length} term(s) over the last ${sinceMinutes} min: ${hits} event(s).`);
  if (hits > 0 || searched === 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`qa:logs-pii: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
