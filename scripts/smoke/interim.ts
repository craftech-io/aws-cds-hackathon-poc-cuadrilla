// Interim smoke of a wave (docs/test-plan.md §5, docs/build-plan.md): what CI runs after a deploy
// until the scenario runner's SC-00 exists (WP-45).
//
//   1. GET /               200 with the security headers of the bootstrap policy (CSP, HSTS,
//                          X-Frame-Options DENY, nosniff).
//   2. GET /legal/privacy.html  200 HTML.
//   3. GET /api/health     the BFF's health probe. Before WP-38 deploys the BFF the Router serves
//                          the console's index.html there: reported, not failed, unless
//                          `--expect-api` says the BFF must be up.
//   4. Inventory (`--aws`): the DynamoDB tables and Lambda functions of the app that exist so far.
//                          Their names come from this app's own SST state (`sst state export`),
//                          never from an account-wide listing: the account is shared with another
//                          project and the deploy role has no `dynamodb:ListTables` nor
//                          `lambda:ListFunctions`. Each one is then described with the credentials
//                          of the environment (the deploy role in CI). The state is parsed in memory
//                          and never printed.
//
//   npx tsx scripts/smoke/interim.ts [--base-url https://cuadrilla.demo.craftech.io] [--expect-api] [--aws]
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../channels/cli-args";

export const DEFAULT_BASE_URL = "https://cuadrilla.demo.craftech.io";
const APP = "aws-cds-hackathon-poc-cuadrilla";
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;
const TIMEOUT_MS = 10_000;

export type HeaderMap = Readonly<Record<string, string | undefined>>;

/** Problems of the console root response; empty when it is served with every security header. */
export function rootProblems(status: number, headers: HeaderMap): string[] {
  const problems: string[] = [];
  if (status !== 200) problems.push(`GET / answered ${status}`);
  const csp = headers["content-security-policy"] ?? "";
  if (!csp.includes("default-src 'self'") || !csp.includes("frame-ancestors 'none'")) problems.push("GET / has no strict Content-Security-Policy");
  if (!(headers["strict-transport-security"] ?? "").includes("max-age=")) problems.push("GET / has no Strict-Transport-Security");
  if ((headers["x-frame-options"] ?? "").toUpperCase() !== "DENY") problems.push("GET / has no X-Frame-Options DENY");
  if ((headers["x-content-type-options"] ?? "").toLowerCase() !== "nosniff") problems.push("GET / has no X-Content-Type-Options nosniff");
  return problems;
}

export type HealthVerdict = "ok" | "not-deployed" | "failed";

/** The tRPC health probe answers JSON `{ result: { data: { ok: true } } }`; HTML means the SPA fallback. */
export function healthVerdict(status: number, contentType: string, body: string): HealthVerdict {
  if (contentType.includes("text/html")) return "not-deployed";
  if (status !== 200 || !contentType.includes("application/json")) return "failed";
  try {
    const parsed: unknown = JSON.parse(body);
    const ok = (parsed as { result?: { data?: { ok?: unknown } } }).result?.data?.ok;
    return ok === true ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

async function get(url: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const body = await response.text();
      // CloudFront may still serve the previous version for a few seconds after a deploy.
      if (response.status < 500 || attempt === ATTEMPTS) return { status: response.status, headers, body };
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, RETRY_DELAY_MS));
  }
  throw new Error(`${url} did not answer after ${ATTEMPTS} attempts`, { cause: lastError });
}

const TABLE_TYPE = "aws:dynamodb/table:Table";
const FUNCTION_TYPE = "aws:lambda/function:Function";

export interface StateInventory {
  readonly tables: readonly string[];
  readonly functions: readonly string[];
}

/** Names of the tables and functions in an `sst state export` document (a Pulumi checkpoint). */
export function stateInventory(state: unknown): StateInventory {
  const resources = (state as { latest?: { resources?: unknown } } | null)?.latest?.resources;
  if (!Array.isArray(resources)) throw new Error("sst state export: no latest.resources in the checkpoint");
  const names = (type: string): string[] =>
    resources
      .filter((resource: { type?: unknown }) => resource.type === type)
      .map((resource: { outputs?: { name?: unknown } }) => resource.outputs?.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0)
      .sort();
  return { tables: names(TABLE_TYPE), functions: names(FUNCTION_TYPE) };
}

async function exportState(): Promise<unknown> {
  const { stdout } = await promisify(execFile)("npx", ["sst", "state", "export", "--stage", "poc"], {
    maxBuffer: 256 * 1024 * 1024,
    timeout: 5 * 60_000,
  });
  return JSON.parse(stdout);
}

async function inventory(): Promise<{ lines: string[]; problems: string[] }> {
  const { DynamoDBClient, DescribeTableCommand } = await import("@aws-sdk/client-dynamodb");
  const { LambdaClient, GetFunctionConfigurationCommand } = await import("@aws-sdk/client-lambda");
  const dynamo = new DynamoDBClient({ region: "us-east-1", maxAttempts: 3 });
  const lambda = new LambdaClient({ region: "us-east-1", maxAttempts: 3 });
  const { tables, functions } = stateInventory(await exportState());
  const problems: string[] = [];
  const outside = [...tables, ...functions].filter((name) => !name.startsWith(`${APP}-`));
  if (outside.length > 0) problems.push(`${outside.length} resource(s) in the state without the ${APP}- prefix`);
  for (const name of tables) {
    const status = (await dynamo.send(new DescribeTableCommand({ TableName: name }))).Table?.TableStatus;
    if (status !== "ACTIVE" && status !== "UPDATING") problems.push(`table ${name} is ${status ?? "missing"}`);
  }
  for (const name of functions) {
    // "Inactive" is an idle function Lambda reactivates on the next invoke; only "Failed" is broken.
    const state = (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }))).State;
    if (state === undefined || state === "Failed") problems.push(`function ${name} is ${state ?? "missing"}`);
  }
  return { lines: [`tables: ${tables.length}`, `functions: ${functions.length}`], problems };
}

async function main(): Promise<void> {
  let baseUrl = DEFAULT_BASE_URL;
  let expectApi = false;
  let aws = false;
  parseFlags(process.argv.slice(2), {
    "--base-url": (value) => {
      baseUrl = value().replace(/\/$/, "");
    },
    "--expect-api": () => {
      expectApi = true;
    },
    "--aws": () => {
      aws = true;
    },
  });
  const problems: string[] = [];
  const root = await get(`${baseUrl}/`);
  problems.push(...rootProblems(root.status, root.headers));
  const legal = await get(`${baseUrl}/legal/privacy.html`);
  if (legal.status !== 200 || !(legal.headers["content-type"] ?? "").includes("text/html")) problems.push(`GET /legal/privacy.html answered ${legal.status}`);
  const health = await get(`${baseUrl}/api/health`);
  const verdict = healthVerdict(health.status, health.headers["content-type"] ?? "", health.body);
  if (verdict === "failed" || (verdict === "not-deployed" && expectApi)) problems.push(`GET /api/health: ${verdict} (${health.status})`);
  console.log(`smoke:interim: / ${root.status} · /legal/privacy.html ${legal.status} · /api/health ${verdict}`);
  if (aws) {
    const found = await inventory();
    console.log(`smoke:interim: ${found.lines.join(" · ")}`);
    problems.push(...found.problems);
  }
  if (problems.length > 0) {
    console.error(`smoke:interim: ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
