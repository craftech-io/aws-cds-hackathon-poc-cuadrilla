// FL-087 in the browser (docs/test-plan.md §3, level UI): the metrics against the real `appRouter` of the
// local UI server (tests/ui-server, started for this spec's worker on a free port). The five tabs with
// their KPIs, each with its N, source and label; p50 and p95, the day's use of the global ceiling and the
// state of the cut; the policy's zero; "Exportar CSV". What the product measures reads "medición" and no
// internal id of a run ever shows (ADR-0023). A published run of the manual's measurement cannot be made
// from the browser, so its figures are the server's answer with a run's KPIs put on its way to the page.
import type { Page } from "@playwright/test";
import { expectReadableScreen } from "./support/a11y";
import { expect, signIn, test } from "./support/ui-server";
import type { Route } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { copy as consoleCopy } from "../src/copy/console";
import { metricsCopy } from "../src/views/metrics/copy";

// One worker (and one UI server, one world) per file and project: the tests share the world in order.
test.describe.configure({ mode: "default" });

const copy = metricsCopy;

const TABS = ["Este mundo", "Medición del manual", "Medición de fotos", "Latencia y costo", "Política"];

const tab = (page: Page, name: string) => page.getByRole("group", { name: copy.tabs }).getByRole("button", { name, exact: true });

/** `metrics.summary` with a published run of the manual's measurement (N = 50) in its tab. */
async function publishedManualRun(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/api/") && url.pathname.includes("metrics.summary"),
    async (route: Route) => {
      const response = await route.fetch();
      const paths = new URL(route.request().url()).pathname.slice("/api/".length).split(",");
      const body = (await response.json()) as unknown;
      const items = (Array.isArray(body) ? body : [body]) as Array<{ result?: { data?: { tabs: Array<{ tab: string; kpis: Array<Record<string, unknown>> }> } } }>;
      paths.forEach((path, index) => {
        const manual = path === "metrics.summary" ? items[index]?.result?.data?.tabs.find((candidate) => candidate.tab === "MANUAL") : undefined;
        if (manual === undefined) return;
        const source = { es: "medición del manual (N = 50)", en: "manual measurement (N = 50)" };
        manual.kpis = [
          { id: "resolvedWithCitation", label: { es: "Resueltas sin escalar con cita correcta", en: "" }, value: 0.825, unit: "RATIO", n: 40, source, kind: "MEASURED", target: "≥ 70 %" },
          { id: "escalatedWithoutInventing", label: { es: "Escaladas sin inventar", en: "" }, value: 1, unit: "RATIO", n: 10, source, kind: "MEASURED", target: "100 %" },
        ];
      });
      await route.fulfill({ response, json: Array.isArray(body) ? items : items[0] });
    },
  );
}

test.describe("Métricas", () => {
  test("[FL-087] five tabs named as measurements, every KPI with its N, source and label, and no internal id", async ({ page }) => {
    await signIn(page, "GUEST", "/app/metrics");
    await expect(page.getByRole("heading", { level: 1, name: consoleCopy.views.metrics.title })).toBeVisible();
    for (const name of TABS) await expect(tab(page, name)).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Este mundo" })).toBeVisible();
    await expect(page.getByText(/N = \d+ · fuente: este mundo/).first()).toBeVisible();
    await expect(page.getByText(/rótulo: (medido|agente guionado|supuesto)/).first()).toBeVisible();
    await tab(page, "Medición del manual").click();
    await expect(page.getByRole("heading", { level: 2, name: "Medición del manual" })).toBeVisible();
    await expect(page.getByText("Resueltas sin escalar con cita correcta")).toBeVisible();
    await expect(page.getByText(/todavía sin corrida publicada/).first()).toBeVisible();
    const text = (await page.locator("main").innerText()).toLowerCase();
    expect(text).not.toMatch(/evaluaci|evaluation|ev-0\d/);
    await expectReadableScreen(page);
  });

  test("[FL-087] latency and cost: p50 and p95, the day's use of the global ceiling and the state of the cut", async ({ page }) => {
    await signIn(page, "SUPERVISOR", "/app/metrics");
    await tab(page, "Latencia y costo").click();
    await expect(page.getByText("Tiempo a primera respuesta p50")).toBeVisible();
    await expect(page.getByText("Tiempo a primera respuesta p95")).toBeVisible();
    await expect(page.getByText("Duración del turno p95")).toBeVisible();
    await expect(page.getByText(/Consumo del techo global/).first()).toBeVisible();
    await expect(page.getByText(copy.cutOff)).toBeVisible();
    await tab(page, "Política").click();
    await expect(page.getByText("Violaciones de política")).toBeVisible();
    await expectReadableScreen(page);
  });

  test("[FL-087] a published run of the manual's measurement shows its figures with N = 50, its targets and its label", async ({ page }) => {
    await publishedManualRun(page);
    await signIn(page, "GUEST", "/app/metrics");
    await tab(page, "Medición del manual").click();
    await expect(page.getByText("82,5 %")).toBeVisible();
    await expect(page.getByText("100 %", { exact: true })).toBeVisible();
    await expect(page.getByText("N = 40 · fuente: medición del manual (N = 50) · meta: ≥ 70 % · rótulo: medido")).toBeVisible();
  });

  test("[FL-087] Exportar CSV downloads the tab's figures with their N, source and label", async ({ page }) => {
    await signIn(page, "GUEST", "/app/metrics");
    await tab(page, "Política").click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: copy.export }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("metricas-policy.csv");
    const csv = await readFile(await file.path(), "utf8");
    expect(csv.split("\n")[0]).toBe("tab,kpi,label,value,unit,n,source,kind,target,note");
    expect(csv).toContain("Política,violations,Violaciones de política,");
    await expect(page.getByText(copy.exported("metricas-policy.csv"))).toBeVisible();
  });
});
