// FL-051, FL-055 and FL-065 in the browser (docs/test-plan.md §3, level UI): the cases inbox and the detail
// of a case against the real router. The escalated case of the guest's world comes from its scene
// "caso-con-respaldo" (the real world factory and ladder): Adriana notified and timed out, Héctor notified
// with the timeout pending, the zone chief ahead. "Tomar" and "Cerrar" queue the same action a
// supervisor's button runs, in the installer's order of events; operations staff only look. A case of an
// undelivered certificate lives only in the console.
import { type Page, expect, test } from "@playwright/test";
import { casesCopy } from "../src/views/cases/copy";
import { type ConsoleBackend, idTokenOf, signIn, startConsoleBackend } from "./support/console-backend";
import { DEMO_WORLD, seedCase } from "./support/story";
import { expectReadableScreen } from "./support/a11y";
import { type AccountRole, E2E_CLIENT_ID, E2E_POOL_ID, addAccount, createPool } from "./support/accounts";
import { routeCognito } from "./support/cognito";

const INBOX = "/app/cases";
const UNDELIVERED = "case-01K7S7XRY000000000000000C1";
const TAKEN = "case-01K7S7XRY000000000000000C2";
let backend: ConsoleBackend;

test.beforeEach(async ({ page, baseURL }) => {
  backend = await startConsoleBackend({ pageOrigin: baseURL ?? "", userPoolId: E2E_POOL_ID, clientId: E2E_CLIENT_ID });
  await backend.attach(page);
});

test.afterEach(async () => {
  await backend.close();
});

async function as(page: Page, role: AccountRole, path = INBOX): Promise<void> {
  const pool = createPool();
  await routeCognito(page, pool);
  await signIn(page, path, await addAccount(pool, { role, name: role === "GUEST" ? "Invitado de prueba" : "Supervisión de prueba" }));
}

const inbox = (page: Page) => page.getByRole("table", { name: casesCopy.caption });

/** The guest's world at the scene where the case went to the backup supervisor; its case id. */
async function sceneCase(page: Page): Promise<string> {
  const token = await idTokenOf(page);
  const jumped = await backend.call("clock.jumpToScene", token, { sceneId: "caso-con-respaldo" }, "POST");
  expect(jumped.status).toBe(200);
  const listed = await backend.call<{ result: { data: Array<{ caseId: string }> } }>("cases.list", token);
  const caseId = listed.body.result.data[0]?.caseId;
  if (caseId === undefined) throw new Error("the scene opened no case");
  return caseId;
}

