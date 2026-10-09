// FL-060, FL-084, FL-085 and FL-086 in the browser (docs/test-plan.md §3, level UI): the demo clock against
// the real `appRouter` of the local UI server (tests/ui-server, started for this spec's worker on a free
// port, with the in-memory world and the guest worlds of the `guest` template). A guest of `isp-guest-07`
// starts the day, moves the clock, turns the live clock on and off, sets a template's simulated state,
// jumps to the scenes of the tour, forces the timeout of an open case and resets its world; operations
// staff of the demo world see the clock without scenes or reset. The busy world (what it waits for, the
// controls closed, "Avanzar igual" after five minutes) is the real `clock.get` answer with its busy part
// rewritten on its way to the page, because the UI server has no worker to keep a world busy on demand.
import type { Page } from "@playwright/test";
import { expectReadableScreen } from "./support/a11y";
import { expect, signIn, test } from "./support/ui-server";
import type { Route } from "@playwright/test";
import { copy as consoleCopy } from "../src/copy/console";
import { clockCopy } from "../src/views/clock/copy";

// One worker (and one UI server, one world) per file and project: the tests share the world in order.
test.describe.configure({ mode: "default" });

const copy = clockCopy;

const section = (page: Page, title: string) => page.getByRole("region", { name: title, exact: true });

/** Every `clock.get` of the page (alone or in a batch) answers what the server says, with `patch` over it. */
async function rewriteClock(page: Page, patch: Readonly<Record<string, unknown>>): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith("/api/") && url.pathname.includes("clock.get"),
    async (route: Route) => {
      const response = await route.fetch();
      const paths = new URL(route.request().url()).pathname.slice("/api/".length).split(",");
      const body = (await response.json()) as unknown;
      const items = (Array.isArray(body) ? body : [body]) as Array<{ result?: { data?: Record<string, unknown> } }>;
      paths.forEach((path, index) => {
        const data = path === "clock.get" ? items[index]?.result?.data : undefined;
        if (data) Object.assign(data, patch);
      });
      await route.fulfill({ response, json: Array.isArray(body) ? items : items[0] });
    },
  );
}

/** A world busy with a transcription since `sinceReal`. */
const busyWorld = (page: Page, sinceReal: string) => rewriteClock(page, { busy: true, pending: [{ kind: "TRANSCRIBE", detail: "e2e", sinceReal }] });

