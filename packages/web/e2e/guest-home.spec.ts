// FL-107, FL-112 and FL-118 in the browser (docs/test-plan.md §3, level UI): the guest's portada
// (`/app/home`, docs/landing-spec.md §7.6) in its four states, the retry, the rolling-out block, and the
// deletion of the account of a guest of the own sign-up, confirmed with its password. The sign-in is the
// console's own against the route mock of Cognito; `/api/*` answers what the BFF would (guest/world-status.ts),
// in the tRPC batch protocol, with a state each test moves.
import { type Page, type Route, expect, test } from "@playwright/test";
import { guestHomeCopy } from "../src/views/guest-home/copy";
import { loginCopy } from "../src/views/login/copy";
import { expectReadableScreen } from "./support/a11y";
import { createPool, randomPassword } from "./support/accounts";
import { type CognitoCall, routeCognito } from "./support/cognito";
import { quietClock } from "./support/console-api";

type Status = "PROVISIONING" | "READY" | "FAILED" | "CAP_FULL";

interface World {
  status: Status;
  origin: "SIGNUP" | "INVITED";
  canRetry: boolean;
}

interface ApiState {
  world: World;
  /** What the next retry answers. */
  afterRetry: Status;
  /** `guest.world` calls answered PROVISIONING before the world turns READY (the build). */
  readyAfterCalls: number;
  readonly calls: Array<{ readonly path: string; readonly authorization: string | undefined }>;
}

const SIGNUP_ISP = "isp-guest-s261001abcde";
const NEUTRAL_BRAND = { mode: "neutral", displayName: "Operadora ficticia de prueba", logos: { onLight: null, onDark: null }, disclaimer: null };

function view(world: World) {
  const signup = world.origin === "SIGNUP";
  return {
    status: world.status,
    origin: world.origin,
    canDeleteAccount: signup,
    canRetry: world.canRetry || world.status === "FAILED" || world.status === "CAP_FULL",
    refreshSession: false,
    createdAtReal: "2026-10-01T15:00:00.000Z",
    ...(signup ? { expiresAtReal: "2026-10-08T15:00:00.000Z" } : {}),
    ...(world.status === "READY"
      ? { summary: { operatorName: "Operadora ficticia de prueba", installers: ["Beatriz Salazar", "Julián Rivas", "Karina Ortega", "Rogelio Méndez"], supervisors: 4, workOrders: 13, simNow: "2026-10-13T07:00:00-06:00" } }
      : {}),
  };
}

function answer(state: ApiState, path: string) {
  const data = (value: unknown) => ({ result: { data: value } });
  switch (path) {
    case "brand.get":
      return data(NEUTRAL_BRAND);
    case "clock.get":
      return data(quietClock());
    case "guest.world":
      if (state.world.status === "PROVISIONING" && state.readyAfterCalls > 0) {
        state.readyAfterCalls -= 1;
        if (state.readyAfterCalls === 0) state.world.status = "READY";
      }
      return data(view(state.world));
    case "guest.retryWorld":
      state.world = { ...state.world, status: state.afterRetry, canRetry: false };
      return data(view(state.world));
    case "account.deleteGuest":
      return data({ deleted: true });
    default:
      return { error: { message: "NOT_FOUND", code: -32_004, data: { code: "NOT_FOUND", httpStatus: 404, path, reason: null, correlationId: "e2e" } } };
  }
}

async function routeApi(page: Page, initial: Partial<ApiState> & { readonly world: World }): Promise<ApiState> {
  const state: ApiState = { afterRetry: "PROVISIONING", readyAfterCalls: 0, calls: [], ...initial };
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route: Route) => {
      const url = new URL(route.request().url());
      const paths = url.pathname.slice("/api/".length).split(",");
      const batch = url.searchParams.get("batch") === "1";
      const authorization = route.request().headers().authorization;
      const items = paths.map((path) => {
        state.calls.push({ path, authorization });
        return answer(state, path);
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(batch ? items : items[0]) });
    },
  );
  return state;
}

function langOf(): "es" | "en" {
  return test.info().project.use.locale === "en" ? "en" : "es";
}

async function signInToHome(page: Page, ispId = SIGNUP_ISP): Promise<{ readonly password: string; readonly cognito: CognitoCall[] }> {
  const pool = createPool();
  const password = randomPassword();
  const email = `guest-${Date.now()}@example.test`;
  await pool.addUser({ email, password, role: "GUEST", ispId, status: "CONFIRMED" });
  const cognito = await routeCognito(page, pool);
  const home = langOf() === "en" ? "/app/home?lang=en" : "/app/home";
  await page.goto(`/login?returnTo=${encodeURIComponent(home)}`);
  await page.getByLabel(loginCopy.credentials.email).fill(email);
  await page.getByLabel(loginCopy.credentials.password, { exact: true }).fill(password);
  await page.getByRole("button", { name: loginCopy.credentials.submit }).click();
  await expect(page).toHaveURL(/\/app\/home/);
  return { password, cognito };
}

