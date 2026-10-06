// `npm run qa:edge-probes` (docs/test-plan.md §6.1, rows "Anti abuso" and "Origen"; ADR-0025 §3-§4): the
// probes of the sign-up's edge that need no browser, against the deployed stage.
//
//   1. Through the Router, without a token of AWS WAF: `POST /api/signup.start` gets the challenge;
//      a batch naming it and an encoded path (`/api/%73ignup.start`) get the challenge or the app's 400
//      without a body; never a 200.
//   2. The Bff's Function URL called directly (`/api/signup.start` and `/api/health`): without the
//      origin header, with an invented one, and with a forged `CloudFront-Viewer-Address` → 403
//      without a body. Before and after, the leads (`Leads`, Select COUNT) and the sign-up counters
//      (`Runtime`, `SIGNUP#…`, Select COUNT) are counted: nothing new may appear.
//   3. `SignUp` straight to Cognito, without the ticket of `signup.start`, with each public client →
//      refused by the pre sign-up (`UserLambdaValidationException`); a `gst-*` user name, so it is the
//      trigger and not the pool's web ACL that answers.
//
// Reads only this app's resources (names from its SST state, scripts/qa/inventory.ts); the counts are
// Scans with `Select: COUNT` (no item leaves the table). Prints verdicts, never an item, a token or a
// header value. Exits 1 on any problem.
//
//   AWS_PROFILE=<stage account> npm run qa:edge-probes [-- --base-url https://cuadrilla.demo.craftech.io] [--run <id>]
import { randomBytes, randomInt } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../channels/cli-args";
import { DEFAULT_BASE_URL, directUrlProblems, signupEdgeVerdict } from "../smoke/interim";
import { type StageInventory, loadInventory, tableOf } from "./inventory";

const TIMEOUT_MS = 15_000;

export interface Probe {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function call(url: string, init: RequestInit): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

const POST_EMPTY = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } as const;

export async function routerProbes(baseUrl: string): Promise<Probe[]> {
  const probes: Probe[] = [];
  const single = await call(`${baseUrl}/api/signup.start`, POST_EMPTY);
  const singleVerdict = signupEdgeVerdict(single.status, single.headers, single.body);
  probes.push({ name: "POST /api/signup.start without a WAF token", ok: singleVerdict === "challenge", detail: `${single.status} ${singleVerdict}` });
  for (const path of ["/api/health.live,signup.start?batch=1", "/api/%73ignup.start?batch=1"]) {
    const answer = await call(`${baseUrl}${path}`, POST_EMPTY);
    const verdict = signupEdgeVerdict(answer.status, answer.headers, answer.body);
    probes.push({ name: `POST ${path} without a WAF token`, ok: verdict !== "failed" && answer.status !== 200, detail: `${answer.status} ${verdict}` });
  }
  return probes;
}

/** Variants of a request that skipped the Router: no origin header, an invented one, a forged viewer. */
export const DIRECT_VARIANTS: ReadonlyArray<{ readonly name: string; readonly headers: Readonly<Record<string, string>> }> = [
  { name: "without the origin header", headers: {} },
  { name: "with an invented origin header", headers: { "x-cuadrilla-origin": randomBytes(24).toString("base64url") } },
  { name: "with a forged CloudFront-Viewer-Address", headers: { "cloudfront-viewer-address": "203.0.113.7:443", "x-cuadrilla-origin": randomBytes(24).toString("base64url") } },
];

export async function directProbes(bffUrl: string): Promise<Probe[]> {
  const probes: Probe[] = [];
  for (const path of ["/api/signup.start", "/api/health"]) {
    for (const variant of DIRECT_VARIANTS) {
      const answer = await call(`${bffUrl}${path}`, { ...POST_EMPTY, headers: { ...POST_EMPTY.headers, ...variant.headers } });
      const problems = directUrlProblems(answer.status, answer.body);
      probes.push({ name: `Function URL POST ${path} ${variant.name}`, ok: problems.length === 0, detail: `${answer.status}${answer.body.trim() === "" ? " (no body)" : " (with a body)"}` });
    }
  }
  return probes;
}

