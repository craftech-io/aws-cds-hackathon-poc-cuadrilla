// FL-089 on the deployed stage (docs/test-plan.md §6.1, row "Landing es y en"): the commercial landing
// the stage serves, with its real brand (`brand.get`, runtime configuration), in the eight projects:
// the twelve blocks, the calls to action, no horizontal scroll from 360 to 1440 px, the primary call to
// action on the first screen at 360×640, the walkthrough (pinned or stacked), the goals labelled, the
// gallery with zoom, the hero's loop and its still poster with reduced motion, the LCP with a simulated
// 4G on the phone projects, no word of ADR-0023, and a screenshot of every block. Read-only: nothing
// here signs up.
import { type Page, type Response, expect, test } from "@playwright/test";
import { enGloss } from "../../../bff/src/copy/en-gloss";
import { esMX } from "../../../bff/src/copy/es-MX";
import { LANDING_COPY } from "../../src/views/landing/copy";
import { expectReadableScreen } from "../support/a11y";
import { expectNeutral, noHorizontalScroll, projectContext, shot } from "./support";

const BLOCKS = ["#top", "#hero", "#problema", "#recorrido", "#actores", "#confianza", "#impacto", "#integracion", "#real", "#galeria", "#empezar", "#footer"];

interface BrandAnswer {
  readonly mode?: string;
  readonly disclaimer?: { readonly es?: string; readonly en?: string } | null;
}

async function open(page: Page, query = ""): Promise<BrandAnswer | undefined> {
  const { param } = projectContext();
  const brand = page.waitForResponse((response: Response) => response.url().includes("/api/brand.get"), { timeout: 20_000 }).catch(() => undefined);
  const response = await page.goto(`/?lang=${param}${query}`);
  expect(response?.status()).toBe(200);
  await expect(page.locator("#hero h1")).toBeVisible();
  const answer = await brand;
  if (answer === undefined || answer.status() !== 200) return undefined;
  const body = (await answer.json()) as Array<{ result?: { data?: BrandAnswer } }> | { result?: { data?: BrandAnswer } };
  return (Array.isArray(body) ? body[0] : body)?.result?.data;
}

