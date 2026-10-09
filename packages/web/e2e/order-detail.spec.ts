// FL-080 and FL-044 in the browser (docs/test-plan.md §3, level UI): the detail of order 24817 against the
// real router over the seeded world plus the first visit of the main story (e2e/support/
// story.ts): the timeline with the voice note's transcript and its audio behind a 5-minute link, the
// reply's citation linked to the manual, the photo verdicts with their reason, the step, the decision with
// its rule and the assistant's note; the ONU live; and the manual validation of a rejected photo by a
// supervisor, with the password prompt when the sign-in is too old, never offered to operations staff.
import { type Page, expect, test } from "@playwright/test";
import { loginCopy } from "../src/views/login/copy";
import { detailCopy } from "../src/views/order-detail/copy";
import { evidenceCopy } from "../src/views/evidence/copy";
import { type ConsoleBackend, signIn, startConsoleBackend } from "./support/console-backend";
import { DEMO_WORLD, STORY_NOTE, STORY_REPLY, STORY_TRANSCRIPT, seedOrderStory } from "./support/story";
import { expectReadableScreen } from "./support/a11y";
import { type Account, type AccountRole, E2E_CLIENT_ID, E2E_POOL_ID, addAccount, createPool } from "./support/accounts";
import { routeCognito } from "./support/cognito";

const DETAIL = "/app/orders/wo-24817";
let backend: ConsoleBackend;

test.beforeEach(async ({ page, baseURL }) => {
  backend = await startConsoleBackend({ pageOrigin: baseURL ?? "", userPoolId: E2E_POOL_ID, clientId: E2E_CLIENT_ID });
  await backend.attach(page);
  await seedOrderStory(backend.app, DEMO_WORLD);
});

test.afterEach(async () => {
  await backend.close();
});

async function as(page: Page, role: AccountRole): Promise<Account> {
  const pool = createPool();
  const account = await addAccount(pool, { role, name: role === "OPS" ? "Operaciones de prueba" : "Adriana de prueba" });
  await routeCognito(page, pool);
  await signIn(page, DETAIL, account);
  await expect(page.getByRole("heading", { level: 1, name: detailCopy.title("24817") })).toBeVisible();
  return account;
}

const timeline = (page: Page) => page.getByRole("list", { name: detailCopy.sections.timeline });
const checklistRow = (page: Page, item: string) => page.locator(`#orden-checklist li`).filter({ hasText: item });

