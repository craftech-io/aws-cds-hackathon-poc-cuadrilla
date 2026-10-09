// FL-088 in the browser (docs/test-plan.md §3, level UI): the decisions log against the real `appRouter` of
// the local UI server (tests/ui-server, started for this spec's worker on a free port). The guest world's
// seeded decisions with their action, actor and reason in words; the zero of the violations next to the
// decisions per rule and the blocks by origin; the filters by decision and by rule. A guest then makes the
// product decide in other views (an email outside the world's fence refused in Personal, a scene jump in
// the demo clock) and finds both decisions here, filterable, with the rule that decided.
import type { Page } from "@playwright/test";
import { expectReadableScreen } from "./support/a11y";
import { expect, signIn, test } from "./support/ui-server";
import { copy as consoleCopy } from "../src/copy/console";
import { auditCopy } from "../src/views/audit/copy";
import { clockCopy } from "../src/views/clock/copy";
import { peopleCopy } from "../src/views/people/copy";

// One worker (and one UI server, one world) per file and project: the tests share the world in order.
test.describe.configure({ mode: "default" });

const copy = auditCopy;

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const decisions = (page: Page) => region(page, copy.list.title).getByRole("table");

test.describe("Bitácora", () => {
  test("[FL-088] the world's decisions with action, actor and reason in words; 0 violations next to the decisions per rule", async ({ page }) => {
    await signIn(page, "GUEST", "/app/audit");
    await expect(page.getByRole("heading", { level: 1, name: consoleCopy.views.audit.title })).toBeVisible();
    const summary = region(page, copy.summary.title);
    await expect(summary.getByText(copy.summary.violations)).toBeVisible();
    await expect(page.getByText(copy.violations.none)).toBeVisible();
    await expect(region(page, copy.byRule.title)).toBeVisible();
    await expect(region(page, copy.blocks.title)).toBeVisible();
    await expect(decisions(page).getByRole("cell", { name: copy.actions.SEND_WHATSAPP ?? "", exact: true }).first()).toBeVisible();
    await expect(decisions(page).getByRole("cell", { name: copy.actors.AGENT ?? "", exact: true }).first()).toBeVisible();
    await expectReadableScreen(page);

    await region(page, copy.list.title).getByRole("button", { name: copy.decisions.ACTION ?? "" }).click();
    await expect(decisions(page).getByRole("cell", { name: copy.actions.EVIDENCE_OVERRIDDEN ?? "", exact: true }).first()).toBeVisible();
    await expect(decisions(page).getByRole("cell", { name: copy.actions.SEND_WHATSAPP ?? "", exact: true })).toHaveCount(0);
    await expect(decisions(page).getByRole("cell", { name: copy.actors.USER ?? "", exact: true }).first()).toBeVisible();
  });

  test("[FL-088] a refusal of the email fence decided in Personal shows here with its rule, its reason and its origin", async ({ page }) => {
    await signIn(page, "GUEST", "/app/people");
    await page.getByRole("button", { name: peopleCopy.newPerson }).click();
    const drawer = page.getByRole("dialog", { name: peopleCopy.drawer.newTitle });
    await drawer.getByLabel(peopleCopy.form.firstName).fill("Iván");
    await drawer.getByLabel(peopleCopy.form.lastName).fill(`Cerco${Date.now() % 100_000}`);
    await drawer.getByLabel(peopleCopy.form.phone).fill(`+52 55 0207 08${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`);
    await drawer.getByLabel(peopleCopy.form.email).fill("ivan@example.com");
    await drawer.getByRole("button", { name: peopleCopy.form.save }).click();
    await expect(drawer.getByText(peopleCopy.reasons.RECIPIENT_NOT_ALLOWED ?? "")).toBeVisible();

    await page.goto("/app/audit");
    await region(page, copy.list.title).getByRole("button", { name: copy.decisions.DENY ?? "" }).click();
    const row = decisions(page).getByRole("row").filter({ hasText: copy.actions.PERSON_UPSERT ?? "" }).first();
    await expect(row).toContainText(copy.decisionBadge.DENY ?? "");
    await expect(row).toContainText("CP-RECIPIENT-FENCE");
    await expect(row).toContainText(copy.reasons.RECIPIENT_NOT_ALLOWED ?? "");
    await expect(row).toContainText(copy.actors.USER ?? "");
    await expect(region(page, copy.byRule.title).getByRole("row").filter({ hasText: "CP-RECIPIENT-FENCE" })).toBeVisible();
    await expect(region(page, copy.blocks.title).getByRole("row").filter({ hasText: copy.blocks.origins.FENCE ?? "" })).toBeVisible();

    await region(page, copy.list.title).getByRole("button", { name: copy.decisions.ALL ?? "" }).click();
    await region(page, copy.list.title).getByLabel(copy.list.rule).selectOption("CP-RECIPIENT-FENCE");
    await expect(decisions(page).getByRole("row").filter({ hasText: copy.actions.SEND_WHATSAPP ?? "" })).toHaveCount(0);
    await expect(decisions(page).getByRole("row").filter({ hasText: copy.actions.PERSON_UPSERT ?? "" }).first()).toBeVisible();
    await expectReadableScreen(page);
  });

  test("[FL-088] a scene jump from the demo clock is a decision of the console's user", async ({ page }) => {
    await signIn(page, "GUEST", "/app/clock");
    const scenes = page.getByRole("region", { name: clockCopy.scenes.title, exact: true });
    await scenes.getByRole("button", { name: `${clockCopy.scenes.jump}: Inicio del día (07:00)` }).click();
    await expect(scenes.getByText(clockCopy.scenes.jumped("Inicio del día (07:00)"))).toBeVisible();
    await page.goto("/app/audit");
    await region(page, copy.list.title).getByRole("button", { name: copy.decisions.ACTION ?? "" }).click();
    const row = decisions(page).getByRole("row").filter({ hasText: copy.actions.WORLD_SCENE_JUMP ?? "" }).first();
    await expect(row).toContainText(copy.actors.USER ?? "");
  });
});
