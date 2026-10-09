// FL-028 and FL-090 in the browser (docs/test-plan.md §3, level UI): the manual viewer against the real
// `appRouter` of the local UI server (tests/ui-server, started for this spec's worker on a free port), whose
// manual is the repository's (scripts/seed/data/manual). The sections in force with their id, the text of
// a section with its cross references as links, the section a citation opens (`/app/manual/COM-04`, the
// one FL-028 cites), the operator's visible name and the synthetic-demo notice; the co-branding disclaimer
// is the server's answer with a fictitious partner put on its way to the page (the UI server is neutral).
import type { Page } from "@playwright/test";
import { expectReadableScreen } from "./support/a11y";
import { expect, signIn, test } from "./support/ui-server";
import type { Route } from "@playwright/test";
import { copy as consoleCopy } from "../src/copy/console";
import { manualCopy } from "../src/views/manual/copy";

// One worker (and one UI server, one world) per file and project: the tests share the world in order.
test.describe.configure({ mode: "default" });

const copy = manualCopy;

const PARTNER = "Fibra Socia de Prueba";
const DISCLAIMER = `Demo sintética: el manual, las políticas y los datos son inventados y no son las políticas reales de ${PARTNER}.`;

/** `manual.sections` with the operator in co-branding (a fictitious partner), the rest as the server says. */
async function cobranded(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/api/") && url.pathname.includes("manual.sections"),
    async (route: Route) => {
      const response = await route.fetch();
      const paths = new URL(route.request().url()).pathname.slice("/api/".length).split(",");
      const body = (await response.json()) as unknown;
      const items = (Array.isArray(body) ? body : [body]) as Array<{ result?: { data?: Record<string, unknown> } }>;
      paths.forEach((path, index) => {
        const data = path === "manual.sections" ? items[index]?.result?.data : undefined;
        if (data) data.operator = { operatorName: PARTNER, mode: "cobrand", disclaimer: { es: DISCLAIMER, en: DISCLAIMER }, notice: { es: DISCLAIMER, en: DISCLAIMER } };
      });
      await route.fulfill({ response, json: Array.isArray(body) ? items : items[0] });
    },
  );
}

test.describe("Manual", () => {
  test("[FL-090] the sections in force with their id, the operator's name and the synthetic-demo notice; a section opens with its links", async ({ page }) => {
    await signIn(page, "GUEST", "/app/manual");
    await expect(page.getByRole("heading", { level: 1, name: consoleCopy.views.manual.title })).toBeVisible();
    await expect(page.getByText(/^Manual de procedimientos de .+/)).toBeVisible();
    await expect(page.getByText(/Versión vigente: v1/)).toBeVisible();
    await expect(page.getByText(copy.choose)).toBeVisible();
    const sections = page.getByRole("navigation", { name: copy.sections });
    await expect(sections.getByText(copy.categories.SEG ?? "", { exact: true })).toBeVisible();
    await expectReadableScreen(page);
    await sections.getByRole("link", { name: "§COM-04 · Reubicación de la roseta" }).click();
    await expect(page).toHaveURL(/\/app\/manual\/COM-04$/);
    const article = page.getByRole("article");
    await expect(article.getByRole("heading", { name: "§COM-04 · Reubicación de la roseta" })).toBeVisible();
    await expect(article).toContainText("Hasta 15 m de cable interior");
    await article.getByRole("link", { name: "§COM-02", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/manual\/COM-02$/);
    await expect(page.getByRole("article").getByRole("heading", { name: /^§COM-02 · / })).toBeVisible();
  });

  test("[FL-028] the citation of an answer (Manual v1, §COM-04) opens its section in the viewer", async ({ page }) => {
    await signIn(page, "SUPERVISOR", "/app/manual/COM-04");
    await expect(page.getByRole("article").getByRole("heading", { name: "§COM-04 · Reubicación de la roseta" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: copy.sections }).getByRole("link", { name: "§COM-04 · Reubicación de la roseta" })).toHaveAttribute("aria-current", "page");
    await expectReadableScreen(page);
  });

  test("[FL-090] a section the manual in force does not have says so", async ({ page }) => {
    await signIn(page, "GUEST", "/app/manual/XYZ-99");
    await expect(page.getByText(copy.notFound)).toBeVisible();
  });

  test("[FL-090] in co-branding the viewer names the partner's operator and shows the mandatory disclaimer", async ({ page }) => {
    await cobranded(page);
    await signIn(page, "GUEST", "/app/manual/SEG-01");
    await expect(page.getByText(copy.operator(PARTNER))).toBeVisible();
    await expect(page.getByText(DISCLAIMER)).toBeVisible();
    await expect(page.getByRole("article")).toContainText("Detén el trabajo ahora.");
  });
});
