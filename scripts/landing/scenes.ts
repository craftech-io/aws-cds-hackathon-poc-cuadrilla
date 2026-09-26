// What each capture does once its route is open (capture-console.ts): the moment it waits for and what
// a person would do to reach it, nothing else (fill the form, press the button). The route, the world
// and the framing come from captures.json; every scene ends with the view settled: nothing loading,
// nothing busy, the fonts in and the network quiet.
//
// The signup talks to Cognito from the browser; in a capture that call is answered here, in memory,
// with the shapes of Cognito's JSON API (only what the scene reaches: `SignUp`). The visitor's password
// is made for the run and lives only in this process's memory.
import { randomBytes, randomUUID } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { dataCopy } from "../../packages/web/src/copy/console-data";
import { copy as consoleCopy } from "../../packages/web/src/copy/console";
import { type ConsoleWorld, TEST_POOL, VISITOR } from "./console-world";

export interface SceneContext {
  readonly page: Page;
  readonly world: ConsoleWorld;
}

export interface Scene {
  /** Waits for the moment, acts as a person would, and leaves the page on the frame to keep. */
  stage(context: SceneContext): Promise<void>;
}

const SETTLE_TIMEOUT_MS = 20_000;
const LOADING = [dataCopy.loading, consoleCopy.app.loading];

/** Every remote block answered, nothing loading or busy, the fonts in (evaluated in the page). */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  const loading = JSON.stringify(LOADING);
  await page.waitForFunction(
    `document.fonts.status === "loaded" && document.querySelector('[aria-busy="true"]') === null && !${loading}.some((text) => document.body.innerText.includes(text))`,
    undefined,
    { timeout: SETTLE_TIMEOUT_MS },
  );
}

// Where the console keeps its session (packages/web/src/lib/auth/tokens.ts TOKENS_KEY; importing it
// would bring the console's DOM-typed modules into this Node program; captures.test.ts keeps both equal).
export const TOKENS_KEY = "cuadrilla.console.tokens";

/** The world's signer, signed in the way the console keeps a session, before the page loads. */
export async function plantSession(page: Page, world: ConsoleWorld): Promise<void> {
  if (!world.signer) return;
  // The id token is what the BFF verifies; the console never sends the access token in a capture.
  const tokens = JSON.stringify({ idToken: world.idToken(world.signer), accessToken: "capture-only", expiresAt: Date.now() + 3_600_000 });
  await page.addInitScript(`window.sessionStorage.setItem(${JSON.stringify(TOKENS_KEY)}, ${JSON.stringify(tokens)})`);
}

/** Cognito's endpoint for the world's pool (the console calls it from the browser). */
export const COGNITO_ORIGIN = `https://cognito-idp.${TEST_POOL.region}.amazonaws.com`;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-amz-target, x-amz-user-agent",
};

/** Cognito's answer to the calls a scene reaches; anything else is refused as Cognito would. */
export async function answerCognito(route: Route): Promise<void> {
  const request = route.request();
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  const operation = (request.headers()["x-amz-target"] ?? "").replace("AWSCognitoIdentityProviderService.", "");
  const headers = { ...CORS, "content-type": "application/x-amz-json-1.1" };
  if (operation === "SignUp") {
    const body = { UserConfirmed: false, UserSub: randomUUID(), CodeDeliveryDetails: { DeliveryMedium: "EMAIL", AttributeName: "email", Destination: "p***@e***" } };
    return route.fulfill({ status: 200, headers, body: JSON.stringify(body) });
  }
  return route.fulfill({ status: 400, headers, body: JSON.stringify({ __type: "InvalidAction", message: `the capture does not answer ${operation}` }) });
}

/** A password the pool's policy accepts (12+ characters, lower, upper, digit, symbol), new every run. */
function visitorPassword(): string {
  return `Aa1-${randomBytes(18).toString("base64url")}`;
}

// The labels of the signup form and its code step (docs/landing-spec.md §7.3 and §7.4, es-MX and en).
const CREATE_ACCOUNT = /^(Crear cuenta|Create account)$/;
const CHECK_EMAIL = /^(Revisa tu email|Check your email)$/;
const TERMS_CONSENT = /(Términos|Terms)/;

async function fillSignup(page: Page): Promise<void> {
  await page.locator('input[type="email"]').first().fill(VISITOR.email);
  await page.locator('input[type="password"]').first().fill(visitorPassword());
  await page.getByRole("checkbox", { name: TERMS_CONSENT }).check();
}

export const SCENES: Readonly<Record<string, Scene>> = {
  landing: {
    async stage({ page }) {
      await page.getByRole("main").first().waitFor();
      await settle(page);
    },
  },
  "signup-form": {
    async stage({ page }) {
      await page.getByRole("button", { name: CREATE_ACCOUNT }).waitFor();
      await settle(page);
    },
  },
  "signup-code": {
    async stage({ page }) {
      const submit = page.getByRole("button", { name: CREATE_ACCOUNT });
      await submit.waitFor();
      await fillSignup(page);
      // A click waits for the button to be enabled: the consent is ticked and the browser check is done.
      await submit.click({ timeout: SETTLE_TIMEOUT_MS });
      await page.getByRole("heading", { name: CHECK_EMAIL }).waitFor({ timeout: SETTLE_TIMEOUT_MS });
      await settle(page);
    },
  },
  "guest-home": {
    async stage({ page }) {
      await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: SETTLE_TIMEOUT_MS });
      await settle(page);
    },
  },
};
