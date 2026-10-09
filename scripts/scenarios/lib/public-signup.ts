// The own sign-up's public path for `SC-20` (docs/test-plan.md §4.1, ADR-0025 §7): `POST /api/signup.start`
// through the Router, the edge's web ACL and the Bff, exactly as a visitor's browser sends it. The edge
// answers the sign-up with a silent Challenge, so the call is made from a headless Chromium on the real
// `/signup` page: the page loads the AWS WAF integration SDK (lib/waf-token.ts), and the start goes
// through the SDK's own `fetch`, which carries the token. No exception of WAF nor of the limits: the run's
// starts spend the runner's real per-IP room (5 per clock hour) and each QA address is its own person.
//
// Only QA addresses (`success+qa-<runId>-<n>@simulator.amazonses.com`) are started here: their lead is
// `origin QA` by the server's own rule (its notice is suppressed) and the QA seam may confirm them. The
// browser is Playwright's Chromium; CI installs it in the scenarios workflow (never on a laptop). Nothing
// here prints the ticket.
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import { QA_ADDRESS_PATTERN } from "../../../packages/bff/src/leads/keys";

export interface StartForm {
  readonly email: string;
  readonly name?: string;
  readonly locale?: "es-MX" | "en";
  readonly termsAccepted?: boolean;
  readonly contactAccepted?: boolean;
  readonly utm?: Readonly<Record<string, string>>;
}

export interface Started {
  readonly username: string;
  readonly ticket: string;
  readonly expiresAt: string;
}

export type StartAnswer =
  | { readonly ok: true; readonly result: Started }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly reason?: string };

export interface PublicSignup {
  start(form: StartForm): Promise<StartAnswer>;
  close(): Promise<void>;
}

const PAGE_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 20_000;

/** The body of `POST /api/signup.start` (tRPC v11 `httpLink`, no transformer): the form, as the web builds it. */
export function startBody(form: StartForm): string {
  const email = form.email.trim().toLowerCase();
  if (!QA_ADDRESS_PATTERN.test(email)) throw new Error("the public path of SC-20 starts QA addresses only");
  return JSON.stringify({
    email,
    name: form.name ?? "Invitada QA",
    locale: form.locale ?? "es-MX",
    consents: { TERMS_PRIVACY: { accepted: form.termsAccepted ?? true, textVersion: CONSENTS_VERSION }, CONTACT: { accepted: form.contactAccepted ?? false, textVersion: CONSENTS_VERSION } },
    ...(form.utm === undefined ? {} : { attribution: { utm: form.utm } }),
  });
}

/**
 * What the edge and the Bff answered: the procedure's result, the app's refusal (`error.data.reason`,
 * routers/trpc.ts `errorFormatter`), or the edge's own answer (a challenge that was not solved, a block).
 */
export function startAnswerOf(status: number, wafAction: string | null, text: string): StartAnswer {
  const action = (wafAction ?? "").trim().toLowerCase();
  if (action !== "") return { ok: false, status, code: "WAF", reason: action.toUpperCase() };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status, code: "EDGE", reason: `HTTP_${status}` };
  }
  const data = (body as { result?: { data?: Partial<Started> } }).result?.data;
  if (status === 200 && typeof data?.username === "string" && typeof data.ticket === "string" && typeof data.expiresAt === "string") {
    return { ok: true, result: { username: data.username, ticket: data.ticket, expiresAt: data.expiresAt } };
  }
  const error = (body as { error?: { data?: { code?: unknown; reason?: unknown } } }).error?.data;
  const reason = typeof error?.reason === "string" ? error.reason : undefined;
  return { ok: false, status, code: typeof error?.code === "string" ? error.code : `HTTP_${status}`, ...(reason === undefined ? {} : { reason }) };
}

interface PageAnswer {
  readonly status: number;
  readonly wafAction: string | null;
  readonly text: string;
}

/** Opens `/signup` in a headless Chromium and waits for the AWS WAF token the page asks for. */
export async function openPublicSignup(baseUrl: string): Promise<PublicSignup> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "es-MX" });
    await page.goto(`${baseUrl.replace(/\/$/, "")}/signup`, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(() => typeof (globalThis as unknown as { AwsWafIntegration?: unknown }).AwsWafIntegration === "object", undefined, { timeout: PAGE_TIMEOUT_MS });
    await page.evaluate(() => (globalThis as unknown as { AwsWafIntegration: { getToken(): Promise<string> } }).AwsWafIntegration.getToken().then(() => undefined));
    return {
      async start(form) {
        const body = startBody(form);
        const answer = await page.evaluate(
          async ({ request, timeoutMs }): Promise<PageAnswer> => {
            const sdk = (globalThis as unknown as { AwsWafIntegration: { fetch(input: string, init: RequestInit): Promise<Response> } }).AwsWafIntegration;
            const response = await sdk.fetch("/api/signup.start", { method: "POST", headers: { "content-type": "application/json" }, body: request, signal: AbortSignal.timeout(timeoutMs) });
            return { status: response.status, wafAction: response.headers.get("x-amzn-waf-action"), text: await response.text() };
          },
          { request: body, timeoutMs: START_TIMEOUT_MS },
        );
        return startAnswerOf(answer.status, answer.wafAction, answer.text);
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
