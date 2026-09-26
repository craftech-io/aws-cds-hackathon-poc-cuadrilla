// FL-110 in the browser (docs/test-plan.md §3, level UI): "Cerrar sesión" from the console and from the
// guest's portada revokes the refresh token at Cognito (`RevokeToken`), clears the browser's tokens and
// leaves the console: `/app/*` asks for a sign-in again and the revoked refresh token never renews the
// session. In 390×844 and 1440×900, es-MX and en.
import { type Page, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console";
import { FAKE_SIGNUP_ISP } from "../src/lib/auth/testing/fake-signup";
import { loginCopy } from "../src/views/login/copy";
import { addAccount, createPool, randomPassword } from "./support/accounts";
import { type CognitoCall, routeCognito } from "./support/cognito";
import { routeConsoleApi } from "./support/console-api";

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(loginCopy.credentials.email).fill(email);
  await page.getByLabel(loginCopy.credentials.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: loginCopy.credentials.submit }).click();
}

async function signOutAndCheck(page: Page, pool: ReturnType<typeof createPool>, cognito: CognitoCall[]): Promise<void> {
  const refreshToken = await page.evaluate(() => (JSON.parse(sessionStorage.getItem("cuadrilla.console.tokens") ?? "{}") as { refreshToken?: string }).refreshToken);
  expect(refreshToken).toBeTruthy();
  await page.getByRole("button", { name: copy.app.signOut }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => cognito.some((call) => call.operation === "RevokeToken")).toBe(true);
  expect(pool.revoked.has(refreshToken ?? "")).toBe(true);
  const stored = await page.evaluate(() => [...Object.keys(sessionStorage), ...Object.keys(localStorage)].filter((key) => key.includes("token")));
  expect(stored).toEqual([]);
  await expect(pool.refresh(refreshToken ?? "")).rejects.toThrow(/revoked/);
  await page.goto("/app/orders");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fapp%2Forders$/);
}

test.describe("sign-out [FL-110]", () => {
  test("[FL-110] a guest of the own sign-up signs out from its portada", async ({ page }) => {
    const pool = createPool();
    const email = `invitada-${Date.now()}@example.test`;
    const password = randomPassword();
    await pool.addUser({ email, password, role: "GUEST", ispId: FAKE_SIGNUP_ISP, status: "CONFIRMED" });
    const cognito = await routeCognito(page, pool);
    await routeConsoleApi(page);
    await signIn(page, email, password);
    await expect(page).toHaveURL(/\/app\/home/);
    await signOutAndCheck(page, pool, cognito);
  });

  test("[FL-110] a supervisor signs out from the console", async ({ page }) => {
    const pool = createPool();
    const supervisor = await addAccount(pool, { role: "SUPERVISOR" });
    const cognito = await routeCognito(page, pool);
    await routeConsoleApi(page);
    await signIn(page, supervisor.email, supervisor.password);
    await page.getByRole("button", { name: loginCopy.mfaSetup.skip }).click();
    await expect(page).toHaveURL(/\/app\/orders$/);
    await signOutAndCheck(page, pool, cognito);
  });
});
