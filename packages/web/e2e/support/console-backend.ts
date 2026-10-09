/// <reference types="node" />
// The BFF behind the Playwright specs of the field-work views (docs/test-plan.md §2, level UI): the local UI
// server's back half (tests/ui-server/app.ts: the real `appRouter`, the in-memory world seeded from
// scripts/seed/data, the S3 emulator) started inside the spec's worker on a port of its own, one per
// test, with the run's ephemeral key as its only JWKS. The page keeps the origin Vite serves it from:
// its `/api/*` and `/s3/*` requests are routed here, so the presigned links the BFF issues (built on the
// page's origin) work in the browser. Nothing reaches AWS.
import { type Server, createServer } from "node:http";
import type { Page } from "@playwright/test";
import { tsImport } from "tsx/esm/api";
import type { UiApp, createUiApp } from "../../../../tests/ui-server/app";
import type { runJwks } from "../../../../tests/ui-server/main";
import { TOKENS_KEY } from "../../src/lib/auth/tokens";
import { loginCopy } from "../../src/views/login/copy";

/** The audience of the fake user pool's id tokens (src/lib/auth/testing/fake-cognito.ts). */
const FAKE_POOL_AUDIENCE = "fake-client";

export interface ConsoleBackendOptions {
  /** Where the page is served (`baseURL` of the config): the presigned links point there. */
  readonly pageOrigin: string;
  /** The placeholder pool of the Vite build, the issuer of the fake pool's tokens. */
  readonly userPoolId: string;
  readonly clientId: string;
}

export interface ConsoleBackend {
  readonly app: UiApp;
  /** `http://127.0.0.1:<port>` of this backend. */
  readonly url: string;
  /** Routes the page's `/api/*` and `/s3/*` to this backend. */
  attach(page: Page): Promise<void>;
  /** Calls a procedure as the page's user would (the id token it holds), outside the page. */
  call<T = unknown>(path: string, token: string, input?: unknown, method?: "GET" | "POST"): Promise<{ readonly status: number; readonly body: T }>;
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

// The server's sources import JSON the way the bundler and tsx read it (no import attributes), which the
// test runner's own loader refuses: they are loaded through tsx, as `tests/ui-server/main.ts` runs them.
async function serverModules(): Promise<{ readonly createUiApp: typeof createUiApp; readonly runJwks: typeof runJwks }> {
  const [app, main] = await Promise.all([
    tsImport("../../../../tests/ui-server/app.ts", import.meta.url) as Promise<{ readonly createUiApp: typeof createUiApp }>,
    tsImport("../../../../tests/ui-server/main.ts", import.meta.url) as Promise<{ readonly runJwks: typeof runJwks }>,
  ]);
  return { createUiApp: app.createUiApp, runJwks: main.runJwks };
}

export async function startConsoleBackend(options: ConsoleBackendOptions): Promise<ConsoleBackend> {
  const privateKey = process.env.E2E_ID_TOKEN_PRIVATE_KEY;
  if (!privateKey) throw new Error("the run's key is missing: start the specs with the Playwright config");
  const { createUiApp, runJwks } = await serverModules();
  const app = await createUiApp({ origin: options.pageOrigin, pool: { userPoolId: options.userPoolId, clientIds: [options.clientId, FAKE_POOL_AUDIENCE] }, jwks: runJwks(privateKey) });
  const server = createServer((request, response) => {
    app
      .handle(request, response)
      .then((handled) => {
        if (handled) return;
        response.writeHead(404);
        response.end();
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  });
  const url = `http://127.0.0.1:${await listen(server)}`;
  return {
    app,
    url,
    async attach(page) {
      await page.route(
        (target) => target.pathname.startsWith("/api/") || target.pathname.startsWith("/s3/"),
        async (route) => {
          const target = new URL(route.request().url());
          const response = await route.fetch({ url: `${url}${target.pathname}${target.search}` });
          await route.fulfill({ response });
        },
      );
    },
    async call(path, token, input, method = "GET") {
      const query = method === "GET" && input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : "";
      const response = await fetch(`${url}/api/${path}${query}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(input ?? {}) } : {}),
      });
      return { status: response.status, body: (await response.json()) as never };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The console's own sign-in (SRP against the spec's fake pool), from a console path the login sends back to. */
export async function signIn(page: Page, path: string, account: { readonly email: string; readonly password: string }): Promise<void> {
  await page.goto(path);
  await page.getByLabel(loginCopy.credentials.email).fill(account.email);
  await page.getByLabel(loginCopy.credentials.password, { exact: true }).fill(account.password);
  await page.getByRole("button", { name: loginCopy.credentials.submit }).click();
  // Staff are offered the optional TOTP on their first sign-in; the specs of the views skip it.
  const skip = page.getByRole("button", { name: loginCopy.mfaSetup.skip });
  const arrived = (url: URL) => url.pathname === path;
  await Promise.race([skip.waitFor(), page.waitForURL(arrived, { waitUntil: "commit" })]);
  if (await skip.isVisible()) await skip.click();
  await page.waitForURL(arrived, { waitUntil: "commit" });
}

/** The id token the page holds (for a call made outside the page, as that same user). */
export async function idTokenOf(page: Page): Promise<string> {
  const raw = await page.evaluate((key) => sessionStorage.getItem(key), TOKENS_KEY);
  const token = raw === null ? undefined : (JSON.parse(raw) as { idToken?: unknown }).idToken;
  if (typeof token !== "string") throw new Error("the page holds no session");
  return token;
}
