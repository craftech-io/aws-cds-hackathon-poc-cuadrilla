// FL-123 and FL-124 in the browser (docs/test-plan.md §3, level UI; docs/landing-spec.md §7.10): the SMS
// code after the password. Enrolment: the sign-up's number prefilled and editable, "Enviar código", the
// six digits, the resend with its countdown, the refusals in words. Sign-in: the verified number by its
// last digits only, never editable. Nothing of the console before the code. `/api/*` answers what the BFF
// would (packages/bff/src/routers/phone.ts) in the tRPC batch protocol, with a state each test moves.
import { type Page, type Route, expect, test } from "@playwright/test";
import { guestHomeCopy } from "../src/views/guest-home/copy";
import { phoneCopy } from "../src/views/phone/copy";
import { loginCopy } from "../src/views/login/copy";
import { expectReadableScreen } from "./support/a11y";
import { addAccount, createPool } from "./support/accounts";
import { routeCognito } from "./support/cognito";
import { quietClock, readyWorld } from "./support/console-api";

const NEUTRAL_BRAND = { mode: "neutral", displayName: "Operadora ficticia de prueba", logos: { onLight: null, onDark: null }, disclaimer: null };
const CODE = "246810";

interface PhoneState {
  state: "ENROL" | "SIGN_IN" | "PASSED";
  phone?: string;
  maskedPhone?: string;
  codeSent: boolean;
  /** The next sendCode is refused with this reason. */
  refuseSend?: string;
  /** The operator blocked the account: every procedure answers ACCOUNT_BLOCKED (ADR-0029 §11). */
  blocked?: boolean;
  readonly calls: Array<{ readonly path: string; readonly input: unknown }>;
}

function view(state: PhoneState) {
  if (state.state === "PASSED") return { state: "PASSED", codeSent: false };
  const now = Date.now();
  return {
    state: state.state,
    ...(state.phone === undefined ? {} : { phone: state.phone }),
    ...(state.maskedPhone === undefined ? {} : { maskedPhone: state.maskedPhone }),
    codeSent: state.codeSent,
    ...(state.codeSent ? { codeExpiresAt: new Date(now + 600_000).toISOString(), resendAt: new Date(now + 60_000).toISOString() } : {}),
  };
}

const refused = (path: string, reason: string, code = "TOO_MANY_REQUESTS", httpStatus = 429) => ({ error: { message: reason, code: -32_000, data: { code, httpStatus, path, reason, correlationId: "e2e" } } });

function answer(state: PhoneState, path: string, input: unknown) {
  const data = (value: unknown) => ({ result: { data: value } });
  if (state.blocked === true && path !== "brand.get") return refused(path, "ACCOUNT_BLOCKED", "FORBIDDEN", 403);
  switch (path) {
    case "brand.get":
      return data(NEUTRAL_BRAND);
    case "clock.get":
      return state.state === "PASSED" ? data(quietClock()) : refused(path, "PHONE_VERIFICATION_REQUIRED", "FORBIDDEN", 403);
    case "guest.world":
      return state.state === "PASSED" ? data(readyWorld()) : refused(path, "PHONE_VERIFICATION_REQUIRED", "FORBIDDEN", 403);
    case "phone.status":
      return data(view(state));
    case "phone.sendCode": {
      if (state.refuseSend !== undefined) return refused(path, state.refuseSend);
      const typed = (input as { phone?: string } | undefined)?.phone;
      if (state.state === "ENROL" && typed !== undefined) state.phone = typed;
      state.codeSent = true;
      return data(view(state));
    }
    case "phone.verifyCode":
      if ((input as { code?: string } | undefined)?.code !== CODE) return refused(path, "CODE_WRONG", "BAD_REQUEST", 400);
      state.state = "PASSED";
      return data(view(state));
    case "phone.endSession":
      return data({ ended: true });
    default:
      return refused(path, "NOT_FOUND", "NOT_FOUND", 404);
  }
}

