// FL-079 in the browser (docs/test-plan.md §2.1: the only level where the SRP sign-in, the initial
// password change and TOTP run): the console's own login against a route mock of Cognito, with
// tokens of 15 minutes signed by the run's ephemeral key, for the three roles, the guest variant
// included. Also the shell every later view lives in: the brand of `brand.get`, the simulated-time
// bar with its polling and controls, the placeholders of the views and the guided-tour dock.
import { type Page, expect, test } from "@playwright/test";
import { copy } from "../src/copy/console";
import { dataCopy } from "../src/copy/console-data";
import { totpCode } from "../src/lib/auth/testing/totp";
import { TOKENS_KEY } from "../src/lib/auth/tokens";
import { loginCopy } from "../src/views/login/copy";
import { expectReadableScreen } from "./support/a11y";
import { type Account, addAccount, createPool, randomPassword } from "./support/accounts";
import { type CognitoCall, routeCognito } from "./support/cognito";
import { quietClock, routeConsoleApi } from "./support/console-api";
import { KEY_ID } from "./support/tokens";

// Fictitious operators: the repository never names the real design partner (ADR-0018).
const NEUTRAL_BRAND = { mode: "neutral", displayName: "Operadora ficticia de prueba", logos: { onLight: null, onDark: null }, disclaimer: null };
const COBRAND = {
  mode: "cobrand",
  displayName: "Operadora Socia",
  logos: { onLight: null, onDark: null },
  disclaimer: { es: "Demo sintética: el manual, las políticas y los datos son inventados.", en: "Synthetic demo: the manual, the policies and the data are made up." },
};

async function signIn(page: Page, account: Pick<Account, "email" | "password">): Promise<void> {
  await page.getByLabel(loginCopy.credentials.email).fill(account.email);
  await page.getByLabel(loginCopy.credentials.password, { exact: true }).fill(account.password);
  await page.getByRole("button", { name: loginCopy.credentials.submit }).click();
}

const operations = (calls: readonly CognitoCall[]) => calls.map((call) => call.operation);
const refreshes = (calls: readonly CognitoCall[]) => calls.filter((call) => call.operation === "InitiateAuth" && call.body.includes("REFRESH_TOKEN_AUTH")).length;

