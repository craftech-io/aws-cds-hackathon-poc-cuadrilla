// FL-109 in the browser (docs/test-plan.md §3, level UI): "¿Olvidaste tu contraseña?" on `/login`, with
// the fake Cognito pool as a route. The answer to the request never says whether the email has an
// account (`preventUserExistenceErrors`): a known and an unknown email reach the same screen. The code
// of the (fake) email and a new password that meets the policy change it; the old one stops working
// and the new one signs in. In 390×844 and 1440×900, es-MX and en.
import { type Page, expect, test } from "@playwright/test";
import { loginCopy } from "../src/views/login/copy";
import { loginCopyEn } from "../src/views/login/copy.en";
import { expectReadableScreen } from "./support/a11y";
import { addAccount, createPool, randomPassword } from "./support/accounts";
import { routeCognito } from "./support/cognito";
import { routeConsoleApi } from "./support/console-api";

const lang = () => (test.info().project.use.locale === "en" ? "en" : "es");
const copyOf = () => (lang() === "en" ? loginCopyEn : loginCopy);
const query = () => (lang() === "en" ? "lang=en" : "lang=es-MX");

async function requestReset(page: Page, email: string): Promise<void> {
  const text = copyOf();
  await page.goto(`/login?${query()}`);
  await page.getByRole("button", { name: text.credentials.forgot }).click();
  await expect(page.getByRole("heading", { name: text.forgot.title })).toBeVisible();
  await page.getByLabel(text.credentials.email).fill(email);
  await page.getByRole("button", { name: text.forgot.submit }).click();
}

test.describe("password recovery [FL-109]", () => {
  test("[FL-109] a known and an unknown email read exactly the same", async ({ page }) => {
    const pool = createPool();
    const guest = await addAccount(pool, { role: "GUEST" });
    await routeCognito(page, pool);
    await routeConsoleApi(page);
    const text = copyOf();

    await requestReset(page, guest.email);
    await expect(page.getByRole("heading", { name: text.reset.title })).toBeVisible();
    const known = await page.locator("main").innerText();
    await expectReadableScreen(page);

    await requestReset(page, "nadie-registrado@example.test");
    await expect(page.getByRole("heading", { name: text.reset.title })).toBeVisible();
    const unknown = await page.locator("main").innerText();
    expect(unknown.replace("nadie-registrado@example.test", "EMAIL")).toBe(known.replace(guest.email, "EMAIL"));
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("[FL-109] the emailed code and a new password change it: the old one stops working, the new one signs in", async ({ page }) => {
    const pool = createPool();
    const guest = await addAccount(pool, { role: "GUEST" });
    const cognito = await routeCognito(page, pool);
    await routeConsoleApi(page);
    const text = copyOf();

    await requestReset(page, guest.email);
    await expect(page.getByRole("heading", { name: text.reset.title })).toBeVisible();
    const code = pool.sentResetCode(guest.email) ?? "";
    const wrong = code === "111111" ? "222222" : "111111";
    const chosen = randomPassword();

    await page.getByLabel(text.reset.code).fill(wrong);
    await page.getByLabel(text.newPassword.field).fill(chosen);
    await page.getByLabel(text.password.confirm).fill(chosen);
    await page.getByRole("button", { name: text.reset.submit }).click();
    await expect(page.getByRole("alert")).toHaveText(text.errors.INVALID_CODE);

    await page.getByLabel(text.reset.code).fill(code);
    await page.getByLabel(text.newPassword.field).fill(chosen);
    await page.getByLabel(text.password.confirm).fill(chosen);
    await page.getByRole("button", { name: text.reset.submit }).click();
    await expect(page.getByText(text.credentials.passwordReset)).toBeVisible();

    await page.getByLabel(text.credentials.email).fill(guest.email);
    await page.getByLabel(text.credentials.password, { exact: true }).fill(guest.password);
    await page.getByRole("button", { name: text.credentials.submit }).click();
    await expect(page.getByRole("alert")).toHaveText(text.errors.INVALID_CREDENTIALS);

    await page.getByLabel(text.credentials.password, { exact: true }).fill(chosen);
    await page.getByRole("button", { name: text.credentials.submit }).click();
    await expect(page).toHaveURL(/\/app\/home/);
    expect(cognito.map((call) => call.operation)).toEqual(expect.arrayContaining(["ForgotPassword", "ConfirmForgotPassword"]));
  });

  test("[FL-109] a new password outside the policy is not sent", async ({ page }) => {
    const pool = createPool();
    const guest = await addAccount(pool, { role: "GUEST" });
    const cognito = await routeCognito(page, pool);
    await routeConsoleApi(page);
    const text = copyOf();
    await requestReset(page, guest.email);
    await page.getByLabel(text.reset.code).fill(pool.sentResetCode(guest.email) ?? "");
    await page.getByLabel(text.newPassword.field).fill("weakpassword");
    await page.getByLabel(text.password.confirm).fill("weakpassword");
    await page.getByRole("button", { name: text.reset.submit }).click();
    expect(cognito.map((call) => call.operation)).not.toContain("ConfirmForgotPassword");
  });
});
