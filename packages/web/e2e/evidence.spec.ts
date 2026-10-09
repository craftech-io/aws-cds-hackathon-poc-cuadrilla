// FL-043 and FL-044 in the browser (docs/test-plan.md §3, level UI): the evidence review against the real
// router over the seeded world plus the first visit of the main story (e2e/support/story.ts):
// the meter photo the validator was unsure about comes first with its rubric, readings, confidence and the
// check that hardened it; the label photo rejected for glare after it. A supervisor or a guest validates
// by hand with a required reason; operations staff only look, and the BFF refuses them too.
import { type Page, expect, test } from "@playwright/test";
import { evidenceCopy } from "../src/views/evidence/copy";
import { type ConsoleBackend, idTokenOf, signIn, startConsoleBackend } from "./support/console-backend";
import { DEMO_WORLD, GUEST_07_WORLD, seedOrderStory } from "./support/story";
import { expectReadableScreen } from "./support/a11y";
import { type AccountRole, E2E_CLIENT_ID, E2E_POOL_ID, addAccount, createPool } from "./support/accounts";
import { routeCognito } from "./support/cognito";

const PATH = "/app/evidence";
let backend: ConsoleBackend;

test.beforeEach(async ({ page, baseURL }) => {
  backend = await startConsoleBackend({ pageOrigin: baseURL ?? "", userPoolId: E2E_POOL_ID, clientId: E2E_CLIENT_ID });
  await backend.attach(page);
});

test.afterEach(async () => {
  await backend.close();
});

async function as(page: Page, role: AccountRole): Promise<void> {
  const pool = createPool();
  await routeCognito(page, pool);
  await signIn(page, PATH, await addAccount(pool, { role, name: role === "GUEST" ? "Invitado de prueba" : "Supervisión de prueba" }));
  await expect(page.getByRole("heading", { level: 1, name: evidenceCopy.title })).toBeVisible();
}

const cards = (page: Page) => page.getByRole("list", { name: evidenceCopy.caption }).locator(":scope > li");

test.describe("evidence review [FL-043]", () => {
  test("[FL-043] the unsure photo first, with the photo, the rubric and what the validator said; the rejected one after it", async ({ page }) => {
    await seedOrderStory(backend.app, DEMO_WORLD);
    await as(page, "SUPERVISOR");
    await expect(cards(page)).toHaveCount(2);
    const unsure = cards(page).first();
    await expect(unsure.getByRole("heading", { name: "Foto del medidor · Orden 24817" })).toBeVisible();
    await expect(unsure).toContainText("En revisión");
    await expect(unsure).toContainText(evidenceCopy.unsureNote);
    await expect(unsure).toContainText("Dudosa");
    await expect(unsure).toContainText("41 %");
    await expect(unsure).toContainText("−21,4 dBm");
    await expect(unsure).toContainText("1490 nm");
    await expect(unsure).toContainText("La pantalla completa del medidor de potencia óptica");
    await expect(unsure.getByText("VAL-CONFIDENCE")).toBeVisible();
    const photo = unsure.getByRole("img", { name: evidenceCopy.photoAlt("Foto del medidor", "24817") });
    await expect.poll(() => photo.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const rejected = cards(page).nth(1);
    await expect(rejected).toContainText("Foto de la etiqueta");
    await expect(rejected).toContainText("Reflejo sobre la etiqueta o la pantalla");
    await expect(rejected).toContainText(evidenceCopy.attempts(1));
    await expect(rejected.getByRole("link", { name: evidenceCopy.openOrder })).toHaveAttribute("href", "/app/orders/wo-24817");
    await expectReadableScreen(page);

    await page.getByRole("button", { name: `${evidenceCopy.filters.UNSURE} (1)` }).click();
    await expect(cards(page)).toHaveCount(1);
    await page.getByRole("button", { name: `${evidenceCopy.filters.REJECTED} (1)` }).click();
    await expect(cards(page).first()).toContainText("Foto de la etiqueta");
  });

  test("[FL-043] nothing to review: an empty queue says so", async ({ page }) => {
    await as(page, "SUPERVISOR");
    await expect(page.getByText(evidenceCopy.emptyTitle)).toBeVisible();
    await expectReadableScreen(page);
  });
});

test.describe("manual validation in the review [FL-044]", () => {
  test("[FL-044] a guest validates the unsure photo of its own world by hand; it leaves the queue and the agent is told", async ({ page }) => {
    await seedOrderStory(backend.app, GUEST_07_WORLD);
    await as(page, "GUEST");
    await expect(cards(page)).toHaveCount(2);
    await cards(page).first().getByRole("button", { name: evidenceCopy.manual.open }).click();
    const dialog = page.getByRole("dialog", { name: evidenceCopy.manual.title("Foto del medidor", "24817") });
    await expect(dialog).toContainText(evidenceCopy.manual.lead);
    await dialog.getByLabel(evidenceCopy.manual.reason).fill("La pantalla se lee completa en la foto");
    await dialog.getByRole("button", { name: evidenceCopy.manual.submit }).click();
    await expect(page.getByText(evidenceCopy.manual.done("Foto del medidor"))).toBeVisible();
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText("Foto de la etiqueta");
    expect(backend.app.ports.queued).toEqual([expect.objectContaining({ type: "AGENT_TURN", trigger: "EVIDENCE_OVERRIDDEN", clockId: "GUEST#isp-guest-07", workOrderId: "wo-24817-g07" })]);
  });

  test("[FL-044] the reason is required: nothing is sent without it, and cancelling changes nothing", async ({ page }) => {
    await seedOrderStory(backend.app, DEMO_WORLD);
    await as(page, "SUPERVISOR");
    await cards(page).nth(1).getByRole("button", { name: evidenceCopy.manual.open }).click();
    const dialog = page.getByRole("dialog", { name: evidenceCopy.manual.title("Foto de la etiqueta", "24817") });
    await dialog.getByLabel(evidenceCopy.manual.reason).fill(" ");
    await dialog.getByRole("button", { name: evidenceCopy.manual.submit }).click();
    await expect(dialog.getByText(evidenceCopy.manual.tooShort)).toBeVisible();
    await dialog.getByRole("button", { name: evidenceCopy.manual.cancel }).click();
    await expect(dialog).toBeHidden();
    await expect(cards(page)).toHaveCount(2);
    expect(backend.app.ports.queued).toEqual([]);
  });

  test("[FL-044] operations staff see the queue and never validate; the BFF refuses them as well", async ({ page }) => {
    await seedOrderStory(backend.app, DEMO_WORLD);
    await as(page, "OPS");
    await expect(cards(page)).toHaveCount(2);
    await expect(page.getByRole("button", { name: evidenceCopy.manual.open })).toHaveCount(0);
    await expect(page.getByText(evidenceCopy.readOnly)).toBeVisible();
    const refused = await backend.call("evidence.override", await idTokenOf(page), { workOrderId: "wo-24817", item: "ONU_LABEL_PHOTO", reason: "Revisado en sitio" }, "POST");
    expect(refused.status).toBe(403);
    expect(backend.app.ports.queued).toEqual([]);
    await expectReadableScreen(page);
  });
});
