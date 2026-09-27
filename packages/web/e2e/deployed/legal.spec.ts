// FL-119 on the deployed stage (docs/test-plan.md §6.1, row "Legales"): `/legal/privacy.html` and
// `/legal/terms.html` answer 200 with the security headers of the Router, carry the version of the
// TERMS_PRIVACY consent in force, the privacy notice has the nine points of ADR-0026 in the project's
// language and quotes the box word for word, and neither page uses a word of ADR-0023. A screenshot of
// each page in the eight projects.
import { type Page, expect, test } from "@playwright/test";
import { TERMS_PRIVACY } from "@cuadrilla/shared/legal/consents";
import { expectReadableScreen } from "../support/a11y";
import { expectNeutral, noHorizontalScroll, projectContext, shot } from "./support";

const PRIVACY_POINTS = {
  es: ["es-responsable", "es-datos", "es-encargados", "es-transferencia", "es-finalidades", "es-retencion", "es-derechos", "es-contacto", "es-sinteticos"],
  en: ["en-controller", "en-data", "en-processors", "en-transfer", "en-purposes", "en-retention", "en-rights", "en-contact", "en-synthetic"],
} as const;

async function open(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(200);
  const headers = response?.headers() ?? {};
  expect(headers["content-type"] ?? "").toContain("text/html");
  expect(headers["strict-transport-security"] ?? "").toContain("max-age=");
  expect((headers["x-content-type-options"] ?? "").toLowerCase()).toBe("nosniff");
  expect((headers["x-frame-options"] ?? "").toUpperCase()).toBe("DENY");
  expect(headers["content-security-policy"] ?? "", "a CSP on the legal page").toContain("default-src");
}

test.describe("deployed legal pages @public", () => {
  test("[FL-119] privacy: headers, the version in force, the nine points in the project's language, the box quoted", async ({ page }) => {
    const { lang } = projectContext();
    await open(page, `/legal/privacy.html#${lang}`);
    await expect(page.locator('meta[name="legal-version"]')).toHaveAttribute("content", TERMS_PRIVACY.textVersion);
    const article = page.locator(`article#${lang}`);
    await expect(article).toHaveAttribute("data-legal-version", TERMS_PRIVACY.textVersion);
    expect(await article.locator("h3[id]").evaluateAll((headings) => headings.map((heading) => heading.id))).toEqual([...PRIVACY_POINTS[lang]]);
    await expect(article.locator('blockquote[data-consent="TERMS_PRIVACY"]')).toHaveText(TERMS_PRIVACY.text[lang === "en" ? "en" : "es-MX"]);
    await expect(page.locator(`#${PRIVACY_POINTS[lang][7]} + p a`)).toHaveAttribute("href", "https://craftech.io/contact/");
    await noHorizontalScroll(page);
    await expectReadableScreen(page);
    await expectNeutral(page, "/legal/privacy.html");
    await page.locator(`article#${lang}`).scrollIntoViewIfNeeded();
    await shot(page, "legal-privacy", { fullPage: true });
  });

  test("[FL-119] terms: headers, the version in force, the link to the privacy notice", async ({ page }) => {
    const { lang } = projectContext();
    await open(page, `/legal/terms.html#${lang}`);
    await expect(page.locator('meta[name="legal-version"]')).toHaveAttribute("content", TERMS_PRIVACY.textVersion);
    const article = page.locator(`article#${lang}`);
    await expect(article).toHaveAttribute("data-legal-version", TERMS_PRIVACY.textVersion);
    await expect(article.locator('a[href="/legal/privacy.html"]').first()).toBeVisible();
    await noHorizontalScroll(page);
    await expectReadableScreen(page);
    await expectNeutral(page, "/legal/terms.html");
    await shot(page, "legal-terms", { fullPage: true });
  });
});
