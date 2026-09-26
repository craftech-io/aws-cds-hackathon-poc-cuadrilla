// The motion of the landing (FL-089, docs/landing-spec.md §3 and §9.1, WCAG 2.2.2): the hero's product
// loop plays, pauses with its visible control (and with hover, focus inside it, leaving the viewport and
// a hidden tab), stops by itself after two rounds and rests on the final frame; with reduced motion it
// is a still poster with its text alternative and no control. The voice note never shows its words.
import { type Page, expect, test } from "@playwright/test";
import { storyEntry } from "../../bff/src/story/main-story";
import { LANDING_COPY } from "../src/views/landing/copy";
import { routeConsoleApi } from "./support/console-api";

const NEUTRAL_BRAND = { mode: "neutral", displayName: "Operadora ficticia de prueba", logos: { onLight: null, onDark: null }, disclaimer: null };
const VOICE_NOTE = storyEntry("s1-voice-note");

function context() {
  const use = test.info().project.use;
  const lang = use.locale?.startsWith("en") ? ("en" as const) : ("es" as const);
  return { lang, copy: LANDING_COPY[lang], param: lang === "en" ? "en" : "es-MX", reduced: use.reducedMotion === "reduce" };
}

async function open(page: Page): Promise<void> {
  await routeConsoleApi(page, { brand: NEUTRAL_BRAND });
  await page.goto(`/?lang=${context().param}`);
  await expect(page.locator("#hero h1")).toBeVisible();
  await page.locator("#hero [data-playing]").scrollIntoViewIfNeeded();
}

const loop = (page: Page) => page.locator("#hero [data-playing]");
/** Messages of the loop's phone already on screen. */
const shownMessages = (page: Page) => page.locator("#hero ol > li:not([aria-hidden='true'])");

test.describe("hero loop", () => {
  test("[FL-089] plays, and its visible control pauses and plays it", async ({ page }) => {
    const { copy, reduced } = context();
    test.skip(reduced, "the loop only plays without reduced motion");
    await open(page);
    await page.mouse.move(1, 1);
    await expect(loop(page)).toHaveAttribute("data-playing", "true");
    const pause = page.getByRole("button", { name: copy.hero.loop.pause });
    const box = await pause.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await pause.click();
    // Away from the loop and without the focus in it: only the control keeps it paused.
    await page.mouse.move(1, 1);
    await page.getByRole("button", { name: copy.hero.loop.play }).blur();
    await expect(loop(page)).toHaveAttribute("data-playing", "false");
    const before = await shownMessages(page).count();
    await page.waitForTimeout(2_500);
    expect(await shownMessages(page).count()).toBe(before);
    await page.getByRole("button", { name: copy.hero.loop.play }).click();
    await page.mouse.move(1, 1);
    await page.getByRole("button", { name: copy.hero.loop.pause }).blur();
    await expect(loop(page)).toHaveAttribute("data-playing", "true");
  });

  test("[FL-089] pauses on hover, on focus inside it, out of the viewport and in a hidden tab", async ({ page }) => {
    const { copy, reduced } = context();
    test.skip(reduced, "the loop only plays without reduced motion");
    await open(page);
    await page.mouse.move(1, 1);
    await expect(loop(page)).toHaveAttribute("data-playing", "true");
    await loop(page).hover();
    await expect(loop(page)).toHaveAttribute("data-playing", "false");
    await page.mouse.move(1, 1);
    await expect(loop(page)).toHaveAttribute("data-playing", "true");
    await page.getByRole("button", { name: copy.hero.loop.pause }).focus();
    await expect(loop(page)).toHaveAttribute("data-playing", "false");
    await page.getByRole("button", { name: copy.hero.loop.pause }).blur();
    await expect(loop(page)).toHaveAttribute("data-playing", "true");
    await page.locator("#integracion").scrollIntoViewIfNeeded();
    await expect(loop(page)).toHaveAttribute("data-playing", "false");
    await loop(page).scrollIntoViewIfNeeded();
    await expect(loop(page)).toHaveAttribute("data-playing", "true");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(loop(page)).toHaveAttribute("data-playing", "false");
  });

  test("[FL-089] stops by itself after two rounds and rests on the final frame, voice note without its words", async ({ page }) => {
    const { copy, reduced } = context();
    test.skip(reduced, "the loop only plays without reduced motion");
    await page.clock.install();
    await open(page);
    await page.mouse.move(1, 1);
    await expect(loop(page)).toHaveAttribute("data-playing", "true");
    for (let step = 0; step < 16; step += 1) await page.clock.runFor(4_000);
    await expect(loop(page)).toHaveAttribute("data-still", "true");
    await expect(loop(page)).toHaveAttribute("data-playing", "false");
    await expect(shownMessages(page)).toHaveCount(6);
    await expect(page.getByRole("button", { name: copy.hero.loop.play })).toBeVisible();
    const phoneText = await page.locator("#hero ol").innerText();
    expect(phoneText).not.toContain(VOICE_NOTE.text);
  });

  test("[FL-089] with reduced motion: a still poster of the final frame, its summary and no control", async ({ page }) => {
    const { copy, reduced, lang } = context();
    test.skip(!reduced, "only with reduced motion");
    await open(page);
    await expect(loop(page)).toHaveAttribute("data-still", "true");
    await expect(loop(page)).toHaveAttribute("data-playing", "false");
    await expect(shownMessages(page)).toHaveCount(6);
    await expect(page.getByRole("button", { name: copy.hero.loop.pause })).toHaveCount(0);
    await expect(page.getByRole("button", { name: copy.hero.loop.play })).toHaveCount(0);
    const summary = page.locator("#hero p.sr-only");
    await expect(summary).toContainText(lang === "en" ? VOICE_NOTE.glossEn : VOICE_NOTE.text);
    expect(await page.locator("#hero ol").innerText()).not.toContain(VOICE_NOTE.text);
  });
});
