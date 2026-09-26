// The AWS WAF token of the sign-up (ADR-0025 §4, docs/landing-spec.md §7.3 and §7.5). The edge web
// ACL answers the sign-up with a silent Challenge: a browser proves itself with a token that the AWS
// WAF application integration SDK gets without any widget, and the sign-up's `fetch` carries it. This
// module loads the SDK (`challenge.js` at the integration URL of the ACL, a build variable), waits for
// the token before "Crear cuenta" is enabled, and hands the sign-up client a `fetch` that goes through
// the SDK's own wrapper. No CAPTCHA, ever: if the token does not come within 10 s (a content blocker,
// an extension, the network), the form says so with its own neutral text.
//
// Where no web ACL fronts the app (a local server without an integration URL) there is no token to
// get: the check passes and the plain `fetch` is used; the server side still decides.

/** What the SDK puts on `window.AwsWafIntegration` (AWS WAF application integration, JavaScript). */
export interface WafIntegration {
  getToken(): Promise<string>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface WafTokenDeps {
  /** `VITE_WAF_INTEGRATION_URL`; undefined where no web ACL fronts the app. */
  readonly integrationUrl: string | undefined;
  /** Adds `<script src>` once and settles when it loaded or failed. */
  readonly loadScript: (src: string) => Promise<void>;
  /** The SDK's global once the script ran. */
  readonly integration: () => WafIntegration | undefined;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

/** The token did not come: the form shows its "we couldn't verify your browser" text. */
export class WafTokenError extends Error {
  override readonly name = "WafTokenError";
  readonly code = "BROWSER_CHECK";
}

export interface WafToken {
  /** Settles when the token is at hand (or there is no WAF to satisfy); rejects with WafTokenError. */
  ready(): Promise<void>;
  /** `fetch` with the token, through the SDK's wrapper; waits for `ready()` first. */
  readonly fetch: typeof fetch;
}

export const WAF_TOKEN_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

/** `https://…/<id>/<token>/` → `https://…/<id>/<token>/challenge.js`. */
export function challengeScriptUrl(integrationUrl: string): string {
  return `${integrationUrl.endsWith("/") ? integrationUrl : `${integrationUrl}/`}challenge.js`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createWafToken(deps: WafTokenDeps): WafToken {
  const timeoutMs = deps.timeoutMs ?? WAF_TOKEN_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  let pending: Promise<WafIntegration | undefined> | undefined;

  async function acquire(url: string): Promise<WafIntegration> {
    const deadline = Date.now() + timeoutMs;
    await deps.loadScript(challengeScriptUrl(url));
    let integration = deps.integration();
    while (integration === undefined) {
      if (Date.now() >= deadline) throw new WafTokenError("the AWS WAF integration did not load");
      await sleep(pollMs);
      integration = deps.integration();
    }
    await integration.getToken();
    return integration;
  }

  function withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new WafTokenError("no AWS WAF token in time")), timeoutMs);
    });
    return Promise.race([work, expired]).finally(() => clearTimeout(timer));
  }

  function integration(): Promise<WafIntegration | undefined> {
    const url = deps.integrationUrl;
    if (url === undefined) return Promise.resolve(undefined);
    // One attempt at a time; a failed one can be tried again (the person reloads nothing).
    pending ??= withTimeout(acquire(url)).catch((error: unknown) => {
      pending = undefined;
      throw error instanceof WafTokenError ? error : new WafTokenError(error instanceof Error ? error.message : "the AWS WAF token failed");
    });
    return pending;
  }

  return {
    ready: () => integration().then(() => undefined),
    fetch: async (input, init) => {
      const sdk = await integration();
      return sdk === undefined ? deps.fetch(input, init) : sdk.fetch(input, init);
    },
  };
}

/** The browser's script loader: one `<script async>` per URL, settled by its load or error event. */
export function loadScriptOnce(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-waf-integration][src="${CSS.escape(src)}"]`);
  if (existing?.dataset.loaded === "true") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    });
    script.addEventListener("error", () => {
      script.remove();
      reject(new WafTokenError("the AWS WAF integration could not be loaded"));
    });
    if (existing === null) {
      script.src = src;
      script.async = true;
      script.dataset.wafIntegration = "true";
      document.head.append(script);
    }
  });
}

/** The page's token: the SDK from the build's integration URL, the browser's `fetch`. */
export function browserWafToken(integrationUrl: string | undefined): WafToken {
  return createWafToken({
    integrationUrl,
    loadScript: loadScriptOnce,
    integration: () => (window as unknown as { AwsWafIntegration?: WafIntegration }).AwsWafIntegration,
    fetch: (input, init) => window.fetch(input, init),
  });
}
