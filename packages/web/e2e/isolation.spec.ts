// FL-081 in the browser (docs/test-plan.md §3, level UI): isolation between operators and worlds against
// the real router and its operator fence. A guest sees only its own world; an id of another operator in
// the address bar is refused (403, audited as `CROSS_ISP`) and nothing of that order reaches the screen,
// either way round; a token whose operator was changed by hand is not a session at all.
import { type Page, expect, test } from "@playwright/test";
import { dataCopy } from "../src/copy/console-data";
import { TOKENS_KEY } from "../src/lib/auth/tokens";
import { detailCopy } from "../src/views/order-detail/copy";
import { ordersCopy } from "../src/views/orders/copy";
import { type ConsoleBackend, idTokenOf, signIn, startConsoleBackend } from "./support/console-backend";
import { DEMO_WORLD, GUEST_07_WORLD, seedCase, seedOrderStory } from "./support/story";
import { type AccountRole, E2E_CLIENT_ID, E2E_POOL_ID, addAccount, createPool } from "./support/accounts";
import { routeCognito } from "./support/cognito";

let backend: ConsoleBackend;

test.beforeEach(async ({ page, baseURL }) => {
  backend = await startConsoleBackend({ pageOrigin: baseURL ?? "", userPoolId: E2E_POOL_ID, clientId: E2E_CLIENT_ID });
  await backend.attach(page);
  await seedOrderStory(backend.app, DEMO_WORLD);
});

test.afterEach(async () => {
  await backend.close();
});

async function as(page: Page, role: AccountRole, path: string): Promise<void> {
  const pool = createPool();
  await routeCognito(page, pool);
  await signIn(page, path, await addAccount(pool, { role, name: role === "GUEST" ? "Invitado de prueba" : "Supervisión de prueba" }));
}

const crossIspRows = (ispId: string) => backend.app.memory.client.dump("AuditLog").filter((row) => row.entity === "Decision" && row.ispId === ispId && row.action === "CROSS_ISP" && row.decision === "DENY");

test.describe("isolation between operators and worlds [FL-081]", () => {
  test("[FL-081] a guest sees only its own world: its copy of the day's orders, none of the demo world's story", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) calls.push(decodeURIComponent(request.url()));
    });
    await as(page, "GUEST", "/app/orders");
    const rows = page.getByRole("table", { name: ordersCopy.caption }).getByRole("row");
    await expect(rows.nth(1)).toContainText("24817");
    // The demo world's 24817 has a rejected label photo; the guest's own copy has nothing yet.
    await expect(rows.nth(1).getByRole("img", { name: "Foto de la etiqueta: Pendiente" })).toBeVisible();
    await rows.nth(1).click();
    await expect(page).toHaveURL(/\/app\/orders\/wo-24817-g07$/);
    await expect(page.getByRole("heading", { level: 1, name: detailCopy.title("24817") })).toBeVisible();
    await expect(page.getByText(detailCopy.timeline.empty)).toBeVisible();
    expect(calls.some((url) => /"workOrderId":"wo-24817"/.test(url))).toBe(false);
  });

  test("[FL-081] a guest who types an order of the demo world gets a refusal, audited, and none of its data", async ({ page }) => {
    await as(page, "GUEST", "/app/orders/wo-24817");
    await expect(page.getByRole("alert")).toContainText(dataCopy.byReason.CROSS_ISP ?? "");
    await expect(page.getByText("Calle Jacaranda 214")).toHaveCount(0);
    await expect(page.getByText(detailCopy.sections.timeline)).toHaveCount(0);
    expect(crossIspRows(GUEST_07_WORLD.ispId).length).toBeGreaterThan(0);
  });

  test("[FL-081] a supervisor of the demo operator who types a guest's order or case gets the same refusal", async ({ page }) => {
    await seedCase(backend.app, GUEST_07_WORLD, { caseId: "case-01K7S7XRY000000000000000C3", workOrderNumber: "24818", reason: "DIAGNOSIS_ATTEMPTS" });
    await as(page, "SUPERVISOR", "/app/orders/wo-24817-g07");
    await expect(page.getByRole("alert")).toContainText(dataCopy.byReason.CROSS_ISP ?? "");
    await page.goto("/app/cases/case-01K7S7XRY000000000000000C3");
    await expect(page.getByRole("alert")).toContainText(dataCopy.byReason.CROSS_ISP ?? "");
    expect(crossIspRows(DEMO_WORLD.ispId).length).toBeGreaterThanOrEqual(2);
    const direct = await backend.call("orders.timeline", await idTokenOf(page), { workOrderId: "wo-24817-g07" });
    expect(direct.status).toBe(403);
  });

  test("[FL-081] an operator changed by hand in the token is no session: the BFF refuses it and the console asks to sign in again", async ({ page }) => {
    await as(page, "GUEST", "/app/orders");
    await expect(page.getByRole("table", { name: ordersCopy.caption })).toBeVisible();
    const forged = await page.evaluate((key) => {
      const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}") as { idToken: string };
      const [header, payload, signature] = stored.idToken.split(".");
      const claims = JSON.parse(atob((payload ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
      claims.ispId = "isp-demo";
      claims["custom:ispId"] = "isp-demo";
      const encoded = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const idToken = `${header}.${encoded}.${signature}`;
      sessionStorage.setItem(key, JSON.stringify({ ...stored, idToken }));
      return idToken;
    }, TOKENS_KEY);
    const refused = await backend.call("orders.list", forged);
    expect(refused.status).toBe(401);
    await page.goto("/app/orders/wo-24817");
    await expect(page.getByText("Calle Jacaranda 214")).toHaveCount(0);
    await expect(page.getByRole("alert").getByText(dataCopy.byKind.unauthorized)).toBeVisible();
    await expect(page.getByRole("button", { name: dataCopy.unauthorized.signIn })).toBeVisible();
  });
});
