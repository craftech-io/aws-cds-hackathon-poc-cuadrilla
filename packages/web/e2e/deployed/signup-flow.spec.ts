// The own sign-up end to end on the deployed stage (docs/test-plan.md §6.1, rows "Alta completa",
// "Recuperación", "Logout y borrado"; FL-104 to FL-110, FL-115, FL-118), through the public path with
// its real limits: landing (with UTM tags) → `/signup` with a QA address and both consents → the code
// step → the operator's QA seam (`npm run qa:confirm-signup`, the address Cognito holds is fenced to
// `success+qa-…@simulator.amazonses.com`) → sign-in with the email at `/login` → the portada READY
// within 60 s of the confirmation → sign-out (RevokeToken) → sign-in again.
//
//   @evidence  one sign-up, kept for the CTO (never deleted here), in desktop-1440-es; its recovery
//              request must read exactly like the one of an address without an account.
//   @full      four sign-ups (es/en × phone/desktop, two with reduced motion), each deleted from its
//              portada with "Borrar mi cuenta" and checked gone (no Cognito user, no lead).
//
// Run the evidence first, then the four in the same clock hour (5 starts per IP and hour). Needs QA_RUN
// and AWS_PROFILE (the seam and the lead scripts). Addresses and users of the run are written to
// `<QA_SHOTS_DIR>/../run-<QA_RUN>.json`, outside the repository, for the cleanup with leads:delete;
// the evidence account's password to a 0600 file next to it. Nothing here prints a password.
import { type Page, expect, test } from "@playwright/test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONTACT, TERMS_PRIVACY } from "@cuadrilla/shared/legal/consents";
import { copy as consoleCopy } from "../../src/copy/console";
import { LANDING_COPY } from "../../src/views/landing/copy";
import { guestHomeCopy } from "../../src/views/guest-home/copy";
import { loginCopy } from "../../src/views/login/copy";
import { loginCopyEn } from "../../src/views/login/copy.en";
import { signupCopy } from "../../src/views/signup/copy";
import { expectReadableScreen } from "../support/a11y";
import { PHASES, SHOTS_DIR, expectNeutral, newPassword, noHorizontalScroll, onlyIn, operatorScript, projectContext, qaAddress, runTag, shot } from "./support";

const READY_WITHIN_MS = 60_000;
const UTM = "utm_source=qa&utm_medium=deployed&utm_campaign=wp62";

interface Account {
  readonly email: string;
  readonly password: string;
  username?: string;
}

const RUN_FILE = () => join(dirname(SHOTS_DIR), `run-${runTag()}.json`);

function record(entry: Record<string, unknown>): void {
  mkdirSync(dirname(RUN_FILE()), { recursive: true });
  appendFileSync(RUN_FILE(), `${JSON.stringify({ at: new Date().toISOString(), project: projectContext().name, ...entry })}\n`, { mode: 0o600 });
}

const loginText = () => (projectContext().lang === "en" ? loginCopyEn : loginCopy);
const homePath = () => (projectContext().lang === "en" ? "/app/home?lang=en" : "/app/home");

/** The seam's last line: `qa:confirm-signup: {…}`; a refusal or a missing user exits 2 with it on stdout. */
async function seam(args: readonly string[]): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    stdout = await operatorScript("qa:confirm-signup", args);
  } catch (error) {
    stdout = String((error as { stdout?: unknown }).stdout ?? "");
    if (!stdout.includes("qa:confirm-signup: {")) throw error;
  }
  const line = stdout.split("\n").find((entry) => entry.startsWith("qa:confirm-signup: {")) ?? "";
  return JSON.parse(line.slice("qa:confirm-signup: ".length)) as Record<string, unknown>;
}

