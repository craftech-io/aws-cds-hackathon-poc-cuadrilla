// The own sign-up on Vite alone (docs/test-plan.md §3, `signup.spec.ts`): `POST /api/signup.start`
// answered like the BFF would (a ticket and a `gst-<ULID>` user, or a refusal with its `reason`), in
// the single-call tRPC protocol the sign-up's client speaks (`httpLink`, never a batch), and the AWS WAF
// integration SDK of the build's integration URL, as a script that gives a token without any widget
// (or that never loads, as a content blocker would do). Every request is kept for the assertions.
import type { Page } from "@playwright/test";
import { E2E_WAF_INTEGRATION_URL } from "./accounts";

export interface StartRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly wafToken: string | undefined;
}

export interface SignupApi {
  readonly starts: StartRequest[];
  /** The next starts are refused with this `reason` (EMAIL_TAKEN, RATE_LIMITED, CAP_REACHED, EMAIL_DOMAIN). */
  refusal: string | undefined;
}

export const E2E_WAF_TOKEN = "e2e-waf-token";

const HTTP_OF_REASON: Readonly<Record<string, readonly [string, number]>> = {
  EMAIL_TAKEN: ["CONFLICT", 409],
  RATE_LIMITED: ["TOO_MANY_REQUESTS", 429],
  CAP_REACHED: ["TOO_MANY_REQUESTS", 429],
  EMAIL_DOMAIN: ["BAD_REQUEST", 400],
};

/** Crockford ULID bodies in sequence for the users the fake start creates. */
function username(n: number): string {
  return `gst-01K8${String(n).padStart(22, "0")}`;
}

export async function routeSignupStart(page: Page): Promise<SignupApi> {
  const api: SignupApi = { starts: [], refusal: undefined };
  await page.route(
    (url) => url.pathname.startsWith("/api/") && url.pathname.includes("signup."),
    async (route) => {
      const request = route.request();
      api.starts.push({ method: request.method(), url: request.url(), body: request.postData() ?? "", wafToken: request.headers()["x-aws-waf-token"] });
      const refusal = api.refusal;
      if (refusal !== undefined) {
        const [code, httpStatus] = HTTP_OF_REASON[refusal] ?? ["SERVICE_UNAVAILABLE", 503];
        const body = { error: { message: refusal, code: -32_000, data: { code, httpStatus, path: "signup.start", reason: refusal, correlationId: "e2e" } } };
        return route.fulfill({ status: httpStatus, contentType: "application/json", body: JSON.stringify(body) });
      }
      const data = { ticket: `e2e-ticket-${api.starts.length}`, username: username(api.starts.length), expiresAt: new Date(Date.now() + 600_000).toISOString() };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { data } }) });
    },
  );
  return api;
}

// What the SDK's `challenge.js` puts on the page: a token at once and a `fetch` that carries it.
const FAKE_SDK = `window.AwsWafIntegration = {
  getToken: function () { return Promise.resolve(${JSON.stringify(E2E_WAF_TOKEN)}); },
  fetch: function (input, init) {
    var options = Object.assign({}, init || {});
    var headers = new Headers(options.headers || {});
    headers.set("x-aws-waf-token", ${JSON.stringify(E2E_WAF_TOKEN)});
    options.headers = headers;
    return window.fetch(input, options);
  }
};`;

/** The AWS WAF SDK of the integration URL: working, or blocked (the request never gets an answer). */
export async function routeWafSdk(page: Page, mode: "working" | "blocked" = "working"): Promise<void> {
  await page.route(`${E2E_WAF_INTEGRATION_URL}challenge.js`, (route) =>
    mode === "blocked" ? route.abort("blockedbyclient") : route.fulfill({ status: 200, contentType: "application/javascript", body: FAKE_SDK }),
  );
}