async function countItems(inventory: StageInventory): Promise<{ leads: number; counters: number }> {
  const { DynamoDBClient, ScanCommand } = await import("@aws-sdk/client-dynamodb");
  const dynamo = new DynamoDBClient({ region: "us-east-1", maxAttempts: 3 });
  const count = async (TableName: string, filter?: { FilterExpression: string; ExpressionAttributeValues: Record<string, { S: string }> }) => {
    let total = 0;
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await dynamo.send(new ScanCommand({ TableName, Select: "COUNT", ...(filter ?? {}), ...(ExclusiveStartKey ? { ExclusiveStartKey: ExclusiveStartKey as never } : {}) }));
      total += page.Count ?? 0;
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey !== undefined);
    return total;
  };
  return {
    leads: await count(tableOf(inventory, "Leads")),
    counters: await count(tableOf(inventory, "Runtime"), { FilterExpression: "begins_with(PK, :p)", ExpressionAttributeValues: { ":p": { S: "SIGNUP" } } }),
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A fresh `gst-<ULID>` user name, the shape `signup.start` issues. */
export function probeUsername(now: number = Date.now()): string {
  let time = "";
  let rest = now;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }
  let random = "";
  for (let index = 0; index < 16; index += 1) random += CROCKFORD.charAt(randomInt(32));
  return `gst-${time}${random}`;
}

function probePassword(): string {
  return `Qa!${randomBytes(12).toString("base64url")}9z`;
}

/**
 * How Cognito refuses a `SignUp` without a ticket: through `GuestSignup` the pre sign-up answers
 * (`UserLambdaValidationException`); `ConsoleWeb` may not write `email` (ADR-0025 §1, `writeAttributes =
 * ["name"]`), so Cognito refuses it before any trigger runs (`NotAuthorizedException`). No user exists
 * after either.
 */
export function signUpRefused(client: string, type: string): boolean {
  if (type.endsWith("UserLambdaValidationException")) return true;
  return client === "ConsoleWeb" && type.endsWith("NotAuthorizedException");
}

export async function directSignUpProbes(inventory: StageInventory, run: string): Promise<Probe[]> {
  const probes: Probe[] = [];
  for (const client of ["GuestSignup", "ConsoleWeb"]) {
    const clientId = inventory.clients[client];
    if (clientId === undefined) {
      probes.push({ name: `SignUp without a ticket (${client})`, ok: false, detail: "client not in the state" });
      continue;
    }
    const body = {
      ClientId: clientId,
      Username: probeUsername(),
      Password: probePassword(),
      UserAttributes: [{ Name: "email", Value: `success+qa-${run}-noticket@simulator.amazonses.com` }],
    };
    const answer = await call(`https://cognito-idp.us-east-1.amazonaws.com/`, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.SignUp" },
      body: JSON.stringify(body),
    });
    const type = (() => {
      try {
        return String((JSON.parse(answer.body) as { __type?: unknown }).__type ?? "");
      } catch {
        return "";
      }
    })();
    probes.push({ name: `SignUp straight to Cognito without a ticket (${client})`, ok: answer.status === 400 && signUpRefused(client, type), detail: `${answer.status} ${type || "(no type)"}` });
  }
  return probes;
}

async function main(): Promise<void> {
  let baseUrl = DEFAULT_BASE_URL;
  let run = `wp62-${Date.now().toString(36)}`;
  parseFlags(process.argv.slice(2), {
    "--base-url": (value) => {
      baseUrl = value().replace(/\/$/, "");
    },
    "--run": (value) => {
      run = value().toLowerCase();
    },
  });
  const inventory = await loadInventory();
  const before = await countItems(inventory);
  const probes = [...(await routerProbes(baseUrl)), ...(await directProbes(inventory.bffUrl))];
  const after = await countItems(inventory);
  probes.push({ name: "no lead nor sign-up counter written by the probes", ok: after.leads === before.leads && after.counters === before.counters, detail: `leads ${before.leads}→${after.leads}, counters ${before.counters}→${after.counters}` });
  probes.push(...(await directSignUpProbes(inventory, run)));
  for (const probe of probes) console.log(`${probe.ok ? "PASS" : "FAIL"}  ${probe.name}: ${probe.detail}`);
  const failed = probes.filter((probe) => !probe.ok).length;
  console.log(`qa:edge-probes: ${probes.length - failed}/${probes.length} passed`);
  if (failed > 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    console.error(`qa:edge-probes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
