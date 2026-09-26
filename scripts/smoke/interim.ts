// Interim smoke of a wave (docs/test-plan.md §5, docs/build-plan.md): what CI runs after a deploy
// until the scenario runner's SC-00 exists (WP-45).
//
//   1. GET /               200 with the security headers of the bootstrap policy (CSP, HSTS,
//                          X-Frame-Options DENY, nosniff).
//   2. GET /legal/privacy.html  200 HTML.
//   3. GET /api/health     the BFF's health probe. Before WP-38 deploys the BFF the Router serves
//                          the console's index.html there: reported, not failed, unless
//                          `--expect-api` says the BFF must be up.
//   4. The sign-up's edge (ADR-0025 §3-§4, SMK/9 until SC-00 exists), through the Router without a
//      token of AWS WAF: `POST /api/signup.start` gets the challenge (`x-amzn-waf-action: challenge`),
//      and a batch naming it (`POST /api/health.live,signup.start?batch=1`) the challenge or the
//      app's 400; never a 200 nor RATE_LIMITED. Neither ever reaches `signup.start`: no lead, no
//      counter, no email.
//   5. Inventory (`--aws`): the DynamoDB tables and Lambda functions of the app that exist so far,
//      and (SMK/10) the Bff's Function URL called directly answers 403 with no body, and the two web
//      ACLs are attached (the Router's distribution and the user pool).
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