test.describe("deployed landing @public", () => {
  test("[FL-089] the twelve blocks with the brand of the stage, readable and neutral, one screenshot per block", async ({ page }) => {
    const { lang } = projectContext();
    const copy = LANDING_COPY[lang];
    const brand = await open(page);
    // `brand.get` arrives with the console's routers (WP-38); until then the web shows the neutral brand.
    test.info().annotations.push({ type: "brand", description: brand === undefined ? "brand.get not served: neutral fallback" : `brand.get mode ${brand.mode ?? "?"}` });
    if (brand === undefined || brand.mode !== "cobrand") await expect(page.locator("#hero")).toContainText(lang === "en" ? enGloss.fictitiousOperatorNotice : esMX.fictitiousOperatorNotice);
    await expect(page.locator("html")).toHaveAttribute("lang", copy.htmlLang);
    for (const block of BLOCKS) await expect(page.locator(block), block).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: copy.hero.title })).toBeVisible();
    for (const title of [copy.problem.title, copy.walkthrough.title, copy.actors.title, copy.trust.title, copy.impact.title, copy.integration.title, copy.real.title, copy.gallery.title, copy.finalCta.title]) {
      await expect(page.getByRole("heading", { level: 2, name: title })).toHaveCount(1);
    }
    // Co-branding carries the synthetic-demo notice in the hero, the "what is simulated" block and the footer.
    const disclaimer = brand?.mode === "cobrand" ? brand.disclaimer?.[lang] : undefined;
    if (brand?.mode === "cobrand") {
      expect(disclaimer, "co-branding comes with its disclaimer").toBeTruthy();
      for (const block of ["#hero", "#real", "#footer"]) await expect(page.locator(block)).toContainText(disclaimer ?? "");
    }
    await expectReadableScreen(page);
    await expectNeutral(page, "landing");
    await shot(page, "landing-first-screen");
    for (const block of BLOCKS) {
      await page.locator(block).scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await shot(page, `landing-block-${block.slice(1)}`, { selector: block });
    }
    await shot(page, "landing-full-page", { fullPage: true });
  });

  test("[FL-089] the calls to action keep the language on the way to the signup and the login, and reach Craftech", async ({ page }) => {
    const { lang, param } = projectContext();
    const copy = LANDING_COPY[lang];
    await open(page);
    for (const block of ["#hero", "#empezar"]) {
      const section = page.locator(block);
      await expect(section.getByRole("link", { name: copy.nav.tryDemo })).toHaveAttribute("href", `/signup?lang=${param}`);
      await expect(section.getByRole("link", { name: copy.nav.signIn, exact: true })).toHaveAttribute("href", `/login?lang=${param}`);
      const talk = section.getByRole("link", { name: new RegExp(copy.nav.talk) });
      await expect(talk).toHaveAttribute("href", "https://craftech.io/contact/");
      await expect(talk).toHaveAttribute("rel", /noopener/);
    }
    for (const target of await page.locator("#hero a, #empezar a, header nav a, header nav button, #footer nav a").all()) {
      if (!(await target.isVisible())) continue;
      const box = await target.boundingBox();
      expect(box?.height ?? 0, await target.innerText()).toBeGreaterThanOrEqual(44);
    }
    await page.locator("#hero").getByRole("link", { name: copy.nav.tryDemo }).click();
    await expect(page).toHaveURL(new RegExp(`/signup\\?lang=${param}`));
  });

  test("[FL-089] no horizontal scroll at 360, 768, 1024 and the project's width; the primary call to action on the first screen at 360×640", async ({ page }) => {
    const copy = LANDING_COPY[projectContext().lang];
    await open(page);
    await noHorizontalScroll(page);
    for (const width of [360, 768, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(200);
      await noHorizontalScroll(page);
    }
    await page.setViewportSize({ width: 360, height: 640 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await noHorizontalScroll(page);
    const primary = await page.locator("#hero").getByRole("link", { name: copy.nav.tryDemo }).boundingBox();
    expect((primary?.y ?? 999) + (primary?.height ?? 0)).toBeLessThanOrEqual(640);
    await shot(page, "landing-360x640-first-screen");
  });

  test("[FL-089] the walkthrough: six scenes in order, pinned with a changing visual on a desktop, stacked on a phone", async ({ page }) => {
    const { lang, desktop } = projectContext();
    const copy = LANDING_COPY[lang];
    await open(page);
    await expect(page.locator("#recorrido h3")).toHaveText(Object.values(copy.walkthrough.scenes).map((scene) => scene.title));
    if (desktop) {
      for (const [index, scene] of ["S1", "S2", "S3", "S4", "S5", "S6"].entries()) {
        await page.locator(`#scene-${scene}`).scrollIntoViewIfNeeded();
        await page.evaluate((id) => {
          const block = document.getElementById(id)?.closest("li");
          if (block) window.scrollBy(0, block.getBoundingClientRect().top + block.getBoundingClientRect().height / 3 - window.innerHeight / 2);
        }, `scene-${scene}`);
        const visual = page.locator(`[role="group"][aria-labelledby="scene-${scene}"]`);
        await expect(visual).toHaveCSS("opacity", "1");
        await expect(page.locator("#recorrido").getByText(copy.walkthrough.stepOf(index + 1, 6), { exact: true }).last()).toBeVisible();
        await page.waitForTimeout(500);
        await shot(page, `landing-walkthrough-${scene}`);
      }
    } else {
      await expect(page.locator("#recorrido li[aria-labelledby^='scene-']")).toHaveCount(6);
      for (const scene of ["S1", "S2", "S3", "S4", "S5", "S6"]) {
        await page.locator(`#scene-${scene}`).scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await shot(page, `landing-walkthrough-${scene}`, { selector: `#recorrido li[aria-labelledby='scene-${scene}']` });
      }
    }
  });

  test("[FL-089] goals and the assumption labelled; the gallery opens, walks and closes with the keyboard", async ({ page }) => {
    const copy = LANDING_COPY[projectContext().lang];
    await open(page);
    const impact = page.locator("#impacto");
    await impact.scrollIntoViewIfNeeded();
    for (const item of copy.impact.items) await expect(impact.getByText(`${item.prefix}${item.value}${item.suffix}`)).toBeVisible();
    await expect(impact.getByText(copy.impact.goal, { exact: true })).toHaveCount(copy.impact.items.length);
    await expect(impact.getByText(copy.impact.assumption, { exact: true })).toBeVisible();
    const gallery = page.locator("#galeria");
    await gallery.scrollIntoViewIfNeeded();
    const thumbs = gallery.getByRole("button", { name: new RegExp(`^${copy.zoom.open}`) });
    await expect(thumbs).toHaveCount(6);
    await thumbs.first().focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(copy.zoom.counter(1, 6));
    await page.waitForTimeout(400);
    await shot(page, "landing-gallery-zoom");
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText(copy.zoom.counter(2, 6));
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(thumbs.first()).toBeFocused();
  });

  test("[FL-089] the hero loops with a pause control; with reduced motion it shows its still poster and every block at once", async ({ page }) => {
    const { reduced, lang } = projectContext();
    const copy = LANDING_COPY[lang];
    await open(page);
    if (reduced) {
      await expect(page.locator("[data-still]").first()).toHaveAttribute("data-still", "true");
      await expect(page.getByRole("button", { name: copy.hero.loop.pause })).toHaveCount(0);
      for (const block of ["#problema", "#actores", "#confianza", "#real"]) await expect(page.locator(`${block} .transition`).first()).toHaveCSS("opacity", "1");
    } else {
      await expect(page.getByRole("button", { name: copy.hero.loop.pause })).toBeVisible();
      await page.getByRole("button", { name: copy.hero.loop.pause }).click();
      await expect(page.getByRole("button", { name: copy.hero.loop.play })).toBeVisible();
    }
    await shot(page, "landing-hero", { selector: "#hero" });
  });

  test("[FL-089] the switch changes the language of the page and of its document", async ({ page }) => {
    const { lang } = projectContext();
    const other = lang === "es" ? "en" : "es";
    await open(page);
    await page
      .getByRole("banner")
      .getByRole("button", { name: new RegExp(`^(?:${LANDING_COPY[lang].lang.short}|${LANDING_COPY[lang].lang.switchTo})$`) })
      .click();
    await expect(page.locator("html")).toHaveAttribute("lang", LANDING_COPY[other].htmlLang);
    await expect(page.getByRole("heading", { level: 1, name: LANDING_COPY[other].hero.title })).toBeVisible();
  });

  test("[FL-089] LCP under 2.5 s on a phone with a simulated 4G (fast 4G, 4× CPU)", async ({ page, browserName }) => {
    const { desktop } = projectContext();
    test.skip(desktop || browserName !== "chromium", "measured on the phone projects");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.goto(`/?lang=${projectContext().param}`, { waitUntil: "load" });
    const lcp = await page.evaluate(
      () =>
        new Promise<number>((resolveLcp) => {
          let last = 0;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) last = entry.startTime;
          }).observe({ type: "largest-contentful-paint", buffered: true });
          setTimeout(() => resolveLcp(last), 3_000);
        }),
    );
    test.info().annotations.push({ type: "LCP", description: `${Math.round(lcp)} ms` });
    console.log(`LCP ${projectContext().name}: ${Math.round(lcp)} ms`);
    expect(lcp).toBeGreaterThan(0);
    expect(lcp).toBeLessThan(2_500);
  });
});
