// FL-108 in the browser (docs/test-plan.md §3, level UI): a guest of the own sign-up signs in with its
// email (the verified alias of its `gst-*` user) and the password, by SRP, and lands on its portada
// (`/app/home`): no password change, no TOTP, tokens of 15 minutes with the operator of its generation.
// In 390×844 and 1440×900, es-MX and en.
import { expect, test } from "@playwright/test";
import { FAKE_SIGNUP_ISP } from "../src/lib/auth/testing/fake-signup";
import { TOKENS_KEY } from "../src/lib/auth/tokens";
import { guestHomeCopy } from "../src/views/guest-home/copy";
import { loginCopy } from "../src/views/login/copy";
import { loginCopyEn } from "../src/views/login/copy.en";
import { expectReadableScreen } from "./support/a11y";
import { createPool, randomPassword } from "./support/accounts";
import { routeCognito } from "./support/cognito";
import { routeConsoleApi } from "./support/console-api";

const lang = () => (test.info().project.use.locale === "en" ? "en" : "es");

test.describe("a guest of the own sign-up signs in [FL-108]", () => {
  test("[FL-108] with its email and password, by SRP alone, onto its portada", async ({ page }) => {
    const pool = createPool();
    const email = `invitada-${Date.now()}@example.test`;
    const password = randomPassword();
    await pool.addUser({ email, password, role: "GUEST", ispId: FAKE_SIGNUP_ISP, status: "CONFIRMED" });
    const cognito = await routeCognito(page, pool);
    await routeConsoleApi(page);
    const text = lang() === "en" ? loginCopyEn : loginCopy;

    await page.goto(lang() === "en" ? "/login?lang=en" : "/login");
    await page.getByLabel(text.credentials.email).fill(email.toUpperCase());
    await page.getByLabel(text.credentials.password, { exact: true }).fill(password);
    await page.getByRole("button", { name: text.credentials.submit }).click();

    await expect(page).toHaveURL(/\/app\/home/);
    const home = guestHomeCopy[lang()];
    await expect(page.getByRole("heading", { level: 1, name: home.heading })).toBeVisible();
    await expect(page.getByRole("heading", { name: home.ready.title })).toBeVisible();
    await expect(page.getByText(text.mfaSetup.title)).toHaveCount(0);
    await expect(page.getByText(text.newPassword.title)).toHaveCount(0);
    expect(cognito.map((call) => call.operation)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    for (const call of cognito) expect(call.body).not.toContain(password);
    await expectReadableScreen(page);

    const stored = await page.evaluate((key) => sessionStorage.getItem(key), TOKENS_KEY);
    const tokens = JSON.parse(stored ?? "{}") as { idToken: string; expiresAt: number };
    const claims = JSON.parse(Buffer.from(tokens.idToken.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ role: "GUEST", isGuest: "true", ispId: FAKE_SIGNUP_ISP });
    expect(tokens.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  });

  test("[FL-108] /app leads a guest to its portada, and the portada is in the navigation", async ({ page }) => {
    const pool = createPool();
    const email = `invitada-${Date.now()}@example.test`;
    const password = randomPassword();
    await pool.addUser({ email, password, role: "GUEST", ispId: FAKE_SIGNUP_ISP, status: "CONFIRMED" });
    await routeCognito(page, pool);
    await routeConsoleApi(page);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fapp$/);
    await page.getByLabel(loginCopy.credentials.email).fill(email);
    await page.getByLabel(loginCopy.credentials.password, { exact: true }).fill(password);
    await page.getByRole("button", { name: loginCopy.credentials.submit }).click();
    await expect(page).toHaveURL(/\/app\/home$/);
    await expect(page.getByRole("link", { name: "Tu mundo de prueba" }).first()).toHaveAttribute("aria-current", "page");
  });
});
