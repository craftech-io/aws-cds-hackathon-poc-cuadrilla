// The guided-tour panel in the browser (docs/test-plan.md §3, level UI; docs/design-brief.md §15; FL-084,
// FL-085, FL-087) against the real `appRouter` of the local UI server (tests/ui-server, started for this
// spec's worker on a free port): the express and the full tour from views/tour/steps.ts in Spanish and
// English with their estimate, "Qué mirar" with the hours of the world's pending timers, a step's button
// run through `tour.run` (a clock move, a view it opens), "Saltar a escena" through `clock.jumpToScene`,
// the buttons waiting while the world is busy, and no scenes outside a guest world. The UI server runs no
// worker, so the events a move queues keep the world busy until a scene of the demo clock clears it.
import type { Page } from "@playwright/test";
import { expectReadableScreen } from "./support/a11y";
import { expect, signIn, test } from "./support/ui-server";
import { copy as consoleCopy } from "../src/copy/console";
import { clockCopy } from "../src/views/clock/copy";
import { tourCopy } from "../src/views/tour/copy";
import { TOUR_STEPS } from "../src/views/tour/steps";

// One worker (and one UI server, one world) per file and project: the tests share the world in order.
test.describe.configure({ mode: "default" });

async function openTour(page: Page) {
  await page.getByRole("button", { name: consoleCopy.tour.open }).click();
  return page.getByRole("complementary", { name: consoleCopy.tour.title });
}

/** The card of a step by its label ("Paso 1", "Step 1"), never the one of "Paso 10". */
const stepCard = (panel: ReturnType<Page["getByRole"]>, id: string) =>
  panel.getByRole("listitem").filter({ has: panel.page().getByText(new RegExp(`^(${tourCopy.es.step(id)}|${tourCopy.en.step(id)})$`)) });

/** Clears what a move left queued: the demo clock's scene before the day starts. */
async function quietWorld(page: Page): Promise<void> {
  await page.goto("/app/clock");
  const scenes = page.getByRole("region", { name: clockCopy.scenes.title, exact: true });
  await scenes.getByRole("button", { name: `${clockCopy.scenes.jump}: Inicio del día (07:00)` }).click();
  await expect(scenes.getByText(clockCopy.scenes.jumped("Inicio del día (07:00)"))).toBeVisible();
}

test.describe("Recorrido guiado", () => {
  test("[FL-084] both tours from the single source, in Spanish and English, with their estimate and the world's hours", async ({ page }) => {
    await signIn(page, "GUEST", "/app/orders");
    const panel = await openTour(page);
    const es = tourCopy.es;
    // The panel starts in the browser's language: in an English project it is switched to Spanish first.
    const toggle = panel.getByRole("button", { name: new RegExp(`^(${es.language}|${tourCopy.en.language})$`) });
    if ((await toggle.textContent()) !== es.otherLanguage) await toggle.click();
    await expect(panel.getByRole("button", { name: "Recorrido exprés (~5 min)" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Recorrido completo (~15 min)" })).toBeVisible();
    for (const step of TOUR_STEPS.EXPRESS) await expect(stepCard(panel, step.stepId).getByRole("heading", { name: step.title.es })).toBeVisible();
    await panel.getByRole("button", { name: "Recorrido completo (~15 min)" }).click();
    await expect(panel.getByRole("listitem")).toHaveCount(TOUR_STEPS.FULL.length);
    await expect(stepCard(panel, "1")).toContainText("el inicio del día pendiente a las 07:30");
    await expect(stepCard(panel, "9")).toContainText("vence a las 12:00");
    await expectReadableScreen(page);

    await panel.getByRole("button", { name: es.language }).click();
    await expect(panel.getByRole("button", { name: "Full tour (~15 min)" })).toBeVisible();
    await expect(stepCard(panel, "1").getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(stepCard(panel, "1")).toContainText("the start of the day pending at 07:30");
    await expect(panel.locator("[lang=en]").first()).toBeVisible();
  });

  test("[FL-087] the last step's button opens the metrics", async ({ page }) => {
    await signIn(page, "GUEST", "/app/orders");
    const panel = await openTour(page);
    await panel.getByRole("button", { name: /Recorrido completo|Full tour/ }).click();
    await stepCard(panel, "13").getByRole("button", { name: /Hacer este paso|Do this step/ }).click();
    await expect(page).toHaveURL(/\/app\/metrics$/);
    await expect(page.getByRole("heading", { level: 1, name: consoleCopy.views.metrics.title })).toBeVisible();
    await expect(stepCard(panel, "13")).toContainText(/Listo|Done/);
  });

  test("[FL-084] [FL-085] the button of 'Iniciar el día' moves the clock to 07:30, and the other buttons wait while the world is busy", async ({ page }) => {
    await signIn(page, "GUEST", "/app/orders");
    const panel = await openTour(page);
    await panel.getByRole("button", { name: /Recorrido completo|Full tour/ }).click();
    await stepCard(panel, "2").getByRole("button", { name: /Hacer este paso|Do this step/ }).click();
    await expect(page.getByRole("region", { name: consoleCopy.clock.label })).toContainText("mar 13/10 07:30");
    await expect(panel.getByText(/El mundo está ocupado; los botones|The world is busy; the buttons/)).toBeVisible();
    await expect(stepCard(panel, "3").getByRole("button", { name: /Hacer este paso|Do this step/ })).toBeDisabled();
    await expect(stepCard(panel, "3").getByRole("button", { name: /Saltar a escena|Jump to scene/ })).toBeDisabled();
    await quietWorld(page);
  });

  test("[FL-084] 'Saltar a escena' loads the scene of the step", async ({ page }) => {
    await signIn(page, "GUEST", "/app/orders");
    const panel = await openTour(page);
    await panel.getByRole("button", { name: /Recorrido exprés|Express tour/ }).click();
    const card = stepCard(panel, "X3");
    await card.getByRole("button", { name: /Saltar a escena: Checklist completo \(10:00\)|Jump to scene: Checklist complete \(10:00\)/ }).click();
    await expect(card).toContainText(/Escena cargada: Checklist completo \(10:00\)\.|Scene loaded: Checklist complete \(10:00\)\./);
    await expect(page.getByRole("region", { name: consoleCopy.clock.label })).toContainText("mar 13/10 10:00");
    await quietWorld(page);
  });

  test("[FL-084] outside a guest world the tour has no scenes, and says so", async ({ page }) => {
    await signIn(page, "SUPERVISOR", "/app/orders");
    const panel = await openTour(page);
    await expect(panel.getByText(/«Saltar a escena» está disponible|“Jump to scene” is available/)).toBeVisible();
    await expect(panel.getByRole("button", { name: /Saltar a escena|Jump to scene/ })).toHaveCount(0);
  });
});
