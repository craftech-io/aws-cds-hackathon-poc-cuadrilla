// FL-089 in the browser (docs/landing-spec.md §9.1): the commercial landing in the language of the
// project, at 390×844 and 1440×900, with and without reduced motion — the twelve blocks, the three calls
// to action (with the language kept on the way to the signup and the login), no horizontal scroll from
// 360 to 1440 px, the primary call to action on the first screen at 360×640, the walkthrough (pinned on
// a desktop, stacked on a phone), the impact labelled as goals, the gallery with zoom and the focus back,
// the language switch and the brand of the stage in the neutral and co-branding modes.
import { type Page, expect, test } from "@playwright/test";
import { enGloss } from "../../bff/src/copy/en-gloss";
import { esMX } from "../../bff/src/copy/es-MX";
import { LANDING_COPY } from "../src/views/landing/copy";
import { expectReadableScreen } from "./support/a11y";
import { routeConsoleApi } from "./support/console-api";

// Fictitious operators: the repository never names the real design partner (ADR-0018).
const NEUTRAL_BRAND = { mode: "neutral", displayName: "Operadora ficticia de prueba", logos: { onLight: null, onDark: null }, disclaimer: null };
const COBRAND = {
  mode: "cobrand",
  displayName: "Operadora Socia",
  logos: { onLight: null, onDark: null },
  disclaimer: { es: "Demo sintética: el manual, las políticas y los datos son inventados.", en: "Synthetic demo: the manual, the policies and the data are made up." },
};

const BLOCKS = ["#top", "#hero", "#problema", "#recorrido", "#actores", "#confianza", "#impacto", "#integracion", "#real", "#galeria", "#empezar", "#footer"];

function context() {
  const use = test.info().project.use;
  const lang = use.locale?.startsWith("en") ? ("en" as const) : ("es" as const);
  return { lang, copy: LANDING_COPY[lang], param: lang === "en" ? "en" : "es-MX", reduced: use.reducedMotion === "reduce", desktop: (use.viewport?.width ?? 0) >= 1024 };
}

async function open(page: Page, brand: unknown = NEUTRAL_BRAND): Promise<void> {
  await routeConsoleApi(page, { brand });
  await page.goto(`/?lang=${context().param}`);
  await expect(page.locator("#hero h1")).toBeVisible();
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth, "no horizontal scroll").toBeLessThanOrEqual(clientWidth);
}

