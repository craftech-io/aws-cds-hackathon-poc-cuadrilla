// The motion of the landing (FL-089, docs/landing-spec.md §3 and §9.1, WCAG 2.2.2): the hero's product
// loop over the captured frames of the installer's phone plays, pauses with its visible control (and with
// hover, focus inside it, leaving the viewport and a hidden tab), stops by itself after two rounds and
// rests on the final frame; with reduced motion it is the final frame with its text alternative and no
// control. The voice note's words are only in that text alternative. Every scene of the walkthrough shows
// its captures, loaded, by the time the visitor reaches it; the goals that count up land on their value.
import { type Page, expect, test } from "@playwright/test";
import { storyEntry } from "../../bff/src/story/main-story";
import { LANDING_COPY } from "../src/views/landing/copy";
import { routeConsoleApi } from "./support/console-api";

const NEUTRAL_BRAND = { mode: "neutral", displayName: "Operadora ficticia de prueba", logos: { onLight: null, onDark: null }, disclaimer: null };
const VOICE_NOTE = storyEntry("s1-voice-note");

function context() {
  const use = test.info().project.use;
  const lang = use.locale?.startsWith("en") ? ("en" as const) : ("es" as const);
  return { lang, copy: LANDING_COPY[lang], param: lang === "en" ? "en" : "es-MX", reduced: use.reducedMotion === "reduce", desktop: (use.viewport?.width ?? 0) >= 1024 };
}

async function open(page: Page): Promise<void> {
  await routeConsoleApi(page, { brand: NEUTRAL_BRAND });
  await page.goto(`/?lang=${context().param}`);
  await expect(page.locator("#hero h1")).toBeVisible();
  await page.locator("#hero [data-playing]").scrollIntoViewIfNeeded();
}

const loop = (page: Page) => page.locator("#hero [data-playing]");
/** The `src` of the frame of the loop on screen (the one at full opacity). */
const shownFrame = (page: Page) => loop(page).locator("div.opacity-100 img").first().getAttribute("src");
const FINAL_FRAME = /\/landing\/captures\/hero-loop-/;

test.describe("hero loop", () => {
  test("[FL-089] plays, and its visible control pauses and plays it", async ({ page }) => {
    const { copy, reduced } = context();
    test.skip(reduced, "the loop only plays without reduced motion");
    await page.clock.install();
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
    const before = await shownFrame(page);
    await page.clock.runFor(8_000);
    expect(await shownFrame(page)).toBe(before);
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

  test("[FL-089] stops by itself after two rounds and rests on the final frame; the voice note's words are only its summary", async ({ page }) => {
    const { copy, reduced, lang } = context();
    test.skip(reduced, "the loop only plays without reduced motion");
    await page.clock.install();
    await open(page);
    await page.mouse.move(1, 1);
    await expect(loop(page)).toHaveAttribute("data-playing", "true");
    for (let step = 0; step < 16; step += 1) await page.clock.runFor(4_000);
    await expect(loop(page)).toHaveAttribute("data-still", "true");
    await expect(loop(page)).toHaveAttribute("data-playing", "false");
    expect(await shownFrame(page)).toMatch(FINAL_FRAME);
    await expect(page.getByRole("button", { name: copy.hero.loop.play })).toBeVisible();
    await expect(page.locator("#hero p.sr-only")).toContainText(lang === "en" ? VOICE_NOTE.glossEn : VOICE_NOTE.text);
    for (const alt of await loop(page).locator("img").evaluateAll((images) => images.map((image) => image.getAttribute("alt")))) expect(alt).toBe("");
  });

  test("[FL-089] with reduced motion: the final frame, its summary and no control", async ({ page }) => {
    const { copy, reduced, lang } = context();
    test.skip(!reduced, "only with reduced motion");
    await open(page);
    await expect(loop(page)).toHaveAttribute("data-still", "true");
    await expect(loop(page)).toHaveAttribute("data-playing", "false");
    await expect(loop(page).locator("img")).toHaveCount(1);
    expect(await shownFrame(page)).toMatch(FINAL_FRAME);
    await expect(page.getByRole("button", { name: copy.hero.loop.pause })).toHaveCount(0);
    await expect(page.getByRole("button", { name: copy.hero.loop.play })).toHaveCount(0);
    await expect(page.locator("#hero p.sr-only")).toContainText(lang === "en" ? VOICE_NOTE.glossEn : VOICE_NOTE.text);
  });
});

test.describe("the loop and the walkthrough never wait on the visitor", () => {
  test("[FL-089] the hero's first frame is requested at once, before the loop is in view or plays", async ({ page }) => {
    await routeConsoleApi(page, { brand: NEUTRAL_BRAND });
    await page.goto(`/?lang=${context().param}`);
    await expect(page.locator("#hero h1")).toBeVisible();
    // No scrolling, no waiting: on a phone the loop is still below the fold here.
    const first = loop(page).locator("img").first();
    await expect(first).toHaveAttribute("loading", "eager");
    await expect.poll(() => first.evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  });

  test("[FL-089] every scene shows its captures, loaded, once scrolled into place", async ({ page }) => {
    const { desktop } = context();
    await routeConsoleApi(page, { brand: NEUTRAL_BRAND });
    await page.goto(`/?lang=${context().param}`);
    await expect(page.locator("#hero h1")).toBeVisible();
    // Jumps, not the page's smooth scrolling: the fastest a visitor can get there.
    await page.evaluate(() => document.documentElement.style.setProperty("scroll-behavior", "auto"));
    for (const scene of ["S1", "S2", "S3", "S4", "S5", "S6"]) {
      const visual = page.locator(`[role="group"][aria-labelledby="scene-${scene}"]`);
      if (desktop) await page.locator(`#scene-${scene}`).scrollIntoViewIfNeeded();
      else await visual.evaluate((element) => element.scrollIntoView({ block: "end" }));
      const images = visual.locator("[data-scene-captures] img");
      await expect(images.first(), scene).toBeVisible();
      await expect
        .poll(() => images.evaluateAll((all) => all.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)), { message: scene })
        .toBe(true);
    }
  });

  test("[FL-089] the goals that count up land exactly on their value and stay there", async ({ page }) => {
    const { copy } = context();
    await routeConsoleApi(page, { brand: NEUTRAL_BRAND });
    await page.goto(`/?lang=${context().param}`);
    const impact = page.locator("#impacto");
    await impact.scrollIntoViewIfNeeded();
    const finals = copy.impact.items.map((item) => `${item.prefix}${item.value}${item.suffix}`);
    for (const text of finals) await expect(impact.getByText(text, { exact: true })).toBeVisible();
    await page.waitForTimeout(1_500);
    for (const text of finals) await expect(impact.getByText(text, { exact: true })).toBeVisible();
  });
});
