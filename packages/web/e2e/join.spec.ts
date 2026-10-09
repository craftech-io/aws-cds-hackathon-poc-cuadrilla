// FL-089 in the browser: `/join`, the staff opt-in page, at 390×844 and 1440×900 in the language of the
// project — the product's poster with the keyword, the QR that opens the console's phone simulator on
// this same site (the stage runs the simulated transport until P-01), the way into the simulator
// through the sign-in, the language switch, no horizontal scroll from 360 px, and the brand of the
// stage in the neutral and co-branding modes.
import { type Page, expect, test } from "@playwright/test";
import { enGloss } from "../../bff/src/copy/en-gloss";
import { esMX } from "../../bff/src/copy/es-MX";
import { joinCopy } from "../src/views/join/copy";
import { JOIN_KEYWORD } from "../src/views/join/join-model";
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

function context() {
  const lang = test.info().project.use.locale?.startsWith("en") ? ("en" as const) : ("es" as const);
  return { lang, copy: joinCopy[lang], poster: lang === "en" ? enGloss.optInPoster : esMX.optInPoster, param: lang === "en" ? "en" : "es-MX" };
}

async function open(page: Page, brand: unknown = NEUTRAL_BRAND): Promise<void> {
  await routeConsoleApi(page, { brand });
  await page.goto(`/join?lang=${context().param}`);
  await expect(page.getByRole("heading", { level: 1, name: context().copy.title })).toBeVisible();
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth, "no horizontal scroll").toBeLessThanOrEqual(clientWidth);
}

test.describe("staff opt-in page", () => {
  test("[FL-089] the poster, the keyword and a QR that opens the simulator on this site", async ({ page, baseURL }) => {
    const { copy, poster } = context();
    await open(page);
    await expect(page.locator("html")).toHaveAttribute("lang", copy.htmlLang);
    await expect(page.getByText(JOIN_KEYWORD, { exact: true })).toBeVisible();
    await expect(page.getByText(poster)).toBeVisible();
    const qr = page.getByRole("img", { name: copy.qrLabel });
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box?.width ?? 0, "the QR is big enough to scan").toBeGreaterThanOrEqual(160);
    const simulator = page.getByRole("link", { name: copy.open });
    await expect(simulator).toHaveAttribute("href", "/app/simulator");
    await expect(page.getByText(copy.simulated)).toBeVisible();
    // No request of the page leaves the site: the QR is drawn here, never by a QR service.
    const foreign = new Set<string>();
    page.on("request", (request) => {
      const origin = new URL(request.url()).origin;
      if (origin !== new URL(baseURL ?? "http://127.0.0.1").origin && !origin.startsWith("data:")) foreign.add(origin);
    });
    await page.reload();
    await expect(qr).toBeVisible();
    expect([...foreign]).toEqual([]);
    await expectReadableScreen(page);
  });

  test("[FL-089] the simulator asks for a sign-in first, and the way back leads to the landing", async ({ page }) => {
    const { copy } = context();
    await open(page);
    await page.getByRole("link", { name: copy.open }).click();
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fapp%2Fsimulator$/);
    await open(page);
    await page.getByRole("link", { name: copy.back }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("[FL-089] the switch changes the language of the page and of its document", async ({ page }) => {
    const { lang } = context();
    const other = lang === "es" ? "en" : "es";
    await open(page);
    await page.getByRole("button", { name: joinCopy[lang].switchTo }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", joinCopy[other].htmlLang);
    await expect(page.getByRole("heading", { level: 1, name: joinCopy[other].title })).toBeVisible();
    await expect(page.getByText(other === "en" ? enGloss.optInPoster : esMX.optInPoster)).toBeVisible();
  });

  test("[FL-089] no horizontal scroll from 360 px, and every control is 44 px or more", async ({ page }) => {
    await open(page, COBRAND);
    await noHorizontalScroll(page);
    for (const width of [360, 768, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await noHorizontalScroll(page);
    }
    for (const target of await page.locator("main a, header button").all()) {
      const box = await target.boundingBox();
      expect(box?.height ?? 0, await target.innerText()).toBeGreaterThanOrEqual(44);
    }
  });

  test("[FL-089] neutral mode: the operator is labelled fictitious; co-branding: the partner and the synthetic-demo notice", async ({ page }) => {
    const { lang } = context();
    await open(page);
    await expect(page.getByRole("note")).toHaveText(lang === "en" ? enGloss.fictitiousOperatorNotice : esMX.fictitiousOperatorNotice);
    await open(page, COBRAND);
    await expect(page.getByRole("note")).toHaveText(COBRAND.disclaimer[lang]);
    await expect(page.locator("header")).toContainText(`for ${COBRAND.displayName}`);
  });
});