test.describe("commercial landing", () => {
  test("[FL-089] the twelve blocks, the page's language and nothing raw on screen", async ({ page }) => {
    const { copy } = context();
    await open(page);
    await expect(page.locator("html")).toHaveAttribute("lang", copy.htmlLang);
    for (const block of BLOCKS) await expect(page.locator(block), block).toHaveCount(1);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: copy.hero.title })).toBeVisible();
    for (const title of [copy.problem.title, copy.walkthrough.title, copy.actors.title, copy.trust.title, copy.impact.title, copy.integration.title, copy.real.title, copy.gallery.title, copy.finalCta.title]) {
      await expect(page.getByRole("heading", { level: 2, name: title })).toHaveCount(1);
    }
    await expectReadableScreen(page);
  });

  test("[FL-089] the calls to action lead to the signup, the login and Craftech, keeping the language", async ({ page }) => {
    const { copy, param } = context();
    await open(page);
    for (const block of ["#hero", "#empezar"]) {
      const section = page.locator(block);
      await expect(section.getByRole("link", { name: copy.nav.tryDemo })).toHaveAttribute("href", `/signup?lang=${param}`);
      await expect(section.getByRole("link", { name: copy.nav.signIn, exact: true })).toHaveAttribute("href", `/login?lang=${param}`);
      const talk = section.getByRole("link", { name: new RegExp(copy.nav.talk) });
      await expect(talk).toHaveAttribute("href", "https://craftech.io/contact/");
      await expect(talk).toHaveAttribute("target", "_blank");
      await expect(talk).toHaveAttribute("rel", /noopener/);
    }
    const header = page.getByRole("banner");
    await expect(header.getByRole("link", { name: copy.nav.tryDemo })).toHaveAttribute("href", `/signup?lang=${param}`);
    // Touch targets of 44 px or more: the calls to action, the header's controls and the footer's links.
    const targets = page.locator("#hero a, #empezar a, header nav a, header nav button, #footer nav a");
    for (const target of await targets.all()) {
      if (!(await target.isVisible())) continue;
      const box = await target.boundingBox();
      expect(box?.height ?? 0, await target.innerText()).toBeGreaterThanOrEqual(44);
    }
  });

  test("[FL-089] no horizontal scroll from 360 to 1440 px, and the primary call to action on the first screen at 360×640", async ({ page }) => {
    const { copy } = context();
    await open(page);
    await noHorizontalScroll(page);
    for (const width of [360, 768, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      await noHorizontalScroll(page);
    }
    await page.setViewportSize({ width: 360, height: 640 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await noHorizontalScroll(page);
    const primary = await page.locator("#hero").getByRole("link", { name: copy.nav.tryDemo }).boundingBox();
    expect(primary, "the primary call to action is laid out").not.toBeNull();
    expect((primary?.y ?? 0) + (primary?.height ?? 0)).toBeLessThanOrEqual(640);
  });

  test("[FL-089] the walkthrough shows the six scenes in order, pinned on a desktop and stacked on a phone", async ({ page }) => {
    const { copy, desktop } = context();
    await open(page);
    const titles = Object.values(copy.walkthrough.scenes).map((scene) => scene.title);
    const headings = page.locator("#recorrido h3");
    await expect(headings).toHaveText(titles);
    if (desktop) {
      for (const [index, scene] of ["S1", "S2", "S3", "S4", "S5", "S6"].entries()) {
        await page.locator(`#scene-${scene}`).scrollIntoViewIfNeeded();
        await page.evaluate((id) => {
          const block = document.getElementById(id)?.closest("li");
          if (block) window.scrollBy(0, block.getBoundingClientRect().top + block.getBoundingClientRect().height / 3 - window.innerHeight / 2);
        }, `scene-${scene}`);
        const visual = page.locator(`[role="group"][aria-labelledby="scene-${scene}"]`);
        await expect(visual, scene).toHaveCount(1);
        await expect(visual).toHaveCSS("opacity", "1");
        await expect(page.locator("#recorrido").getByText(copy.walkthrough.stepOf(index + 1, 6), { exact: true }).last()).toBeVisible();
      }
    } else {
      const cards = page.locator("#recorrido li[aria-labelledby^='scene-']");
      await expect(cards).toHaveCount(6);
      const viewport = page.viewportSize()?.height ?? 844;
      for (const phone of await page.locator("#recorrido .rounded-4xl").all()) {
        const box = await phone.boundingBox();
        expect(box?.height ?? 0).toBeLessThanOrEqual(viewport * 0.7 + 1);
      }
      const snap = await page.evaluate(() => getComputedStyle(document.documentElement).scrollSnapType);
      expect(snap === "none" || snap === "").toBe(true);
    }
  });

  test("[FL-089] every impact figure carries its label and its source; the pilot is an assumption", async ({ page }) => {
    const { copy } = context();
    await open(page);
    const impact = page.locator("#impacto");
    await impact.scrollIntoViewIfNeeded();
    for (const item of copy.impact.items) {
      await expect(impact.getByText(item.source)).toBeVisible();
      await expect(impact.getByText(`${item.prefix}${item.value}${item.suffix}`)).toBeVisible();
    }
    await expect(impact.getByText(copy.impact.goal, { exact: true })).toHaveCount(copy.impact.items.length);
    await expect(impact.getByText(copy.impact.assumption, { exact: true })).toBeVisible();
    await expect(page.locator("#real")).toContainText(copy.real.columns[3]?.text ?? "");
  });

  test("[FL-089] the gallery opens with the keyboard, walks with the arrows, closes with Escape and gives the focus back", async ({ page }) => {
    const { copy } = context();
    await open(page);
    const gallery = page.locator("#galeria");
    await gallery.scrollIntoViewIfNeeded();
    const thumbs = gallery.getByRole("button", { name: new RegExp(`^${copy.zoom.open}`) });
    await expect(thumbs).toHaveCount(6);
    await thumbs.first().focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(copy.zoom.counter(1, 6));
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText(copy.zoom.counter(2, 6));
    await page.keyboard.press("ArrowLeft");
    await expect(dialog).toContainText(copy.zoom.counter(1, 6));
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(thumbs.first()).toBeFocused();
    if (test.info().project.use.hasTouch) {
      await thumbs.nth(1).click();
      await expect(dialog).toContainText(copy.zoom.counter(2, 6));
      const panel = dialog.locator(".rounded-card").first();
      const box = await panel.boundingBox();
      const y = (box?.y ?? 0) + 40;
      await panel.dispatchEvent("pointerdown", { pointerType: "touch", clientX: (box?.x ?? 0) + 250, clientY: y });
      await panel.dispatchEvent("pointerup", { pointerType: "touch", clientX: (box?.x ?? 0) + 60, clientY: y });
      await expect(dialog).toContainText(copy.zoom.counter(3, 6));
      await dialog.getByRole("button", { name: copy.zoom.close }).click();
      await expect(dialog).toBeHidden();
    }
  });

  test("[FL-089] the switch changes the language of the page and of its document", async ({ page }) => {
    const { lang } = context();
    const other = lang === "es" ? "en" : "es";
    await open(page);
    await page
      .getByRole("banner")
      .getByRole("button", { name: new RegExp(`^(?:${LANDING_COPY[lang].lang.short}|${LANDING_COPY[lang].lang.switchTo})$`) })
      .click();
    await expect(page.locator("html")).toHaveAttribute("lang", LANDING_COPY[other].htmlLang);
    await expect(page.getByRole("heading", { level: 1, name: LANDING_COPY[other].hero.title })).toBeVisible();
  });

  test("[FL-089] neutral mode: the operator is labelled fictitious; co-branding: the partner and the synthetic-demo notice", async ({ page }) => {
    const { lang, desktop } = context();
    await open(page);
    await expect(page.locator("#hero")).toContainText(lang === "en" ? enGloss.fictitiousOperatorNotice : esMX.fictitiousOperatorNotice);
    await open(page, COBRAND);
    const disclaimer = COBRAND.disclaimer[lang];
    await expect(page.locator("#hero")).toContainText(disclaimer);
    await expect(page.locator("#real")).toContainText(disclaimer);
    await expect(page.locator("#footer")).toContainText(disclaimer);
    if (desktop) await expect(page.getByRole("banner")).toContainText(`for ${COBRAND.displayName}`);
    else await expect(page.getByRole("banner")).toContainText(COBRAND.displayName);
  });

  test("[FL-089] with reduced motion every block is visible at once and the hero shows its still poster", async ({ page }) => {
    const { reduced, copy } = context();
    test.skip(!reduced, "only with reduced motion");
    await open(page);
    await expect(page.locator("[data-still]").first()).toHaveAttribute("data-still", "true");
    await expect(page.getByRole("button", { name: copy.hero.loop.pause })).toHaveCount(0);
    for (const block of ["#problema", "#actores", "#confianza", "#real"]) {
      const card = page.locator(`${block} .transition`).first();
      await expect(card).toHaveCSS("opacity", "1");
    }
    await page.locator("#impacto").scrollIntoViewIfNeeded();
    for (const item of copy.impact.items) await expect(page.locator("#impacto").getByText(`${item.prefix}${item.value}${item.suffix}`)).toBeVisible();
  });

  test("[FL-089] with reduced motion every phone message reads at 12 px or more: a still frame scrolls or grows, it never shrinks the text", async ({ page }) => {
    const { reduced } = context();
    test.skip(!reduced, "only with reduced motion");
    await open(page);
    await page.locator("#recorrido").scrollIntoViewIfNeeded();
    await expect(page.locator('#recorrido [data-phone-frame="still"]').first()).toBeVisible();
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-phone-frame="still"] li')]
        .filter((item) => item.getClientRects().length > 0 && (item.textContent ?? "").trim() !== "")
        .map((item) => {
          const list = item.closest("ol") as HTMLElement;
          // The effective size: the computed font size times whatever scale a transform applies to the list.
          const transform = getComputedStyle(list).transform;
          const scale = transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a;
          const bubble = item.querySelector<HTMLElement>("span") ?? item;
          return { text: (item.textContent ?? "").slice(0, 40), px: Number.parseFloat(getComputedStyle(bubble).fontSize) * scale };
        }),
    );
    expect(sizes.length).toBeGreaterThan(10);
    for (const size of sizes) expect(size.px, size.text).toBeGreaterThanOrEqual(12);
    // A conversation longer than its stage scrolls inside the phone, reachable with the keyboard.
    const scrollers = page.locator('#recorrido [data-phone-frame="still"] [role="region"]');
    for (const region of await scrollers.all()) {
      if (!(await region.isVisible())) continue;
      await expect(region).toHaveAttribute("tabindex", "0");
      expect(await region.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      // It opens on its last message, the final state the motion version ends on.
      expect(await region.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(true);
    }
  });

  test("[FL-089] with reduced motion the wheel over a still phone keeps scrolling the page", async ({ page }) => {
    const { reduced } = context();
    test.skip(!reduced, "only with reduced motion");
    await open(page);
    await page.locator("#recorrido").scrollIntoViewIfNeeded();
    const phones = page.locator('#recorrido [data-phone-frame="still"]').filter({ visible: true });
    await expect(phones.first()).toBeVisible();
    // A phone whose conversation fits never becomes a scroll container that could hold the page.
    const trapped = await phones.evaluateAll(
      (frames) =>
        frames.filter((frame) => {
          const viewport = frame.querySelector("ol")?.parentElement;
          if (!viewport) return false;
          const style = getComputedStyle(viewport);
          const scrollable = style.overflowY === "auto" || style.overflowY === "scroll";
          return style.overscrollBehaviorY !== "auto" || (scrollable && viewport.scrollHeight <= viewport.clientHeight + 1);
        }).length,
    );
    expect(trapped).toBe(0);
    // At 1024×768 the first scene's conversation overflows its phone: the wheel scrolls it, then the page.
    const sizes = context().desktop ? [page.viewportSize(), { width: 1024, height: 768 }] : [page.viewportSize()];
    for (const size of sizes) {
      if (size !== null) await page.setViewportSize(size);
      await page.locator("#recorrido").scrollIntoViewIfNeeded();
      await phones.first().scrollIntoViewIfNeeded();
      // The phone the pointer really lands on (the pinned column stacks every scene's phone).
      const point = await phones.evaluateAll((frames) => {
        for (const frame of frames) {
          const rect = frame.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = Math.min(rect.top + rect.height / 2, window.innerHeight - 20);
          if (y > 0 && frame.contains(document.elementFromPoint(x, y))) return { x, y };
        }
        return null;
      });
      if (point === null) throw new Error("no still phone under the pointer");
      await page.mouse.move(point.x, point.y);
      const before = await page.evaluate(() => window.scrollY);
      for (let tick = 0; tick < 6; tick += 1) await page.mouse.wheel(0, 150);
      await expect.poll(() => page.evaluate(() => window.scrollY), `the page scrolls at ${size?.width ?? 0} px`).toBeGreaterThan(before + 300);
    }
  });
});