test.describe("console sign-in", () => {
  test("[FL-079] a supervisor's first sign-in: SRP, an own password, the optional TOTP, then the console", async ({ page }) => {
    const pool = createPool();
    const supervisor = await addAccount(pool, { role: "SUPERVISOR", invited: true, name: "Supervisora de prueba" });
    const cognito = await routeCognito(page, pool);
    await routeConsoleApi(page, { brand: NEUTRAL_BRAND });

    await page.goto("/app/orders");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fapp%2Forders$/);
    await expect(page.getByRole("heading", { name: loginCopy.credentials.title })).toBeVisible();
    await expectReadableScreen(page);

    await signIn(page, supervisor);
    await expect(page.getByRole("heading", { name: loginCopy.newPassword.title })).toBeVisible();
    const chosen = randomPassword();
    await page.getByLabel(loginCopy.newPassword.field).fill(chosen);
    await page.getByLabel(loginCopy.password.confirm).fill(chosen);
    await page.getByRole("button", { name: loginCopy.newPassword.submit }).click();

    await expect(page.getByRole("heading", { name: loginCopy.mfaSetup.title })).toBeVisible();
    await expect(page.getByText(loginCopy.mfaSetup.leadOptional)).toBeVisible();
    await page.getByRole("button", { name: loginCopy.mfaSetup.skip }).click();

    await expect(page).toHaveURL(/\/app\/orders$/);
    await expect(page.getByRole("heading", { name: copy.views.orders.title })).toBeVisible();
    await expect(page.getByText(`${copy.app.roleLabel}: ${copy.roles.SUPERVISOR} · ${copy.app.ispLabel}: ${NEUTRAL_BRAND.displayName}`)).toBeVisible();
    await expect(page.getByRole("region", { name: copy.clock.label })).toContainText(`${copy.clock.label} · mar 13/10 07:00 · ${copy.clock.paused}`);
    await expectReadableScreen(page);

    // SRP proves the temporary password: it never crossed the wire.
    expect(operations(cognito).slice(0, 2)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    for (const call of cognito) expect(call.body).not.toContain(supervisor.password);
  });

  test("[FL-079] operations staff with TOTP finish the sign-in with the code of their app", async ({ page }) => {
    const pool = createPool();
    const ops = await addAccount(pool, { role: "OPS", withTotp: true });
    await routeCognito(page, pool);
    await routeConsoleApi(page, { brand: NEUTRAL_BRAND });

    await page.goto("/login");
    await signIn(page, ops);
    await expect(page.getByRole("heading", { name: loginCopy.totp.title })).toBeVisible();
    await page.getByLabel(loginCopy.totp.code, { exact: true }).fill(await totpCode(ops.totpSecret ?? ""));
    await page.getByRole("button", { name: loginCopy.totp.submit }).click();

    await expect(page).toHaveURL(/\/app\/orders$/);
    await expect(page.getByText(`${copy.app.roleLabel}: ${copy.roles.OPS}`)).toBeVisible();
  });

  test("[FL-079] a guest signs in with the password alone: no password change, no TOTP, back where it was going", async ({ page }) => {
    const pool = createPool();
    const guest = await addAccount(pool, { role: "GUEST" });
    const cognito = await routeCognito(page, pool);
    // brand.get fails here: every surface stays on the neutral brand.
    await routeConsoleApi(page);

    await page.goto("/app/clock");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fapp%2Fclock$/);
    await signIn(page, guest);

    await expect(page).toHaveURL(/\/app\/clock$/);
    await expect(page.getByRole("heading", { name: copy.views.clock.title })).toBeVisible();
    await expect(page.getByText(`${copy.app.roleLabel}: ${copy.roles.GUEST}`)).toBeVisible();
    await expect(page.getByText(loginCopy.mfaSetup.title)).toHaveCount(0);
    expect(operations(cognito)).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);

    // Neutral brand: "Cuadrilla · Powered by Craftech", the synthetic-data notice, no partner, no operator name.
    const navigation = page.getByRole("navigation", { name: "Cuadrilla" });
    await expect(navigation).toContainText(copy.app.syntheticData);
    await expect(navigation.getByRole("note")).toHaveCount(0);
    await expect(page.getByText(`${copy.app.ispLabel}:`)).toHaveCount(0);
    await expectReadableScreen(page);

    // The id token is signed by the run's key (RS256) and lives 15 minutes.
    const stored = await page.evaluate((key) => sessionStorage.getItem(key), TOKENS_KEY);
    const tokens = JSON.parse(stored ?? "{}") as { idToken: string; expiresAt: number };
    const header = JSON.parse(Buffer.from(tokens.idToken.split(".")[0] ?? "", "base64url").toString()) as { alg: string; kid: string };
    expect(header).toMatchObject({ alg: "RS256", kid: KEY_ID });
    expect(tokens.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(tokens.expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  test("[FL-079] a wrong password and an unknown email read exactly the same", async ({ page }) => {
    const pool = createPool();
    const supervisor = await addAccount(pool, { role: "SUPERVISOR" });
    await routeCognito(page, pool);
    await routeConsoleApi(page);

    await page.goto("/login");
    await signIn(page, { email: supervisor.email, password: randomPassword() });
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText(loginCopy.errors.INVALID_CREDENTIALS);
    await signIn(page, { email: "nobody@example.test", password: supervisor.password });
    await expect(alert).toHaveText(loginCopy.errors.INVALID_CREDENTIALS);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("[FL-079] tokens of 15 minutes refresh silently, and signing out revokes them", async ({ page }) => {
    const pool = createPool();
    const guest = await addAccount(pool, { role: "GUEST" });
    const cognito = await routeCognito(page, pool);
    await routeConsoleApi(page, { brand: NEUTRAL_BRAND });
    await page.clock.install();

    await page.goto("/login");
    await signIn(page, guest);
    await expect(page.getByRole("heading", { name: copy.views.orders.title })).toBeVisible();
    expect(refreshes(cognito)).toBe(0);

    // The session refreshes a minute before the 15 minutes end, without a word to the person.
    await page.clock.fastForward("14:05");
    await expect.poll(() => refreshes(cognito)).toBe(1);
    await expect(page.getByRole("heading", { name: copy.views.orders.title })).toBeVisible();

    await page.getByRole("button", { name: copy.app.signOut }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => operations(cognito).includes("RevokeToken")).toBe(true);
    await page.goto("/app/orders");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fapp%2Forders$/);
  });
});

test.describe("console shell", () => {
  test("co-branding from brand.get, and the simulated-time bar with its polling and controls", async ({ page }) => {
    const pool = createPool();
    const guest = await addAccount(pool, { role: "GUEST" });
    await routeCognito(page, pool);
    const api = await routeConsoleApi(page, {
      brand: COBRAND,
      clock: { ...quietClock(), busy: true, pending: [{ kind: "TRANSCRIBE", sinceReal: new Date().toISOString() }] },
    });

    await page.goto("/login");
    await signIn(page, guest);
    await expect(page.getByRole("heading", { name: copy.views.orders.title })).toBeVisible();

    const navigation = page.getByRole("navigation", { name: "Cuadrilla" });
    await expect(navigation).toContainText(`for ${COBRAND.displayName}`);
    await expect(navigation.getByRole("note")).toHaveText(COBRAND.disclaimer.es);
    await expect(page.getByText(`${copy.app.ispLabel}: ${COBRAND.displayName}`)).toBeVisible();

    // Busy: the bar says what the world waits for and the controls wait too.
    const bar = page.getByRole("region", { name: copy.clock.label });
    const controls = bar.getByRole("group", { name: copy.clock.controls });
    await expect(bar.getByRole("status")).toContainText(copy.clock.busy.TRANSCRIBE);
    for (const name of [copy.clock.advanceToNext, copy.clock.advance[10], copy.clock.advance[60]]) await expect(controls.getByRole("button", { name })).toBeDisabled();

    // Quiet again: the 3-second poll brings the controls back.
    api.state.clock = quietClock();
    await expect(controls.getByRole("button", { name: copy.clock.advance[10] })).toBeEnabled({ timeout: 8_000 });
    await expect(bar.getByRole("status")).toHaveText("");

    await controls.getByRole("button", { name: copy.clock.advance[10] }).click();
    await expect(bar).toContainText("mar 13/10 07:10");
    expect(api.calls).toContainEqual({ path: "clock.advance", input: { minutes: 10 } });

    await controls.getByRole("button", { name: copy.clock.advanceToNext }).click();
    await expect(bar).toContainText("mar 13/10 07:30");

    // A refusal of the BFF reads as its meaning, never as the code.
    api.state.refusals.set("clock.advance", { code: "PRECONDITION_FAILED", httpStatus: 412, reason: "WORLD_BUSY" });
    await controls.getByRole("button", { name: copy.clock.advance[60] }).click();
    await expect(bar.getByRole("status")).toContainText(dataCopy.byReason.WORLD_BUSY ?? "");
    await expectReadableScreen(page);
  });

  test("every view has its place: navigation, detail routes, the tour dock and the public join page", async ({ page }) => {
    const pool = createPool();
    const supervisor = await addAccount(pool, { role: "SUPERVISOR" });
    await routeCognito(page, pool);
    await routeConsoleApi(page, { brand: NEUTRAL_BRAND });

    await page.goto("/join");
    await expect(page.getByRole("heading", { name: copy.public.join.title })).toBeVisible();
    await expectReadableScreen(page);

    await page.goto("/login?returnTo=%2Fapp%2Forders%2Fwo-24817");
    await signIn(page, supervisor);
    await page.getByRole("button", { name: loginCopy.mfaSetup.skip }).click();
    await expect(page.getByRole("heading", { name: copy.views["order-detail"].title })).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Cuadrilla" });
    await expect(navigation.getByRole("link", { name: copy.views.orders.title })).toHaveAttribute("aria-current", "page");

    for (const id of ["cases", "evidence", "people", "manual", "simulator", "clock", "outbox", "metrics", "audit", "orders"] as const) {
      await navigation.getByRole("link", { name: copy.views[id].title }).click();
      await expect(page.getByRole("heading", { level: 1, name: copy.views[id].title })).toBeVisible();
      await expect(page.getByText(copy.placeholder.title)).toBeVisible();
    }

    await page.getByRole("button", { name: copy.tour.open }).click();
    const dock = page.getByRole("complementary", { name: copy.tour.title });
    await expect(dock).toContainText(copy.tour.placeholderTitle);
    await dock.getByRole("button", { name: copy.tour.close }).click();
    await expect(dock).toHaveCount(0);

    await page.goto("/app/nowhere");
    await expect(page.getByRole("heading", { name: copy.errors.notFoundTitle })).toBeVisible();
    await page.goto("/app");
    await expect(page).toHaveURL(/\/app\/orders$/);
  });
});
