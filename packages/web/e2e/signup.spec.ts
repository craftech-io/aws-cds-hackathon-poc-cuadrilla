// FL-104, FL-105, FL-106, FL-113, FL-114, FL-115 and FL-121 in the browser (docs/test-plan.md §3, level
// UI; docs/landing-spec.md §7.3-§7.5): the own sign-up on Vite, with the fake Cognito pool (its sign-up
// side included) as a route, `POST /api/signup.start` answered like the BFF, and the AWS WAF SDK as a
// script that gives a token without any widget. In 390×844 and 1440×900, es-MX and en.
import { type Page, expect, test } from "@playwright/test";
import { CONTACT, TERMS_PRIVACY } from "@cuadrilla/shared/legal/consents";
import { FakeSignupPool } from "../src/lib/auth/testing/fake-signup";
import { guestHomeCopy } from "../src/views/guest-home/copy";
import { loginCopy } from "../src/views/login/copy";
import { loginCopyEn } from "../src/views/login/copy.en";
import { CONTACT_URL, signupCopy } from "../src/views/signup/copy";
import { expectReadableScreen } from "./support/a11y";
import { createPool, randomPassword } from "./support/accounts";
import { type CognitoCall, routeCognito } from "./support/cognito";
import { routeConsoleApi } from "./support/console-api";
import { E2E_WAF_TOKEN, type SignupApi, routeSignupStart, routeWafSdk } from "./support/signup-api";

type Lang = "es" | "en";

function langOf(): Lang {
  return test.info().project.use.locale === "en" ? "en" : "es";
}

const LOCALE = { es: "es-MX", en: "en" } as const;

interface Kit {
  readonly pool: ReturnType<typeof createPool>;
  readonly signup: FakeSignupPool;
  readonly cognito: CognitoCall[];
  readonly api: SignupApi;
}

async function openSignup(page: Page, options: { readonly waf?: "working" | "blocked" } = {}): Promise<Kit> {
  const pool = createPool();
  const signup = new FakeSignupPool(pool);
  const cognito = await routeCognito(page, pool, signup);
  await routeConsoleApi(page);
  const api = await routeSignupStart(page);
  await routeWafSdk(page, options.waf ?? "working");
  await page.goto(`/signup?lang=${LOCALE[langOf()]}`);
  return { pool, signup, cognito, api };
}

const copyOf = () => signupCopy[langOf()];
const terms = (page: Page) => page.getByRole("checkbox", { name: TERMS_PRIVACY.text[LOCALE[langOf()]] });
const contact = (page: Page) => page.getByRole("checkbox", { name: CONTACT.text[LOCALE[langOf()]] });
const createButton = (page: Page) => page.getByRole("button", { name: copyOf().submit });

async function fillForm(page: Page, email: string, password: string): Promise<void> {
  const copy = copyOf();
  await page.getByLabel(copy.email, { exact: true }).fill(email);
  await page.getByLabel(copy.password, { exact: true }).fill(password);
  await page.getByLabel(copy.name).fill("Ana Prueba");
  await page.getByLabel(copy.company).fill("Fibra de Prueba");
}