async function startSignup(page: Page, account: Account, options: { readonly contact: boolean }): Promise<number> {
  const { lang, param } = projectContext();
  const copy = signupCopy[lang];
  await page.goto(`/?lang=${param}&${UTM}`);
  await page.locator("#hero").getByRole("link", { name: LANDING_COPY[lang].nav.tryDemo }).click();
  await expect(page.getByRole("heading", { name: copy.title })).toBeVisible();
  await page.getByLabel(copy.email, { exact: true }).fill(account.email);
  await page.getByLabel(copy.password, { exact: true }).fill(account.password);
  await page.getByLabel(copy.name).fill("Ana Prueba");
  await page.getByLabel(copy.company).fill("Fibra de Prueba");
  await page.getByRole("checkbox", { name: TERMS_PRIVACY.text[param] }).check();
  if (options.contact) await page.getByRole("checkbox", { name: CONTACT.text[param] }).check();
  const create = page.getByRole("button", { name: copy.submit });
  await expect(create).toBeEnabled({ timeout: 20_000 });
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/signup.start", { timeout: 30_000 });
  await create.click();
  const response = await answer;
  const detail = `signup.start answered ${response.status()}${response.headers()["x-amzn-waf-action"] ? ` (x-amzn-waf-action: ${response.headers()["x-amzn-waf-action"]})` : ""}`;
  if (response.status() !== 200) {
    await page.waitForTimeout(1_500);
    await shot(page, "signup-start-refused", { fullPage: true });
    record({ step: "signup.start", ok: false, detail });
  }
  expect(response.status(), detail).toBe(200);
  const body = (await response.json()) as { result?: { data?: { username?: string } } };
  account.username = body.result?.data?.username;
  expect(account.username ?? "").toMatch(/^gst-[0-9A-HJKMNP-TV-Z]{26}$/);
  // After the start the browser calls Cognito's SignUp with the ticket; the pre sign-up may still refuse it.
  const codeStep = page.getByRole("heading", { name: copy.confirm.title });
  const refusal = page.getByRole("alert");
  await expect(codeStep.or(refusal).first()).toBeVisible({ timeout: 20_000 });
  if (await refusal.isVisible()) {
    const text = (await refusal.innerText()).trim();
    await shot(page, "signup-refused-after-start", { fullPage: true });
    record({ step: "SignUp", ok: false, user: account.username?.slice(0, 8), detail: `the form shows: ${text}` });
    expect(text, "Cognito's SignUp with the ticket of signup.start").toBe("");
  }
  await expect(codeStep).toBeVisible();
  await expect(page.getByText(copy.confirm.lead(account.email))).toBeVisible();
  await expectReadableScreen(page);
  await expectNeutral(page, "/signup code step");
  await noHorizontalScroll(page);
  await shot(page, "signup-code-step", { fullPage: true });
  const outcome = await seam(["--username", account.username ?? ""]);
  expect(outcome).toMatchObject({ outcome: "CONFIRMED", userStatus: "CONFIRMED", emailVerified: true });
  record({ step: "confirmed", email: account.email, user: account.username?.slice(0, 8), verifiedBySeam: outcome.verifiedBySeam });
  return Date.now();
}

async function signIn(page: Page, account: Account): Promise<void> {
  const text = loginText();
  await page.goto(`/login?lang=${projectContext().param}&returnTo=${encodeURIComponent(homePath())}`);
  await page.getByLabel(text.credentials.email).fill(account.email);
  await page.getByLabel(text.credentials.password, { exact: true }).fill(account.password);
  await page.getByRole("button", { name: text.credentials.submit }).click();
  await expect(page).toHaveURL(/\/app\/home/, { timeout: 30_000 });
}

async function expectReady(page: Page, confirmedAt: number, name: string): Promise<void> {
  const copy = guestHomeCopy[projectContext().lang];
  const provisioning = page.getByRole("heading", { name: copy.provisioning.title });
  if (await provisioning.isVisible().catch(() => false)) await shot(page, `${name}-provisioning`);
  await expect(page.getByRole("heading", { name: copy.ready.title })).toBeVisible({ timeout: Math.max(5_000, READY_WITHIN_MS - (Date.now() - confirmedAt)) });
  record({ step: "ready", afterConfirmationMs: Date.now() - confirmedAt });
  await expect(page.getByRole("heading", { name: copy.ready.summaryTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: copy.stages.title })).toBeVisible();
  await expect(page.getByRole("button", { name: copy.deletion.open })).toBeVisible();
  await expect(page.getByText(projectContext().lang === "en" ? /expires on/ : /vence el/)).toBeVisible();
  await expectReadableScreen(page);
  await expectNeutral(page, "/app/home");
  await noHorizontalScroll(page);
  await shot(page, name, { fullPage: true });
}