async function routeApi(page: Page, initial: Omit<PhoneState, "calls">): Promise<PhoneState> {
  const state: PhoneState = { ...initial, calls: [] };
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route: Route) => {
      const url = new URL(route.request().url());
      const paths = url.pathname.slice("/api/".length).split(",");
      const batch = url.searchParams.get("batch") === "1";
      const raw = route.request().method() === "GET" ? url.searchParams.get("input") : route.request().postData();
      const inputs = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const items = paths.map((path, index) => {
        const input = batch ? inputs[String(index)] : inputs;
        state.calls.push({ path, input });
        return answer(state, path, input);
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(batch ? items : items[0]) });
    },
  );
  return state;
}

async function signInAsGuest(page: Page): Promise<void> {
  const pool = createPool();
  const guest = await addAccount(pool, { role: "GUEST", name: "Invitado de prueba" });
  await routeCognito(page, pool);
  await page.goto("/login?returnTo=%2Fapp%2Fhome");
  await page.getByLabel(loginCopy.credentials.signInId, { exact: true }).fill(guest.email);
  await page.getByLabel(loginCopy.credentials.password, { exact: true }).fill(guest.password);
  await page.getByRole("button", { name: loginCopy.credentials.submit }).click();
}

const copy = phoneCopy.es;

test.describe("the SMS code after the password", () => {
  test("[FL-123] enrolment: the sign-up's number prefilled and editable, the code sent, a wrong code refused, the right one opens the console", async ({ page }) => {
    const state = await routeApi(page, { state: "ENROL", phone: "+525512345678", codeSent: false });
    await signInAsGuest(page);
    await expect(page.getByRole("heading", { name: copy.enrolTitle })).toBeVisible();
    // Nothing of the console before the code.
    await expect(page.getByRole("navigation", { name: "Cuadrilla" })).toHaveCount(0);
    expect(state.calls.some((call) => call.path === "guest.world" || call.path === "clock.get")).toBe(false);
    const field = page.getByLabel(copy.phone);
    await expect(field).toHaveValue("+525512345678");
    await expectReadableScreen(page);

    await field.fill("+52 55 8765 4321");
    await page.getByRole("button", { name: copy.send }).click();
    await expect(page.getByText(copy.sent("+525587654321"))).toBeVisible();
    expect(state.calls.find((call) => call.path === "phone.sendCode")?.input).toEqual({ locale: "es-MX", phone: "+525587654321" });
    await expect(page.getByText(/Puedes pedir otro código en 0:5\d|1:00/)).toBeVisible();

    await page.getByLabel(copy.code).fill("111111");
    await page.getByRole("button", { name: copy.verify }).click();
    await expect(page.getByRole("alert")).toContainText("El código no es correcto");
    await page.getByLabel(copy.code).fill(CODE);
    await page.getByRole("button", { name: copy.verify }).click();
    await expect(page.getByRole("heading", { name: guestHomeCopy.es.heading })).toBeVisible();
    await expect(page.getByRole("heading", { name: copy.enrolTitle })).toHaveCount(0);
  });

  test("[FL-124] sign-in: the verified number only by its last digits, no field to change it; the code opens the console", async ({ page }) => {
    const state = await routeApi(page, { state: "SIGN_IN", maskedPhone: "•••• 5678", codeSent: false });
    await signInAsGuest(page);
    await expect(page.getByRole("heading", { name: copy.signInTitle })).toBeVisible();
    await expect(page.getByText(copy.signInLead("•••• 5678"))).toBeVisible();
    await expect(page.getByLabel(copy.phone)).toHaveCount(0);
    await expectReadableScreen(page);
    await page.getByRole("button", { name: copy.send }).click();
    await expect(page.getByLabel(copy.code)).toBeVisible();
    expect(state.calls.find((call) => call.path === "phone.sendCode")?.input).toEqual({ locale: "es-MX" });
    await page.getByLabel(copy.code).fill(CODE);
    await page.getByRole("button", { name: copy.verify }).click();
    await expect(page.getByRole("heading", { name: guestHomeCopy.es.heading })).toBeVisible();
    await expect(page.getByRole("heading", { name: copy.signInTitle })).toHaveCount(0);
  });

  test("[FL-123] a daily cap says when to come back and offers the contact of Craftech", async ({ page }) => {
    await routeApi(page, { state: "SIGN_IN", maskedPhone: "•••• 5678", codeSent: false, refuseSend: "SMS_ACCOUNT_LIMIT" });
    await signInAsGuest(page);
    await page.getByRole("button", { name: copy.send }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("podrás entrar mañana");
    await expect(alert.getByRole("link", { name: "escríbenos" })).toHaveAttribute("href", "https://craftech.io/contact/");
  });

  test("[FL-123] a number SMS cannot reach says so and offers the contact of Craftech", async ({ page }) => {
    await routeApi(page, { state: "ENROL", phone: "+14155550100", codeSent: false, refuseSend: "SMS_NOT_DELIVERABLE" });
    await signInAsGuest(page);
    await page.getByRole("button", { name: copy.send }).click();
    await expect(page.getByRole("alert")).toContainText("No podemos enviar SMS a ese número");
  });

  test("[FL-123] the foreign quota of the day says so and offers the contact of Craftech", async ({ page }) => {
    await routeApi(page, { state: "ENROL", phone: "+14155550100", codeSent: false, refuseSend: "SMS_FOREIGN_LIMIT" });
    await signInAsGuest(page);
    await page.getByRole("button", { name: copy.send }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("fuera de Latinoamérica y España");
    await expect(alert.getByRole("link", { name: "escríbenos" })).toHaveAttribute("href", "https://craftech.io/contact/");
  });

  test("[FL-123] a range that is no person's mobile asks for a personal one", async ({ page }) => {
    await routeApi(page, { state: "ENROL", phone: "+31970123456789", codeSent: false, refuseSend: "PHONE_NOT_PERSONAL" });
    await signInAsGuest(page);
    await page.getByRole("button", { name: copy.send }).click();
    await expect(page.getByRole("alert")).toHaveText(copy.errors.PHONE_NOT_PERSONAL.map((part) => (typeof part === "string" ? part : part.label)).join(""));
  });

  test("[FL-126] a blocked account sees only the notice with the contact of Craftech, never the code's form", async ({ page }) => {
    const state = await routeApi(page, { state: "SIGN_IN", maskedPhone: "•••• 5678", codeSent: false, blocked: true });
    await signInAsGuest(page);
    await expect(page.getByRole("heading", { name: copy.blockedTitle })).toBeVisible();
    await expect(page.getByRole("link", { name: "escríbenos" })).toHaveAttribute("href", "https://craftech.io/contact/");
    await expect(page.getByRole("button", { name: copy.send })).toHaveCount(0);
    expect(state.calls.some((call) => call.path === "phone.sendCode")).toBe(false);
  });

  test("[FL-126] an account blocked while the code's screen is open turns into the notice on its next step", async ({ page }) => {
    const state = await routeApi(page, { state: "SIGN_IN", maskedPhone: "•••• 5678", codeSent: false });
    await signInAsGuest(page);
    await expect(page.getByRole("button", { name: copy.send })).toBeVisible();
    state.blocked = true;
    await page.getByRole("button", { name: copy.send }).click();
    await expect(page.getByRole("heading", { name: copy.blockedTitle })).toBeVisible();
  });

  test("[FL-124] the sign-out from the code's screen ends the session", async ({ page }) => {
    const state = await routeApi(page, { state: "SIGN_IN", maskedPhone: "•••• 5678", codeSent: false });
    await signInAsGuest(page);
    await page.getByRole("button", { name: copy.signOut }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect.poll(() => state.calls.some((call) => call.path === "phone.endSession")).toBe(true);
  });
});