const newEmail = () => `ana-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

test.describe("own sign-up", () => {
  test("[FL-115] two consents, unchecked, with the texts of their single source; no account without the required one", async ({ page }) => {
    const { api } = await openSignup(page);
    const copy = copyOf();
    await expect(page.getByRole("heading", { name: copy.title })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", LOCALE[langOf()]);
    await expect(terms(page)).not.toBeChecked();
    await expect(contact(page)).not.toBeChecked();
    await fillForm(page, newEmail(), randomPassword());
    await expect(createButton(page)).toBeDisabled();
    await contact(page).check();
    await expect(createButton(page)).toBeDisabled();
    await terms(page).check();
    await expect(createButton(page)).toBeEnabled();
    // The legal pages open from the checkbox's own text.
    const consents = page.getByRole("group", { name: copy.consentsLabel });
    await expect(consents.getByRole("link", { name: TERMS_PRIVACY.links[LOCALE[langOf()]][0]?.label ?? "" })).toHaveAttribute("href", "/legal/terms.html");
    await expect(consents.getByRole("link", { name: TERMS_PRIVACY.links[LOCALE[langOf()]][1]?.label ?? "" })).toHaveAttribute("href", "/legal/privacy.html");
    await expect(page.getByText(copy.note)).toBeVisible();
    await expect(page.locator("iframe, [id*=captcha i], [class*=captcha i]")).toHaveCount(0);
    await expectReadableScreen(page);
    expect(api.starts).toEqual([]);
    const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(width).toBeLessThanOrEqual(0);
  });

  test("[FL-104] a password outside the pool's policy is refused before any start", async ({ page }) => {
    const { api, signup } = await openSignup(page);
    await fillForm(page, newEmail(), "weakpassword");
    await terms(page).check();
    await createButton(page).click();
    await expect(page.getByRole("alert")).toHaveText(copyOf().errors({ login: "", forgot: "" }).WEAK_PASSWORD.join(""));
    expect(api.starts).toEqual([]);
    expect(signup.calls).toEqual([]);
  });

  test("[FL-104] [FL-105] [FL-106] start, code, resend and the automatic sign-in to the portada, without the password anywhere but Cognito", async ({ page }) => {
    const { api, signup, cognito } = await openSignup(page);
    const email = newEmail();
    const password = randomPassword();
    await fillForm(page, email, password);
    await terms(page).check();
    await createButton(page).click();

    const copy = copyOf();
    await expect(page.getByRole("heading", { name: copy.confirm.title })).toBeVisible();
    await expect(page.getByText(copy.confirm.lead(email))).toBeVisible();
    await expectReadableScreen(page);
    // One call, exactly POST /api/signup.start, no batch, with the WAF token, and never the password.
    expect(api.starts).toHaveLength(1);
    const [start] = api.starts;
    expect(start?.method).toBe("POST");
    expect(new URL(start?.url ?? "http://x").pathname).toBe("/api/signup.start");
    expect(new URL(start?.url ?? "http://x").searchParams.has("batch")).toBe(false);
    expect(start?.wafToken).toBe(E2E_WAF_TOKEN);
    expect(start?.body).not.toContain(password);
    expect(JSON.parse(start?.body ?? "{}")).toMatchObject({ email, locale: LOCALE[langOf()], consents: { TERMS_PRIVACY: { accepted: true }, CONTACT: { accepted: false } } });
    expect(signup.calls[0]).toMatchObject({ operation: "SignUp", username: "gst-01K80000000000000000000001", ticket: "e2e-ticket-1", locale: LOCALE[langOf()] });

    const wrong = signup.codeFor(email) === "111111" ? "222222" : "111111";
    await page.getByLabel(copy.confirm.code).fill(wrong);
    await page.getByRole("button", { name: copy.confirm.submit }).click();
    await expect(page.getByRole("alert")).toHaveText(copy.errors({ login: "", forgot: "" }).INVALID_CODE.join(""));

    await page.getByRole("button", { name: copy.confirm.resend }).click();
    await expect(page.getByText(copy.confirm.resent)).toBeVisible();
    expect(signup.calls.map((call) => call.operation)).toContain("ResendConfirmationCode");

    await page.getByLabel(copy.confirm.code).fill(signup.codeFor(email));
    await page.getByRole("button", { name: copy.confirm.submit }).click();
    await expect(page).toHaveURL(/\/app\/home/);
    await expect(page.getByRole("heading", { name: guestHomeCopy[langOf()].ready.title })).toBeVisible();

    // The password lived in memory only: not in either storage, and it proved itself by SRP.
    const stored = await page.evaluate(() => [...Object.values(sessionStorage), ...Object.values(localStorage)].join("\n"));
    expect(stored).not.toContain(password);
    const signIn = cognito.filter((call) => call.operation === "InitiateAuth" || call.operation === "RespondToAuthChallenge");
    expect(signIn.length).toBeGreaterThan(0);
    for (const call of signIn) expect(call.body).not.toContain(password);
  });

  test("[FL-105] when the automatic sign-in fails, the login opens with the email typed", async ({ page }) => {
    const { pool, signup } = await openSignup(page);
    const email = newEmail();
    await fillForm(page, email, randomPassword());
    await terms(page).check();
    await createButton(page).click();
    await expect(page.getByRole("heading", { name: copyOf().confirm.title })).toBeVisible();
    pool.failNext = { operation: "InitiateAuth", type: "NotAuthorizedException" };
    await page.getByLabel(copyOf().confirm.code).fill(signup.codeFor(email));
    await page.getByRole("button", { name: copyOf().confirm.submit }).click();
    await expect(page).toHaveURL(/\/login/);
    const login = langOf() === "en" ? loginCopyEn : loginCopy;
    await expect(page.getByLabel(login.credentials.email)).toHaveValue(email);
    expect(new URL(page.url()).search).not.toContain("example.test");
  });

  test("[FL-121] an email with an account offers to sign in or reset the password", async ({ page }) => {
    const { api } = await openSignup(page);
    api.refusal = "EMAIL_TAKEN";
    await fillForm(page, newEmail(), randomPassword());
    await terms(page).check();
    await createButton(page).click();
    const alert = page.getByRole("alert");
    const [, signIn, , reset] = copyOf().errors({ login: "", forgot: "" }).EMAIL_TAKEN;
    await expect(alert.getByRole("link", { name: typeof signIn === "string" ? "" : signIn?.label })).toHaveAttribute("href", new RegExp(`^/login\\?lang=${encodeURIComponent(LOCALE[langOf()])}$`));
    await expect(alert.getByRole("link", { name: typeof reset === "string" ? "" : reset?.label })).toHaveAttribute("href", /\/login\?forgot=1&lang=/);
  });

  test("[FL-113] the limits and the day's cap read as their neutral texts, with a way to reach Craftech", async ({ page }) => {
    const { api } = await openSignup(page);
    await fillForm(page, newEmail(), randomPassword());
    await terms(page).check();
    const texts = copyOf().errors({ login: "", forgot: "" });
    for (const reason of ["RATE_LIMITED", "CAP_REACHED", "EMAIL_DOMAIN"] as const) {
      api.refusal = reason;
      await createButton(page).click();
      const expected = texts[reason].map((part) => (typeof part === "string" ? part : part.label)).join("");
      await expect(page.getByRole("alert")).toHaveText(expected);
      if (reason !== "EMAIL_DOMAIN") await expect(page.getByRole("alert").getByRole("link")).toHaveAttribute("href", CONTACT_URL);
    }
  });

  test("[FL-114] without the AWS WAF token (a blocker) the form says so and never shows a CAPTCHA", async ({ page }) => {
    const { api } = await openSignup(page, { waf: "blocked" });
    await fillForm(page, newEmail(), randomPassword());
    await terms(page).check();
    await expect(page.getByRole("alert")).toHaveText(copyOf().errors({ login: "", forgot: "" }).BROWSER_CHECK.join(""), { timeout: 15_000 });
    await expect(createButton(page)).toBeDisabled();
    await expect(page.locator("iframe, [id*=captcha i], [class*=captcha i]")).toHaveCount(0);
    expect(api.starts).toEqual([]);
  });

  test("the language switch changes the texts and the document's language, and keeps what was typed", async ({ page }) => {
    await openSignup(page);
    const email = newEmail();
    await page.getByLabel(copyOf().email, { exact: true }).fill(email);
    const other: Lang = langOf() === "es" ? "en" : "es";
    await page.getByRole("button", { name: langOf() === "es" ? /English/ : /Español/ }).click();
    await expect(page.getByRole("heading", { name: signupCopy[other].title })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", LOCALE[other]);
    await expect(page.getByLabel(signupCopy[other].email, { exact: true })).toHaveValue(email);
    await expect(page.getByRole("link", { name: signupCopy[other].haveAccount.link })).toHaveAttribute("href", `/login?lang=${encodeURIComponent(LOCALE[other])}`);
  });
});