test.describe("Reloj de demo", () => {
  test("[FL-084] [FL-085] a guest moves the clock, turns the live clock on and off, starts the day and sees its world busy with the day's events", async ({ page }) => {
    await signIn(page, "GUEST", "/app/clock");
    const now = section(page, copy.now.title);
    await expect(now).toContainText("mar 13/10 07:00");
    await expect(now).toContainText(copy.now.paused);
    await expect(now.getByText(copy.now.quiet)).toBeVisible();
    await expect(section(page, copy.events.title)).toContainText(copy.events.kinds.DAY_START);
    await expectReadableScreen(page);
    const move = section(page, copy.move.title);
    await move.getByRole("button", { name: "+10 min" }).click();
    await expect(move.getByText("Hora simulada: mar 13/10 07:10. Ningún evento vencía en el camino.")).toBeVisible();
    await expect(page.getByRole("region", { name: consoleCopy.clock.label })).toContainText("mar 13/10 07:10");
    await move.getByRole("button", { name: copy.move.live }).click();
    await expect(move.getByText(copy.move.liveOn)).toBeVisible();
    await expect(now).toContainText("En vivo hasta las");
    await move.getByRole("button", { name: copy.move.pause }).click();
    await expect(move.getByText(copy.move.liveOff)).toBeVisible();
    await expect(now).toContainText(copy.now.paused);

    await move.getByRole("button", { name: copy.move.startDay }).click();
    await expect(move.getByText(/Hora simulada: mar 13\/10 07:30\. Se dispararon \d+ eventos\./)).toBeVisible();
    // The day's starts went to the installers' queues: the world waits for them and the moves close.
    await expect(now.getByText(copy.now.busyTitle)).toBeVisible();
    await expect(now).toContainText(copy.now.pending.EVENT);
    for (const name of [copy.move.startDay, copy.move.next, "+10 min", "+1 h"]) await expect(move.getByRole("button", { name })).toBeDisabled();
    await expect(page.getByRole("region", { name: consoleCopy.clock.label })).toContainText(consoleCopy.clock.busy.EVENT);

    const scenes = section(page, copy.scenes.title);
    await scenes.getByRole("button", { name: `${copy.scenes.jump}: Inicio del día (07:00)` }).click();
    await expect(scenes.getByText(copy.scenes.jumped("Inicio del día (07:00)"))).toBeVisible();
    await expect(now.getByText(copy.now.quiet)).toBeVisible();
    await expect(now).toContainText("mar 13/10 07:00");
  });

  test("[FL-084] a guest sets the simulated state of a template to try the plan B", async ({ page }) => {
    await signIn(page, "GUEST", "/app/clock");
    const templates = section(page, copy.templates.title);
    await templates.getByLabel(copy.templates.template).selectOption({ label: copy.templates.names.caso_escalado });
    await templates.getByLabel(copy.templates.status).selectOption({ label: copy.templates.statuses.REJECTED });
    await templates.getByRole("button", { name: copy.templates.apply }).click();
    await expect(templates.getByText(copy.templates.applied(copy.templates.names.caso_escalado, copy.templates.statuses.REJECTED))).toBeVisible();
  });

  test("[FL-084] [FL-060] a guest jumps to the scene of the open case: the case on its rung, its timeout pending, the control closed while the world is busy", async ({ page }) => {
    await signIn(page, "GUEST", "/app/clock");
    const scenes = section(page, copy.scenes.title);
    await scenes.getByRole("button", { name: `${copy.scenes.jump}: Caso con la supervisora de turno (11:50)` }).click();
    await expect(scenes.getByText(copy.scenes.jumped("Caso con la supervisora de turno (11:50)"))).toBeVisible();
    await expect(section(page, copy.now.title)).toContainText("mar 13/10 11:50");
    await expect(section(page, copy.events.title)).toContainText(copy.events.kinds.CASE_TIMEOUT);
    const cases = section(page, copy.cases.title);
    await expect(cases.getByLabel(copy.cases.select)).toContainText(`Orden 24818 · ${copy.cases.reasons.DIAGNOSIS_ATTEMPTS} · ${copy.cases.rungs.PRIMARY}`);
    // The scene fired the day's starts on its way to 11:50; nothing consumes their events in the UI
    // server, so the world stays busy and the control waits, as it does on the stage while they run.
    await expect(section(page, copy.now.title).getByText(copy.now.busyTitle)).toBeVisible();
    await expect(cases.getByRole("button", { name: copy.cases.force })).toBeDisabled();
  });

  test("[FL-085] [FL-060] a control the BFF refuses because the world is busy says so in words", async ({ page }) => {
    // The page believes the world is quiet; the server knows it is not.
    await rewriteClock(page, { busy: false, pending: [] });
    await signIn(page, "GUEST", "/app/clock");
    const cases = section(page, copy.cases.title);
    await cases.getByRole("button", { name: copy.cases.force }).click();
    await expect(cases.getByText(copy.reasons.WORLD_BUSY ?? "")).toBeVisible();
    await expectReadableScreen(page);
  });

  test("[FL-084] a guest jumps to the scene of the complete checklist", async ({ page }) => {
    await signIn(page, "GUEST", "/app/clock");
    const scenes = section(page, copy.scenes.title);
    await expect(scenes.getByText(copy.scenes.description(30))).toBeVisible();
    await scenes.getByRole("button", { name: `${copy.scenes.jump}: Checklist completo (10:00)` }).click();
    await expect(scenes.getByText(copy.scenes.jumped("Checklist completo (10:00)"))).toBeVisible();
    await expect(section(page, copy.now.title)).toContainText("mar 13/10 10:00");
  });

  test("[FL-085] a busy world says what it waits for and since when; after five minutes it offers to advance anyway", async ({ page }) => {
    await signIn(page, "GUEST", "/app/clock");
    // A quiet world first (the scene before the day starts), so the forced move is the only thing that happens.
    const scenes = section(page, copy.scenes.title);
    await scenes.getByRole("button", { name: `${copy.scenes.jump}: Inicio del día (07:00)` }).click();
    await expect(scenes.getByText(copy.scenes.jumped("Inicio del día (07:00)"))).toBeVisible();
    await busyWorld(page, new Date(Date.now() - 30_000).toISOString());
    await page.reload();
    const now = section(page, copy.now.title);
    await expect(now.getByText(copy.now.busyTitle)).toBeVisible();
    await expect(now).toContainText("Transcribiendo una nota de voz (~15 s), desde hace menos de un minuto");
    const move = section(page, copy.move.title);
    for (const name of [copy.move.startDay, copy.move.next, "+10 min", "+1 h"]) await expect(move.getByRole("button", { name })).toBeDisabled();
    await expect(move.getByRole("button", { name: copy.move.force })).toHaveCount(0);
    await expect(page.getByRole("region", { name: consoleCopy.clock.label })).toContainText(consoleCopy.clock.busy.TRANSCRIBE);
    await expectReadableScreen(page);

    await page.unrouteAll({ behavior: "wait" });
    await busyWorld(page, new Date(Date.now() - 6 * 60_000).toISOString());
    await page.reload();
    await expect(section(page, copy.now.title).getByText(copy.now.forceLead)).toBeVisible();
    const force = section(page, copy.move.title).getByRole("button", { name: copy.move.force });
    await expect(force).toBeEnabled();
    await force.click();
    await expect(section(page, copy.move.title).getByText(/Hora simulada: mar 13\/10 07:30\. Se dispar/)).toBeVisible();
  });

  test("[FL-086] a guest resets its world after a confirmation, and the reset waits ten minutes before it opens again", async ({ page }) => {
    await signIn(page, "GUEST", "/app/clock");
    const reset = section(page, copy.reset.title);
    const epoch = Number((await section(page, copy.now.title).getByRole("definition").nth(2).textContent()) ?? "0");
    await reset.getByRole("button", { name: copy.reset.open }).click();
    await expect(reset.getByText(copy.reset.confirmLead)).toBeVisible();
    await reset.getByRole("button", { name: copy.reset.confirm }).click();
    await expect(reset.getByText(copy.reset.done)).toBeVisible();
    await expect(section(page, copy.now.title)).toContainText("mar 13/10 07:00");
    await expect(section(page, copy.now.title).getByRole("definition").nth(2)).toHaveText(String(epoch + 1));
    await expect(reset.getByRole("button", { name: copy.reset.open })).toBeDisabled();
    await expect(reset.getByText(/Podrás reiniciar de nuevo a las \d{2}:\d{2}/)).toBeVisible();
    await expectReadableScreen(page);
  });

  test("[FL-084] operations staff of the demo world see the clock and its events, without scenes or reset", async ({ page }) => {
    await signIn(page, "OPS", "/app/clock");
    await expect(section(page, copy.now.title)).toContainText("mar 13/10");
    await expect(section(page, copy.events.title)).toBeVisible();
    await expect(section(page, copy.scenes.title)).toHaveCount(0);
    await expect(section(page, copy.reset.title)).toHaveCount(0);
    await expect(page.getByText(copy.onlySupervisors)).toBeVisible();
    await expectReadableScreen(page);
  });
});