async function get(url: string, init: RequestInit = {}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
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

export type SignupEdgeVerdict = "challenge" | "rejected" | "failed";

/**
 * What the edge answered to a sign-up request without a WAF token: the challenge of AWS WAF, the
 * app's own 400 without a body (a batch naming `signup.`), or a failure (anything that could have
 * run `signup.start`: a 200, a RATE_LIMITED, another status).
 */
export function signupEdgeVerdict(status: number, headers: HeaderMap, body: string): SignupEdgeVerdict {
  if ((headers["x-amzn-waf-action"] ?? "").toLowerCase() === "challenge") return "challenge";
  if (status === 400 && body.trim() === "") return "rejected";
  return "failed";
}

/** The Bff's Function URL called directly must answer 403 with no body, before parsing anything. */
export function directUrlProblems(status: number, body: string): string[] {
  return status === 403 && body.trim() === "" ? [] : [`POST to the Bff's Function URL answered ${status}${body.trim() === "" ? "" : " with a body"}: expected 403 without a body`];
}

const TABLE_TYPE = "aws:dynamodb/table:Table";
const FUNCTION_TYPE = "aws:lambda/function:Function";
const FUNCTION_URL_TYPE = "aws:lambda/functionUrl:FunctionUrl";
const DISTRIBUTION_TYPE = "aws:cloudfront/distribution:Distribution";
const WEB_ACL_TYPE = "aws:wafv2/webAcl:WebAcl";
const WEB_ACL_ASSOCIATION_TYPE = "aws:wafv2/webAclAssociation:WebAclAssociation";
const USER_POOL_TYPE = "aws:cognito/userPool:UserPool";

export interface EdgeInventory {
  /** Function URLs of the app with AuthType NONE: only the Bff's may exist. */
  readonly publicFunctionUrls: readonly string[];
  readonly problems: readonly string[];
}

type StateResource = { type?: unknown; outputs?: Record<string, unknown> };

/** The public Function URL and whether both web ACLs are attached, from the app's own SST state. */
export function edgeInventory(state: unknown): EdgeInventory {
  const resources = ((state as { latest?: { resources?: unknown } } | null)?.latest?.resources ?? []) as StateResource[];
  const of = (type: string) => resources.filter((resource) => resource.type === type).map((resource) => resource.outputs ?? {});
  const publicFunctionUrls = of(FUNCTION_URL_TYPE)
    .filter((outputs) => outputs.authorizationType === "NONE" && typeof outputs.functionUrl === "string")
    .map((outputs) => outputs.functionUrl as string);
  const acls = new Map(of(WEB_ACL_TYPE).map((outputs) => [String(outputs.name), String(outputs.arn)]));
  const edge = [...acls].find(([name]) => name.endsWith("-edge"))?.[1];
  const auth = [...acls].find(([name]) => name.endsWith("-auth"))?.[1];
  const problems: string[] = [];
  if (publicFunctionUrls.length !== 1) problems.push(`expected exactly one public Function URL (the Bff's), found ${publicFunctionUrls.length}`);
  if (edge === undefined || !of(DISTRIBUTION_TYPE).some((outputs) => outputs.webAclId === edge)) problems.push("the edge web ACL is not on the Router's distribution");
  const pools = of(USER_POOL_TYPE).map((outputs) => outputs.arn);
  if (auth === undefined || !of(WEB_ACL_ASSOCIATION_TYPE).some((outputs) => outputs.webAclArn === auth && pools.includes(outputs.resourceArn))) problems.push("the user pool's web ACL is not associated with the pool");
  return { publicFunctionUrls, problems };
}

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

const POST_EMPTY: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

/** SMK/9 of the interim smoke: the sign-up through the Router, without a token of AWS WAF. */
async function signupEdge(baseUrl: string): Promise<{ line: string; problems: string[] }> {
  const problems: string[] = [];
  const single = await get(`${baseUrl}/api/signup.start`, POST_EMPTY);
  const singleVerdict = signupEdgeVerdict(single.status, single.headers, single.body);
  if (singleVerdict !== "challenge") problems.push(`POST /api/signup.start without a WAF token answered ${single.status}: expected the challenge of AWS WAF`);
  const batch = await get(`${baseUrl}/api/health.live,signup.start?batch=1`, POST_EMPTY);
  const batchVerdict = signupEdgeVerdict(batch.status, batch.headers, batch.body);
  if (batchVerdict === "failed") problems.push(`POST /api/health.live,signup.start?batch=1 answered ${batch.status}: expected the challenge or 400 without a body`);
  return { line: `signup.start ${singleVerdict} · batch ${batchVerdict}`, problems };
}

async function inventory(): Promise<{ lines: string[]; problems: string[] }> {
  const { DynamoDBClient, DescribeTableCommand } = await import("@aws-sdk/client-dynamodb");
  const { LambdaClient, GetFunctionConfigurationCommand } = await import("@aws-sdk/client-lambda");
  const dynamo = new DynamoDBClient({ region: "us-east-1", maxAttempts: 3 });
  const lambda = new LambdaClient({ region: "us-east-1", maxAttempts: 3 });
  const state = await exportState();
  const { tables, functions } = stateInventory(state);
  const edge = edgeInventory(state);
  // Every name comes from this app's state; no prefix check, since SST truncates the app name in
  // function names (64 characters) and they no longer start with it.
  const problems: string[] = [];
  for (const name of tables) {
    const status = (await dynamo.send(new DescribeTableCommand({ TableName: name }))).Table?.TableStatus;
    if (status !== "ACTIVE" && status !== "UPDATING") problems.push(`table ${name} is ${status ?? "missing"}`);
  }
  for (const name of functions) {
    // "Inactive" is an idle function Lambda reactivates on the next invoke; only "Failed" is broken.
    const state = (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }))).State;
    if (state === undefined || state === "Failed") problems.push(`function ${name} is ${state ?? "missing"}`);
  }
  problems.push(...edge.problems);
  // SMK/10: the direct URL skips the Router, so the origin header is missing and the Bff must refuse.
  for (const url of edge.publicFunctionUrls) {
    const direct = await get(`${url.replace(/\/$/, "")}/api/signup.start`, POST_EMPTY);
    problems.push(...directUrlProblems(direct.status, direct.body));
  }
  return { lines: [`tables: ${tables.length}`, `functions: ${functions.length}`, `public Function URLs: ${edge.publicFunctionUrls.length}`], problems };
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
  const signup = await signupEdge(baseUrl);
  problems.push(...signup.problems);
  console.log(`smoke:interim: / ${root.status} · /legal/privacy.html ${legal.status} · /api/health ${verdict} · ${signup.line}`);
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