test.describe("guest portada", () => {
  test("[FL-107] PROVISIONING while the world is built, then READY with its summary, its expiry and the parts that arrive in stages", async ({ page }) => {
    const copy = guestHomeCopy[langOf()];
    // Development renders each effect twice: the first two calls come at once, the next ones every 2 s.
    await routeApi(page, { world: { status: "PROVISIONING", origin: "SIGNUP", canRetry: false }, readyAfterCalls: 4 });
    await signInToHome(page);
    await expect(page.getByRole("heading", { name: copy.provisioning.title })).toBeVisible();
    await expect(page.getByText(copy.provisioning.lead)).toBeVisible();
    await expectReadableScreen(page);

    await expect(page.getByRole("heading", { name: copy.ready.title })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Operadora ficticia de prueba").first()).toBeVisible();
    await expect(page.getByText(/Rogelio Méndez/)).toBeVisible();
    await expect(page.getByText(copy.ready.expiry(langOf() === "en" ? "October 8, 2026" : "8 de octubre de 2026"))).toBeVisible();
    await expect(page.getByRole("heading", { name: copy.stages.title })).toBeVisible();
    await expect(page.getByRole("heading", { name: copy.stages.pending })).toBeVisible();
    await expect(page.getByRole("button", { name: copy.deletion.open })).toBeVisible();
    await expect(page.getByRole("button", { name: copy.retry })).toHaveCount(0);
    await expectReadableScreen(page);
    const width = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(width).toBeLessThanOrEqual(0);
  });

  test("[FL-107] a build taking longer than usual says so, with a way to reach Craftech", async ({ page }) => {
    const copy = guestHomeCopy[langOf()];
    await routeApi(page, { world: { status: "PROVISIONING", origin: "SIGNUP", canRetry: false } });
    await signInToHome(page);
    await expect(page.getByText(copy.provisioning.longWait.before.trim(), { exact: false })).toBeVisible({ timeout: 15_000 });
    const link = page.getByRole("link", { name: copy.provisioning.longWait.link });
    await expect(link).toHaveAttribute("href", "https://craftech.io/contact/");
  });

  test("[FL-107] FAILED offers Reintentar, which asks for the world again and follows it to READY", async ({ page }) => {
    const copy = guestHomeCopy[langOf()];
    const api = await routeApi(page, { world: { status: "FAILED", origin: "SIGNUP", canRetry: true }, afterRetry: "PROVISIONING", readyAfterCalls: 1 });
    await signInToHome(page);
    await expect(page.getByRole("heading", { name: copy.failed.title })).toBeVisible();
    await expect(page.getByText(copy.failed.lead)).toBeVisible();
    await expectReadableScreen(page);
    await page.getByRole("button", { name: copy.retry }).click();
    await expect(page.getByRole("heading", { name: copy.ready.title })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => api.calls.filter((call) => call.path === "guest.retryWorld").length).toBe(1);
  });

  test("[FL-112] CAP_FULL: the account exists, there is no room yet; Reintentar and Hablemos", async ({ page }) => {
    const copy = guestHomeCopy[langOf()];
    const api = await routeApi(page, { world: { status: "CAP_FULL", origin: "SIGNUP", canRetry: true }, afterRetry: "CAP_FULL" });
    await signInToHome(page);
    await expect(page.getByRole("heading", { name: copy.capFull.title })).toBeVisible();
    await expect(page.getByText(copy.capFull.lead)).toBeVisible();
    const talk = page.getByRole("link", { name: copy.capFull.talk.link });
    await expect(talk).toHaveAttribute("href", "https://craftech.io/contact/");
    await expect(talk).toHaveAttribute("target", "_blank");
    await expectReadableScreen(page);
    await page.getByRole("button", { name: copy.retry }).click();
    await expect.poll(() => api.calls.some((call) => call.path === "guest.retryWorld")).toBe(true);
    await expect(page.getByRole("heading", { name: copy.capFull.title })).toBeVisible();
  });

  test("[FL-107] an invited guest's portada has no expiry and no deletion", async ({ page }) => {
    const copy = guestHomeCopy[langOf()];
    await routeApi(page, { world: { status: "READY", origin: "INVITED", canRetry: false } });
    await signInToHome(page, "isp-guest-07");
    await expect(page.getByRole("heading", { name: copy.ready.title })).toBeVisible();
    await expect(page.getByRole("button", { name: copy.deletion.open })).toHaveCount(0);
    await expect(page.getByText(langOf() === "en" ? /expires on/ : /vence el/)).toHaveCount(0);
  });

  test("[FL-118] Borrar mi cuenta: the password confirms, a wrong one is refused, then the account is deleted with a fresh sign-in and the session closed", async ({ page }) => {
    const copy = guestHomeCopy[langOf()];
    const api = await routeApi(page, { world: { status: "READY", origin: "SIGNUP", canRetry: false } });
    const { password, cognito } = await signInToHome(page);
    await page.getByRole("button", { name: copy.deletion.open }).click();
    const dialog = page.getByRole("dialog", { name: copy.deletion.title });
    await expect(dialog.getByText(copy.deletion.warning)).toBeVisible();
    await expect(dialog.getByRole("button", { name: copy.deletion.confirm })).toBeDisabled();
    await dialog.getByLabel(copy.deletion.password).fill(`${password}-wrong`);
    await dialog.getByRole("button", { name: copy.deletion.confirm }).click();
    await expect(dialog.getByText(copy.deletion.wrongPassword)).toBeVisible();
    expect(api.calls.filter((call) => call.path === "account.deleteGuest")).toHaveLength(0);

    const beforeDeletion = cognito.length;
    await dialog.getByLabel(copy.deletion.password).fill(password);
    await dialog.getByRole("button", { name: copy.deletion.confirm }).click();
    await expect(page).toHaveURL(/\/login/);
    const deletions = api.calls.filter((call) => call.path === "account.deleteGuest");
    expect(deletions).toHaveLength(1);
    // A sign-in of seconds ago: the token of the call carries a fresh auth_time.
    const payload = JSON.parse(Buffer.from((deletions[0]?.authorization ?? "").split(".")[1] ?? "", "base64url").toString()) as { auth_time: number };
    expect(Date.now() / 1000 - payload.auth_time).toBeLessThan(60);
    const after = cognito.slice(beforeDeletion).map((call) => call.operation);
    expect(after).toContain("RespondToAuthChallenge");
    expect(after).toContain("RevokeToken");
    for (const call of cognito) expect(call.body).not.toContain(password);
  });
});
