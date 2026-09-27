// The auth screens of the deployed stage without spending a sign-up (docs/test-plan.md §6.1; FL-104,
// FL-108, FL-109, FL-115): `/signup` with its two unchecked consents, the legal links and no CAPTCHA
// (never submitted here: a start spends the real per-IP limit); `/login` with a wrong password for an
// address that has no account (the neutral refusal); the recovery request for an address that has no
// account (the same neutral screen a known one reads, compared in signup-flow.spec.ts). In the eight
// projects, with a screenshot of each screen.
import { type Page, expect, test } from "@playwright/test";
import { CONTACT, TERMS_PRIVACY } from "@cuadrilla/shared/legal/consents";
import { loginCopy } from "../../src/views/login/copy";
import { loginCopyEn } from "../../src/views/login/copy.en";
import { signupCopy } from "../../src/views/signup/copy";
import { expectReadableScreen } from "../support/a11y";
import { expectNeutral, newPassword, noHorizontalScroll, projectContext, shot } from "./support";

const loginText = () => (projectContext().lang === "en" ? loginCopyEn : loginCopy);

/**
 * An address with no account: the simulator's, never a real mailbox. A new one per test, since Cognito
 * limits the recovery requests of one user name, known or not ("Too many attempts").
 */
const nobody = () => `success+qa-nobody-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@simulator.amazonses.com`;

async function openLogin(page: Page): Promise<void> {
  await page.goto(`/login?lang=${projectContext().param}`);
  await expect(page.getByRole("heading", { name: loginText().credentials.title })).toBeVisible();
}

test.describe("deployed auth screens @public", () => {
  test("[FL-115] /signup: the form, two unchecked consents with their legal links, no CAPTCHA, create disabled until the required consent", async ({ page }) => {
    const { lang, param } = projectContext();
    const copy = signupCopy[lang];
    await page.goto(`/signup?lang=${param}`);
    await expect(page.getByRole("heading", { name: copy.title })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", param);
    const terms = page.getByRole("checkbox", { name: TERMS_PRIVACY.text[param] });
    const contact = page.getByRole("checkbox", { name: CONTACT.text[param] });
    await expect(terms).not.toBeChecked();
    await expect(contact).not.toBeChecked();
    await page.getByLabel(copy.email, { exact: true }).fill(nobody());
    await page.getByLabel(copy.password, { exact: true }).fill(newPassword());
    const create = page.getByRole("button", { name: copy.submit });
    await expect(create).toBeDisabled();
    await contact.check();
    await expect(create).toBeDisabled();
    await terms.check();
    await expect(create).toBeEnabled({ timeout: 20_000 });
    const consents = page.getByRole("group", { name: copy.consentsLabel });
    await expect(consents.getByRole("link", { name: TERMS_PRIVACY.links[param][0]?.label ?? "" })).toHaveAttribute("href", "/legal/terms.html");
    await expect(consents.getByRole("link", { name: TERMS_PRIVACY.links[param][1]?.label ?? "" })).toHaveAttribute("href", "/legal/privacy.html");
    await expect(page.locator("iframe, [id*=captcha i], [class*=captcha i]")).toHaveCount(0);
    await expectReadableScreen(page);
    await expectNeutral(page, "/signup");
    await noHorizontalScroll(page);
    await shot(page, "signup-form", { fullPage: true });
    // The password never reaches the browser's storage while typed.
    const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
    expect(stored).not.toMatch(/Qa-[A-Za-z0-9_-]{16}!7x/);
  });

  test("[FL-108] /login: the screen, and a wrong password for an address without an account gets the neutral refusal", async ({ page }) => {
    const text = loginText();
    await openLogin(page);
    await expectReadableScreen(page);
    await expectNeutral(page, "/login");
    await noHorizontalScroll(page);
    await shot(page, "login", { fullPage: true });
    await page.getByLabel(text.credentials.email).fill(nobody());
    await page.getByLabel(text.credentials.password, { exact: true }).fill(newPassword());
    await page.getByRole("button", { name: text.credentials.submit }).click();
    await expect(page.getByRole("alert")).toHaveText(text.errors.INVALID_CREDENTIALS);
    await shot(page, "login-invalid-credentials", { fullPage: true });
  });

  test("[FL-109] the recovery request for an address without an account reads the same neutral screen", async ({ page }) => {
    const text = loginText();
    await openLogin(page);
    await page.getByRole("button", { name: text.credentials.forgot }).click();
    await expect(page.getByRole("heading", { name: text.forgot.title })).toBeVisible();
    await expectReadableScreen(page);
    await shot(page, "recovery-request", { fullPage: true });
    const address = nobody();
    await page.getByLabel(text.credentials.email).fill(address);
    await page.getByRole("button", { name: text.forgot.submit }).click();
    await expect(page.getByRole("heading", { name: text.reset.title })).toBeVisible();
    await expect(page.getByText(text.reset.lead(address))).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expectNeutral(page, "/login recovery");
    await shot(page, "recovery-code-step", { fullPage: true });
  });
});
