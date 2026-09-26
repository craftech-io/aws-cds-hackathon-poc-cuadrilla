// Interim smoke of a wave (docs/test-plan.md §5, docs/build-plan.md): what CI runs after a deploy
// until the scenario runner's SC-00 exists (WP-45).
//
//   1. GET /               200 with the security headers of the bootstrap policy (CSP, HSTS,
//                          X-Frame-Options DENY, nosniff).
//   2. GET /legal/privacy.html  200 HTML.
//   3. GET /api/health     the BFF's health probe. Before WP-38 deploys the BFF the Router serves
//                          the console's index.html there: reported, not failed, unless
//                          `--expect-api` says the BFF must be up.
//   4. Inventory (`--aws`): the DynamoDB tables and Lambda functions of the app that exist so far,
//                          read with the credentials of the environment (the deploy role in CI).
//
//   npx tsx scripts/smoke/interim.ts [--base-url https://cuadrilla.demo.craftech.io] [--expect-api] [--aws]
import { resolve } from "node:path";
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

async function inventory(): Promise<string[]> {
  const { DynamoDBClient, ListTablesCommand } = await import("@aws-sdk/client-dynamodb");
  const { LambdaClient, ListFunctionsCommand } = await import("@aws-sdk/client-lambda");
  const dynamo = new DynamoDBClient({ region: "us-east-1", maxAttempts: 3 });
  const lambda = new LambdaClient({ region: "us-east-1", maxAttempts: 3 });
  const tables: string[] = [];
  let startTable: string | undefined;
  do {
    const page = await dynamo.send(new ListTablesCommand({ ExclusiveStartTableName: startTable }));
    tables.push(...(page.TableNames ?? []).filter((name) => name.startsWith(`${APP}-`)));
    startTable = page.LastEvaluatedTableName;
  } while (startTable);
  const functions: string[] = [];
  let marker: string | undefined;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
    // Only this app's functions: the account is shared with another project of the same hackathon.
    functions.push(...(page.Functions ?? []).map((fn) => fn.FunctionName ?? "").filter((name) => name.startsWith(`${APP}-`)));
    marker = page.NextMarker;
  } while (marker);
  return [`tables: ${tables.length}`, `functions: ${functions.length}`];
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
  if (aws) console.log(`smoke:interim: ${(await inventory()).join(" · ")}`);
  if (problems.length > 0) {
    console.error(`smoke:interim: ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