test.describe("the detail of an order [FL-080]", () => {
  test("[FL-080] the timeline: voice note with transcript and audio, the reply citing the manual, photos with verdict, step, decision with rules and the internal note", async ({ page }) => {
    await as(page, "SUPERVISOR");
    await expect(timeline(page)).toContainText(STORY_TRANSCRIPT);
    await expect(timeline(page)).toContainText(STORY_REPLY);
    await expect(timeline(page)).toContainText(STORY_NOTE);
    await expect(timeline(page)).toContainText("Reflejo sobre la etiqueta o la pantalla");
    await expect(timeline(page)).toContainText("Dudosa");
    await expect(timeline(page).getByText("CP-QUIET-HOURS")).toBeVisible();
    await expect(timeline(page).getByText("VAL-CONFIDENCE")).toBeVisible();

    const citation = timeline(page).getByRole("link", { name: "§DIAG-02" }).first();
    await expect(citation).toHaveAttribute("href", "/app/manual/DIAG-02");

    // The audio arrives behind a GET link of the BFF (5 minutes), never as a key of S3.
    const link = page.waitForResponse((response) => response.url().includes("/api/") && response.url().includes("orders.mediaUrl"));
    await timeline(page).getByRole("button", { name: detailCopy.timeline.listen }).click();
    await link;
    const audio = timeline(page).locator("audio");
    await expect(audio).toHaveAttribute("src", /\/s3\/Media\/audio\/.+\.ogg\?/);
    const status = await page.evaluate(async (src) => (await fetch(src)).status, (await audio.getAttribute("src")) ?? "");
    expect(status).toBe(200);

    await expect(page.locator("#orden-linea-de-tiempo")).toContainText(detailCopy.timeline.pending);
    await expect(page.locator("#orden-linea-de-tiempo")).toContainText("Inicio del día");
    await expectReadableScreen(page);
  });

  test("[FL-080] the timeline's filters, the photo of a verdict, the ONU live and the summary", async ({ page }) => {
    await as(page, "SUPERVISOR");
    await page.getByRole("button", { name: /^Fotos y pasos/ }).click();
    await expect(timeline(page).locator(":scope > li")).toHaveCount(3);
    await timeline(page).getByRole("button", { name: detailCopy.checklist.viewPhoto }).first().click();
    const photo = timeline(page).getByRole("img", { name: /Foto: Foto de la etiqueta/ });
    await expect(photo).toBeVisible();
    await expect.poll(() => photo.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByRole("button", { name: /^Decisiones y notas/ }).click();
    await expect(timeline(page).locator(":scope > li")).toHaveCount(2);

    const onu = page.locator("#orden-onu");
    await expect(onu).toContainText("En línea");
    await expect(onu).toContainText("−21,4 dBm");
    await expect(onu).toContainText(detailCopy.onu.inRange);
    const summary = page.locator("#orden-resumen");
    await expect(summary).toContainText("Calle Jacaranda 214, Las Lomitas");
    await expect(summary).toContainText("−25 a −8 dBm");
    await expect(page.locator("#orden-acta")).toContainText(detailCopy.certificate.none);
  });
});

test.describe("manual validation from the detail [FL-044]", () => {
  test("[FL-044] a supervisor validates the rejected label photo by hand, with a reason; the item is marked and the agent is told", async ({ page }) => {
    await as(page, "SUPERVISOR");
    const label = checklistRow(page, "Foto de la etiqueta");
    await expect(label).toContainText("Rechazado");
    await label.getByRole("button", { name: evidenceCopy.manual.open }).click();
    const dialog = page.getByRole("dialog", { name: evidenceCopy.manual.title("Foto de la etiqueta", "24817") });
    await dialog.getByRole("button", { name: evidenceCopy.manual.submit }).click();
    await expect(dialog.getByText(evidenceCopy.manual.tooShort)).toBeVisible();
    await dialog.getByLabel(evidenceCopy.manual.reason).fill("El serial se lee completo en la foto, el reflejo no lo tapa");
    await dialog.getByRole("button", { name: evidenceCopy.manual.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(evidenceCopy.manual.done("Foto de la etiqueta"))).toBeVisible();
    await expect(label).toContainText("Validado manualmente");
    await expect(label).toContainText("Adriana de prueba");
    await expect(label.getByRole("button", { name: evidenceCopy.manual.open })).toHaveCount(0);
    expect(backend.app.ports.queued).toEqual([expect.objectContaining({ type: "AGENT_TURN", trigger: "EVIDENCE_OVERRIDDEN", workOrderId: "wo-24817", installerId: "inst-rogelio" })]);
    await expectReadableScreen(page);
  });

  test("[FL-044] a sign-in older than 15 minutes: the password prompt opens in place, then the validation goes through", async ({ page }) => {
    const account = await as(page, "SUPERVISOR");
    const deps = backend.app.deps as { wallClock: () => Date };
    const realClock = deps.wallClock;
    deps.wallClock = () => new Date(Date.now() + 20 * 60_000);
    await checklistRow(page, "Foto del medidor").getByRole("button", { name: evidenceCopy.manual.open }).click();
    const dialog = page.getByRole("dialog", { name: evidenceCopy.manual.title("Foto del medidor", "24817") });
    await dialog.getByLabel(evidenceCopy.manual.reason).fill("La lectura se ve completa, −21,4 dBm a 1490 nm");
    await dialog.getByRole("button", { name: evidenceCopy.manual.submit }).click();

    const prompt = page.getByRole("dialog", { name: loginCopy.stepUp.title });
    await expect(prompt).toBeVisible();
    expect(backend.app.ports.queued).toEqual([]);
    deps.wallClock = realClock;
    await prompt.getByLabel(loginCopy.credentials.password, { exact: true }).fill(account.password);
    await prompt.getByRole("button", { name: loginCopy.credentials.submit }).click();
    await expect(prompt.getByText(loginCopy.stepUp.done)).toBeVisible();
    await prompt.getByRole("button", { name: loginCopy.close }).first().click();

    await expect(dialog.getByLabel(evidenceCopy.manual.reason)).toHaveValue("La lectura se ve completa, −21,4 dBm a 1490 nm");
    await dialog.getByRole("button", { name: evidenceCopy.manual.submit }).click();
    await expect(checklistRow(page, "Foto del medidor")).toContainText("Validado manualmente");
    expect(backend.app.ports.queued).toHaveLength(1);
  });

  test("[FL-044] operations staff see the checklist and never the manual validation", async ({ page }) => {
    await as(page, "OPS");
    await expect(checklistRow(page, "Foto de la etiqueta")).toContainText("Rechazado");
    await expect(page.getByRole("button", { name: evidenceCopy.manual.open })).toHaveCount(0);
    await expect(page.getByText(detailCopy.checklist.readOnly)).toBeVisible();
    await expectReadableScreen(page);
  });
});