async function signOut(page: Page): Promise<void> {
  const revoke = page.waitForRequest((request) => request.url().includes("cognito-idp.") && (request.headers()["x-amz-target"] ?? "").endsWith(".RevokeToken"), { timeout: 20_000 });
  await page.getByRole("button", { name: new RegExp(`^(?:${consoleCopy.app.signOut}|Sign out)$`) }).first().click();
  const request = await revoke;
  expect((await request.response())?.status()).toBe(200);
  await expect(page).toHaveURL(/\/login/);
  const stored = await page.evaluate(() => [...Object.keys(sessionStorage), ...Object.keys(localStorage)].filter((key) => key.includes("token")));
  expect(stored).toEqual([]);
  await page.goto(homePath());
  await expect(page).toHaveURL(/\/login\?returnTo=/);
}

/** The recovery request's screen, with the address replaced, for a known and an unknown address. */
async function recoveryScreen(page: Page, email: string): Promise<string> {
  const text = loginText();
  await page.goto(`/login?lang=${projectContext().param}`);
  await page.getByRole("button", { name: text.credentials.forgot }).click();
  await page.getByLabel(text.credentials.email).fill(email);
  await page.getByRole("button", { name: text.forgot.submit }).click();
  await expect(page.getByRole("heading", { name: text.reset.title })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  return (await page.locator("main").innerText()).replace(email, "EMAIL");
}

async function deleteFromPortada(page: Page, account: Account): Promise<void> {
  const copy = guestHomeCopy[projectContext().lang];
  await page.getByRole("button", { name: copy.deletion.open }).click();
  const dialog = page.getByRole("dialog", { name: copy.deletion.title });
  await expect(dialog.getByText(copy.deletion.warning)).toBeVisible();
  await shot(page, "portada-delete-dialog");
  await dialog.getByLabel(copy.deletion.password).fill(account.password);
  await dialog.getByRole("button", { name: copy.deletion.confirm }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
  expect(await seam(["--username", account.username ?? "", "--status"])).toEqual({ outcome: "NOT_FOUND" });
  const lead = await operatorScript("leads:delete", [], `${account.email}\n`);
  expect(lead).toContain("nothing to delete");
  record({ step: "deleted", email: account.email, user: account.username?.slice(0, 8), cognito: "NOT_FOUND", lead: "none" });
}

test.describe("deployed own sign-up", () => {
  test.describe.configure({ mode: "serial", retries: 0 });

  test("[FL-104] [FL-105] [FL-107] [FL-108] [FL-109] [FL-110] the evidence sign-up for the CTO, kept @evidence", async ({ page }) => {
    onlyIn("evidence");
    test.setTimeout(420_000);
    const account: Account = { email: qaAddress("evidence"), password: newPassword() };
    const confirmedAt = await startSignup(page, account, { contact: true });
    const secret = join(dirname(SHOTS_DIR), `evidence-${runTag()}.password`);
    writeFileSync(secret, `${account.password}\n`, { mode: 0o600 });
    record({ step: "evidence-kept", email: account.email, user: account.username?.slice(0, 8), passwordFile: secret });
    await signIn(page, account);
    await expectReady(page, confirmedAt, "portada-ready");
    await signOut(page);
    await shot(page, "login-after-sign-out", { fullPage: true });
    await signIn(page, account);
    await expectReady(page, Date.now(), "portada-after-sign-in");
    await signOut(page);
    const known = await recoveryScreen(page, account.email);
    await shot(page, "recovery-known-address", { fullPage: true });
    const unknown = await recoveryScreen(page, qaAddress("nobody"));
    expect(unknown).toBe(known);
  });

  test("[FL-104] [FL-105] [FL-107] [FL-108] [FL-110] [FL-118] a full sign-up, deleted from its portada @full", async ({ page }) => {
    onlyIn("full");
    test.setTimeout(420_000);
    const account: Account = { email: qaAddress(`full-${PHASES.full.projects.indexOf(projectContext().name as (typeof PHASES.full.projects)[number]) + 1}`), password: newPassword() };
    const confirmedAt = await startSignup(page, account, { contact: false });
    await signIn(page, account);
    await expectReady(page, confirmedAt, "portada-ready");
    await signOut(page);
    await signIn(page, account);
    await expectReady(page, Date.now(), "portada-after-sign-in");
    await deleteFromPortada(page, account);
  });
});
