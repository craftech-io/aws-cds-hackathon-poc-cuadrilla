// FL-080 in the browser (docs/test-plan.md §3, level UI): the day's work orders against the real router
// over the seeded world (e2e/support/console-backend.ts): order 24817 pinned as the main
// story, the crew and the day of the scope, the status and open-cases filters, the checklist marks and
// the ONU of each row, and a row that opens the order's detail. The sign-in is the console's own against
// the route mock of Cognito.
import { expect, test } from "@playwright/test";
import { ordersCopy } from "../src/views/orders/copy";
import { type ConsoleBackend, signIn, startConsoleBackend } from "./support/console-backend";
import { DEMO_WORLD, seedCase, seedOrderStory } from "./support/story";
import { expectReadableScreen } from "./support/a11y";
import { E2E_CLIENT_ID, E2E_POOL_ID, addAccount, createPool } from "./support/accounts";
import { routeCognito } from "./support/cognito";

let backend: ConsoleBackend;

test.beforeEach(async ({ page, baseURL }) => {
  backend = await startConsoleBackend({ pageOrigin: baseURL ?? "", userPoolId: E2E_POOL_ID, clientId: E2E_CLIENT_ID });
  await backend.attach(page);
});

test.afterEach(async () => {
  await backend.close();
});

async function asSupervisor(page: Parameters<typeof signIn>[0]): Promise<void> {
  const pool = createPool();
  const supervisor = await addAccount(pool, { role: "SUPERVISOR", name: "Supervisora de prueba" });
  await routeCognito(page, pool);
  await signIn(page, "/app/orders", supervisor);
}

const table = (page: Parameters<typeof signIn>[0]) => page.getByRole("table", { name: ordersCopy.caption });
const rowOf = (page: Parameters<typeof signIn>[0], number: string) => table(page).getByRole("row").filter({ hasText: number });

test.describe("the day's work orders [FL-080]", () => {
  test("[FL-080] order 24817 comes first as the main story, with its installer, fictitious customer, window, checklist and ONU", async ({ page }) => {
    await seedOrderStory(backend.app, DEMO_WORLD);
    await asSupervisor(page);
    await expect(page.getByRole("heading", { level: 1, name: ordersCopy.title })).toBeVisible();
    const rows = table(page).getByRole("row");
    await expect(rows.nth(1)).toContainText("24817");
    await expect(rows.nth(1)).toContainText(ordersCopy.mainStory);
    const story = rowOf(page, "24817");
    await expect(story).toContainText("Rogelio Méndez");
    await expect(story).toContainText("Lucía Treviño");
    await expect(story).toContainText("09:00–11:00");
    await expect(story.getByRole("img", { name: "Foto de la etiqueta: Rechazado" })).toBeVisible();
    await expect(story.getByRole("img", { name: "Foto del medidor: En revisión" })).toBeVisible();
    await expect(story).toContainText(ordersCopy.onuUnknown);
    // The crew reads as its name, never as its id.
    await expect(page.getByLabel(ordersCopy.scope.crews)).toContainText("Equipo Norte 3");
    await expectReadableScreen(page);
  });

  test("[FL-080] the filters: open cases, status and crew narrow the list and say how many each leaves", async ({ page }) => {
    await seedCase(backend.app, DEMO_WORLD, { caseId: "case-01K7S7XRY000000000000000C1", workOrderNumber: "24818", reason: "DIAGNOSIS_ATTEMPTS" });
    await asSupervisor(page);
    await expect(rowOf(page, "24817")).toBeVisible();
    const total = (await table(page).getByRole("row").count()) - 1;
    expect(total).toBe(13);

    await page.getByRole("button", { name: `${ordersCopy.filters.cases.WITH_CASES} (1)` }).click();
    await expect(table(page).getByRole("row")).toHaveCount(2);
    await expect(rowOf(page, "24818")).toContainText(ordersCopy.openCases(1));

    await page.getByRole("button", { name: `${ordersCopy.filters.cases.ALL} (${total})` }).click();
    await page.getByRole("button", { name: `${ordersCopy.filters.status.CLOSED} (0)` }).click();
    await expect(page.getByText(ordersCopy.emptyTitle)).toBeVisible();
    await page.getByRole("button", { name: `${ordersCopy.filters.status.ALL} (${total})` }).click();

    await page.getByLabel(ordersCopy.scope.crews).selectOption({ label: "Equipo Sur 1" });
    await expect(rowOf(page, "24817")).toHaveCount(0);
    await expect(rowOf(page, "24830")).toBeVisible();
    await expectReadableScreen(page);
  });

  test("[FL-080] the day of the scope: yesterday's closed orders, then back to the world's day", async ({ page }) => {
    await asSupervisor(page);
    await expect(rowOf(page, "24817")).toBeVisible();
    await page.getByLabel(ordersCopy.scope.day).selectOption({ label: "lun 12/10" });
    await expect(rowOf(page, "24801")).toBeVisible();
    await expect(rowOf(page, "24801")).toContainText("Cerrada");
    await expect(rowOf(page, "24817")).toHaveCount(0);
    await page.getByLabel(ordersCopy.scope.day).selectOption({ label: `mar 13/10 (${ordersCopy.scope.today})` });
    await expect(rowOf(page, "24817")).toBeVisible();
  });

  test("[FL-080] a row opens the order's detail, by click and by keyboard", async ({ page }) => {
    await asSupervisor(page);
    await rowOf(page, "24817").click();
    await expect(page).toHaveURL(/\/app\/orders\/wo-24817$/);
    await expect(page.getByRole("heading", { level: 1, name: "Orden 24817" })).toBeVisible();
    await page.goBack();
    await rowOf(page, "24820").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Orden 24820" })).toBeVisible();
  });
});
