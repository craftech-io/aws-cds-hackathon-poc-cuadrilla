// FL-001, FL-005, FL-007 and FL-008 in the browser (docs/test-plan.md §3, level UI): Personal against the
// real `appRouter` of the local UI server (tests/ui-server, started for this spec's worker on a free port:
// Vite with the real sources, the in-memory world seeded from scripts/seed/data and the guest worlds of the
// `guest` template). The sign-in is the console's own against the route mock of Cognito. A guest of
// `isp-guest-07` adds an installer (synthetic phone of the world's block, poster with the QR), meets the
// refusals of a phone already taken and of a real phone, deactivates a person and changes a crew's roster;
// operations staff of the demo world only look, and see the opt-out of a person who sent BAJA.
import type { Page } from "@playwright/test";
import { peopleCopy } from "../src/views/people/copy";
import { expectReadableScreen } from "./support/a11y";
import { expect, signIn, test } from "./support/ui-server";

// One worker (and one UI server, one world) per file and project: the tests share the world in order.
test.describe.configure({ mode: "default" });

/** A phone of `isp-guest-07`'s synthetic block (+52 55 0207 0xxx) the seed does not use. */
let slot = Math.floor(Math.random() * 50);
function freshPhone(): string {
  slot = (slot + 1) % 100;
  return `+52 55 0207 09${String(slot).padStart(2, "0")}`;
}

const copy = peopleCopy;

async function newInstaller(page: Page, phone: string, lastName: string): Promise<void> {
  await page.getByRole("button", { name: copy.newPerson }).click();
  const drawer = page.getByRole("dialog", { name: copy.drawer.newTitle });
  await drawer.getByLabel(copy.form.firstName).fill("Lucía");
  await drawer.getByLabel(copy.form.lastName).fill(lastName);
  await drawer.getByLabel(copy.form.phone).fill(phone);
  await drawer.getByRole("button", { name: copy.form.save }).click();
}

test.describe("Personal", () => {
  test("[FL-001] a guest adds an installer of the world's synthetic block and gets the join poster with its QR", async ({ page }) => {
    await signIn(page, "GUEST", "/app/people");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectReadableScreen(page);
    const lastName = `Prueba${Date.now() % 100_000}`;
    await newInstaller(page, freshPhone(), lastName);
    const panel = page.getByRole("dialog", { name: `Lucía ${lastName}` });
    await expect(panel.getByText(copy.form.created)).toBeVisible();
    await expect(panel.getByText(copy.allowList.active)).toBeVisible();
    await expect(panel.getByText(copy.optIn.none, { exact: true })).toBeVisible();
    await expect(panel.getByText(copy.poster.keyword)).toBeVisible();
    await expect(panel.getByRole("img", { name: copy.poster.qr("Lucía") })).toBeVisible();
    await expect(panel.getByText(copy.poster.simulated)).toBeVisible();
    await expect(panel.getByText(/\+52\*+\d{4}/)).toBeVisible();
    await panel.getByRole("button", { name: copy.drawer.close }).click();
    await expect(page.getByRole("table").getByText(`Lucía ${lastName}`)).toBeVisible();
  });

  test("[FL-001] the same phone twice in the world is a conflict, and a phone outside the synthetic block is refused", async ({ page }) => {
    await signIn(page, "GUEST", "/app/people");
    const phone = freshPhone();
    await newInstaller(page, phone, `Uno${Date.now() % 100_000}`);
    await expect(page.getByText(copy.form.created)).toBeVisible();
    await page.keyboard.press("Escape");
    await newInstaller(page, phone, `Dos${Date.now() % 100_000}`);
    await expect(page.getByText(copy.reasons.CONFLICT ?? "")).toBeVisible();
    const drawer = page.getByRole("dialog", { name: copy.drawer.newTitle });
    await drawer.getByLabel(copy.form.phone).fill("+52 55 1234 5678");
    await drawer.getByRole("button", { name: copy.form.save }).click();
    await expect(page.getByText(copy.reasons.PHONE_NOT_SYNTHETIC ?? "")).toBeVisible();
  });

  test("[FL-008] a guest deactivates an installer: it leaves the allow list and its open orders of the day come back for reassignment", async ({ page }) => {
    await signIn(page, "GUEST", "/app/people");
    await page.getByRole("table").getByText("Beatriz Salazar").click();
    const panel = page.getByRole("dialog", { name: "Beatriz Salazar" });
    await panel.getByLabel(copy.drawer.deactivateReason).fill("Ya no trabaja con la operadora");
    await panel.getByRole("button", { name: copy.drawer.deactivate }).click();
    await expect(panel.getByText(copy.drawer.deactivated)).toBeVisible();
    await expect(panel.getByText(copy.drawer.reassign(2))).toBeVisible();
    await expect(panel.getByText(copy.allowList.inactive)).toBeVisible();
    await panel.getByRole("button", { name: copy.drawer.activate }).click();
    await expect(panel.getByText(copy.drawer.activated)).toBeVisible();
    await expect(panel.getByText(copy.allowList.active)).toBeVisible();
  });

  test("[FL-007] a guest changes the supervisor on duty of a crew for the world's day", async ({ page }) => {
    await signIn(page, "GUEST", "/app/people");
    const roster = page.getByRole("region", { name: copy.roster.title });
    await expect(roster.getByText(copy.roster.primary).first()).toBeVisible();
    const primary = roster.getByLabel(copy.roster.primary);
    const secondary = roster.getByLabel(copy.roster.secondary);
    const before = await primary.inputValue();
    const after = await secondary.inputValue();
    await primary.selectOption(after);
    await secondary.selectOption(before);
    await roster.getByRole("button", { name: copy.roster.save }).click();
    await expect(roster.getByText(copy.roster.saved)).toBeVisible();
    await expect(roster.getByLabel(copy.roster.primary)).toHaveValue(after);
  });

  test("[FL-005] [FL-008] operations staff see the staff with their opt-in and opt-out, and cannot change anyone", async ({ page }) => {
    await signIn(page, "OPS", "/app/people");
    await expect(page.getByRole("table").getByText("Rogelio Méndez")).toBeVisible();
    await expect(page.getByRole("table").getByText(/Con opt-in desde/).first()).toBeVisible();
    await expect(page.getByRole("table").getByText(/Dado de baja/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: copy.newPerson })).toHaveCount(0);
    await expect(page.getByText(copy.onlySupervisors)).toBeVisible();
    await page.getByRole("table").getByText("Rogelio Méndez").click();
    const panel = page.getByRole("dialog", { name: "Rogelio Méndez" });
    await expect(panel.getByRole("button", { name: copy.drawer.deactivate })).toHaveCount(0);
    await expectReadableScreen(page);
  });
});