test.describe("the cases inbox and the ladder [FL-065] [FL-055]", () => {
  test("[FL-065] the inbox lists the open case with its reason, order, installer and rung; the detail draws the ladder rung by rung", async ({ page }) => {
    await as(page, "GUEST");
    await sceneCase(page);
    await page.reload();
    const row = inbox(page).getByRole("row").filter({ hasText: "Tres pasos de diagnóstico sin resolver" });
    await expect(row).toContainText("Orden 24818");
    await expect(row).toContainText("Rogelio Méndez");
    await expect(row).toContainText("Supervisión de respaldo");
    await expect(row).toContainText("Abierto");
    await expectReadableScreen(page);

    await row.click();
    await expect(page.getByRole("heading", { level: 1, name: casesCopy.detail.title("Tres pasos de diagnóstico sin resolver") })).toBeVisible();
    const ladder = page.getByRole("list", { name: casesCopy.detail.ladder });
    const rungs = ladder.locator(":scope > li");
    await expect(rungs).toHaveCount(3);
    await expect(rungs.nth(0)).toContainText("Adriana Solís");
    await expect(rungs.nth(0)).toContainText("Notificado");
    await expect(rungs.nth(0)).toContainText("Venció sin respuesta");
    await expect(rungs.nth(0)).toContainText("plantilla de WhatsApp");
    await expect(rungs.nth(1)).toContainText("Héctor Ibarra");
    await expect(rungs.nth(1)).toContainText(casesCopy.detail.current);
    await expect(rungs.nth(1)).toContainText(casesCopy.detail.timeoutAt("12:10"));
    await expect(rungs.nth(2)).toContainText("Marisol Cárdenas");
    await expect(rungs.nth(2)).toContainText(casesCopy.detail.ahead);
    await expect(page.locator("#caso-puente")).toContainText("Escalé tu caso a Adriana");
    await expect(page.getByRole("link", { name: casesCopy.detail.openOrder("24818") })).toHaveAttribute("href", "/app/orders/wo-24818-g07");
    await expectReadableScreen(page);
  });

  test("[FL-065] Tomar from the console queues the take in the installer's order of events", async ({ page }) => {
    await as(page, "GUEST");
    const caseId = await sceneCase(page);
    await page.goto(`${INBOX}/${caseId}`);
    await page.getByRole("button", { name: casesCopy.detail.take }).click();
    await expect(page.getByText(casesCopy.detail.takeQueued)).toBeVisible();
    expect(backend.app.ports.queued).toEqual([expect.objectContaining({ type: "SUPERVISOR_ACTION", action: "TAKE_CASE", caseId, installerId: "inst-rogelio-g07" })]);
    await expect(page.getByRole("button", { name: casesCopy.detail.close })).toHaveCount(0);
  });

  test("[FL-055] a taken case: who holds it, the brief and the bridge's messages; Cerrar queues the close", async ({ page }) => {
    await seedCase(backend.app, DEMO_WORLD, { caseId: TAKEN, workOrderNumber: "24818", reason: "DIAGNOSIS_ATTEMPTS", status: "TAKEN", rung: "SECONDARY" });
    const thread = { ispId: "isp-demo", clockId: "GLOBAL#isp-demo", channel: "WHATSAPP", caseId: TAKEN, workOrderId: "wo-24818", simulated: true } as const;
    await backend.app.memory.connector.conversations.appendMessage({ ...thread, messageId: "msg-case-brief", personId: "sup-hector", direction: "OUT", content: "TEXT", kind: "CASE_BRIEF", text: "Caso de Rogelio, orden 24818: potencia fuera de rango después de 3 pasos.", status: "DELIVERED", author: "SYSTEM", sentAtSim: "2026-10-13T12:02:00-06:00" });
    await backend.app.memory.connector.conversations.appendMessage({ ...thread, messageId: "msg-case-notice", personId: "inst-rogelio", direction: "OUT", content: "TEXT", kind: "CASE_NOTICE", text: "Héctor tomó tu caso.", status: "DELIVERED", author: "SYSTEM", sentAtSim: "2026-10-13T12:02:00-06:00" });
    await as(page, "SUPERVISOR", `${INBOX}/${TAKEN}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Tres pasos de diagnóstico sin resolver");
    const bridge = page.locator("#caso-puente");
    await expect(bridge).toContainText("Resumen del caso");
    await expect(bridge).toContainText("potencia fuera de rango después de 3 pasos");
    await expect(bridge).toContainText("Héctor tomó tu caso.");
    await page.getByRole("button", { name: casesCopy.detail.close }).click();
    await expect(page.getByText(casesCopy.detail.closeQueued)).toBeVisible();
    expect(backend.app.ports.queued).toEqual([expect.objectContaining({ type: "SUPERVISOR_ACTION", action: "CLOSE_CASE", caseId: TAKEN, supervisorId: "sup-hector" })]);
    await expectReadableScreen(page);
  });

  test("[FL-065] operations staff see the cases and never take or close one; the BFF refuses them too", async ({ page }) => {
    await seedCase(backend.app, DEMO_WORLD, { caseId: TAKEN, workOrderNumber: "24818", reason: "DIAGNOSIS_ATTEMPTS" });
    await as(page, "OPS", `${INBOX}/${TAKEN}`);
    await expect(page.getByText(casesCopy.detail.readOnly)).toBeVisible();
    await expect(page.getByRole("button", { name: casesCopy.detail.take })).toHaveCount(0);
    const refused = await backend.call("cases.take", await idTokenOf(page), { caseId: TAKEN }, "POST");
    expect(refused.status).toBe(403);
    expect(backend.app.ports.queued).toEqual([]);
  });
});

test.describe("a certificate that never arrived [FL-051]", () => {
  test("[FL-051] the case of an undelivered certificate lives only in the console, marked as such, with nothing sent by WhatsApp", async ({ page }) => {
    await seedCase(backend.app, DEMO_WORLD, { caseId: UNDELIVERED, workOrderNumber: "24831", reason: "CERTIFICATE_UNDELIVERED", installer: "inst-beatriz" });
    await as(page, "SUPERVISOR");
    const row = inbox(page).getByRole("row").filter({ hasText: "El acta no llegó al cliente" });
    await expect(row).toContainText(casesCopy.consoleOnly);
    await expect(row).toContainText("Beatriz Salazar");
    await page.getByLabel(casesCopy.reasonLabel).selectOption({ label: "El acta no llegó al cliente (1)" });
    await expect(inbox(page).getByRole("row")).toHaveCount(2);
    await row.click();
    await expect(page.getByText(casesCopy.detail.consoleOnlyNote)).toBeVisible();
    await expect(page.locator("#caso-puente")).toContainText(casesCopy.detail.noMessages);
    await expectReadableScreen(page);
  });
});
