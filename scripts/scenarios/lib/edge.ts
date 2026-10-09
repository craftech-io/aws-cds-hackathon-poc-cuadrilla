// What `SC-00` checks from the runner itself, over HTTP, never through the `QaDriver` (docs/test-plan.md
// §4.5 `SMK/1`, `SMK/3`, `SMK/9`, `SMK/10`): the public pages and their headers, the BFF's health through
// the Router, the sign-up's edge without a token of AWS WAF, and the Bff's Function URL called directly.
// The verdict functions are the interim smoke's and `qa:edge-probes`' (one source each).
import { DEFAULT_BASE_URL, healthVerdict, rootProblems } from "../../smoke/interim";
import { directProbes, routerProbes } from "../../qa/edge-probes";
import { ENTRY_PATHS } from "../../qa/deployed-surfaces";

export interface EdgeConfig {
  readonly baseUrl: string;
  /** The Bff's Function URL (`--bff-url`, or this app's SST state); absent: `SMK/10` is BLOCKED, never passed. */
  readonly bffUrl?: string;
}

let config: EdgeConfig = { baseUrl: DEFAULT_BASE_URL };

export function setEdgeConfig(next: EdgeConfig): void {
  config = next;
}

export function edgeConfig(): EdgeConfig {
  return config;
}

const TIMEOUT_MS = 15_000;
const RETRY_MS = 30_000;

async function fetchOnce(url: string, init: RequestInit = {}): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

/** `SMK/1`: the landing, `/signup`, `/login`, `/join` and the legal pages answer 200; the root with its headers (one retry after 30 s). */
export async function publicPagesProblems(sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))): Promise<string[]> {
  const check = async (): Promise<string[]> => {
    const problems: string[] = [];
    for (const path of ENTRY_PATHS) {
      const answer = await fetchOnce(`${config.baseUrl}${path}`);
      if (path === "/") problems.push(...rootProblems(answer.status, answer.headers));
      else if (answer.status !== 200) problems.push(`GET ${path} answered ${answer.status}`);
    }
    return problems;
  };
  const first = await check().catch((error: unknown) => [String(error)]);
  if (first.length === 0) return [];
  await sleep(RETRY_MS);
  return check().catch((error: unknown) => [String(error)]);
}

/** `SMK/3`: `/api/health.live` through the Router. */
export async function healthProblem(): Promise<string | undefined> {
  const answer = await fetchOnce(`${config.baseUrl}/api/health.live`);
  const verdict = healthVerdict(answer.status, answer.headers["content-type"] ?? "", answer.body);
  return verdict === "ok" ? undefined : `GET /api/health.live: ${verdict} (${answer.status})`;
}

/** `SMK/9`: without a WAF token the sign-up gets the challenge (202), its batch variants the challenge or the app's 400; a reputation 403 is a warning. */
export async function signupEdge(): Promise<{ readonly problems: string[]; readonly warnings: string[] }> {
  const [single, ...batches] = await routerProbes(config.baseUrl);
  const problems: string[] = [];
  const warnings: string[] = [];
  if (single !== undefined && !(single.ok && single.detail.startsWith("202"))) {
    if (single.detail.startsWith("403")) warnings.push(`${single.name}: ${single.detail} (reputation list on the runner's IP)`);
    else problems.push(`${single.name}: ${single.detail}`);
  }
  for (const probe of batches) if (!probe.ok) problems.push(`${probe.name}: ${probe.detail}`);
  return { problems, warnings };
}

/** `SMK/10`: the Bff's Function URL called directly answers 403 without a body to every variant. */
export async function directOriginProblems(): Promise<string[] | undefined> {
  if (config.bffUrl === undefined) return undefined;
  return (await directProbes(config.bffUrl)).filter((probe) => !probe.ok).map((probe) => `${probe.name}: ${probe.detail}`);
}
