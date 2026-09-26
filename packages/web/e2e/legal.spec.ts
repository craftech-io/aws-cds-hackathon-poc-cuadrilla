// FL-119 in the browser (docs/test-plan.md §3, "Consola y superficies públicas"): the two static legal
// pages, es-MX and en on the same page. The projects of playwright.config.ts run it on a phone
// (390×844) and a desktop (1440×900), in each language and with reduced motion; the language of the
// project picks the version under test. Both carry the version of the TERMS_PRIVACY consent; the
// privacy notice has the nine points of ADR-0026 and quotes the box word for word; no horizontal
// scroll, touch targets of 44 px in the header and the footer, and no word of ADR-0023.
import { type Page, expect, test } from "@playwright/test";
import { TERMS_PRIVACY } from "@cuadrilla/shared/legal/consents";
import { findNeutralTerms } from "../../../scripts/lint/neutral-terms";
import { expectReadableScreen } from "./support/a11y";

type Language = "es" | "en";

/** The nine points of ADR-0026, in order, by their anchors in each language. */
const PRIVACY_POINTS: Readonly<Record<Language, readonly string[]>> = {
  es: ["es-responsable", "es-datos", "es-encargados", "es-transferencia", "es-finalidades", "es-retencion", "es-derechos", "es-contacto", "es-sinteticos"],
  en: ["en-controller", "en-data", "en-processors", "en-transfer", "en-purposes", "en-retention", "en-rights", "en-contact", "en-synthetic"],
};

/** What each language's notice must say (ADR-0026 points 1-9). */
const PRIVACY_FACTS: Readonly<Record<Language, readonly string[]>> = {
  es: ["Craftech", "Domicilio legal", "aws-waf-token", "sessionStorage", "48 horas", "voz real", "us-east-1", "inferencia global", "Amazon Transcribe", "artículo 12 de la Ley 25.326", "7 días", "24 meses", "9 días", "30 días", "10 días corridos", "5 días hábiles", "sin borrar tu cuenta", "Agencia de Acceso a la Información Pública", "sintéticos"],
  en: ["Craftech", "Registered address", "aws-waf-token", "sessionStorage", "48 hours", "real voice", "us-east-1", "global inference", "Amazon Transcribe", "article 12", "7 days", "24 months", "9 days", "30 days", "10 calendar days", "5 business days", "without deleting your account", "Agencia de Acceso a la Información Pública", "synthetic"],
};

const LINK_NAME: Readonly<Record<Language, string>> = { es: "Español", en: "English" };
const BOX_TEXT: Readonly<Record<Language, string>> = { es: TERMS_PRIVACY.text["es-MX"], en: TERMS_PRIVACY.text.en };

function language(): Language {
  return test.info().project.use.locale === "en" ? "en" : "es";
}

async function open(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(200);
}

async function expectLayout(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no horizontal scroll").toBeLessThanOrEqual(0);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("header a, footer a")]
      .map((element) => ({ text: (element.textContent ?? "").trim() || element.getAttribute("aria-label") || "", height: element.getBoundingClientRect().height }))
      .filter((target) => target.height > 0 && target.height < 44),
  );
  expect(small, "header and footer targets are at least 44 px tall").toEqual([]);
  await expectReadableScreen(page);
}

test.describe("legal pages", () => {
  test("[FL-119] the privacy notice has the nine points of ADR-0026 in the project's language, with the version of TERMS_PRIVACY", async ({ page }) => {
    const lang = language();
    await open(page, `/legal/privacy.html#${lang}`);
    await expect(page).toHaveTitle(/Aviso de privacidad/);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("es-MX");
    await expect(page.locator('meta[name="legal-version"]')).toHaveAttribute("content", TERMS_PRIVACY.textVersion);
    const article = page.locator(`article#${lang}`);
    await expect(article).toHaveAttribute("data-legal-version", TERMS_PRIVACY.textVersion);
    await expect(article).toHaveAttribute("lang", lang === "en" ? "en" : "es-MX");
    await expect(article).toContainText(lang === "en" ? `Version ${TERMS_PRIVACY.textVersion}` : `Versión ${TERMS_PRIVACY.textVersion}`);
    expect(await article.locator("h3[id]").evaluateAll((headings) => headings.map((heading) => heading.id))).toEqual([...PRIVACY_POINTS[lang]]);
    for (const id of PRIVACY_POINTS[lang]) await expect(page.locator(`#${id}`)).toBeVisible();
    await expectLayout(page);
  });

  test("[FL-119] the notice quotes the TERMS_PRIVACY box word for word and names the transfer, the processors, the retention, the rights and the channel", async ({ page }) => {
    const lang = language();
    await open(page, `/legal/privacy.html#${lang}`);
    const article = page.locator(`article#${lang}`);
    await expect(article.locator('blockquote[data-consent="TERMS_PRIVACY"]')).toHaveText(BOX_TEXT[lang]);
    const text = await article.innerText();
    for (const fact of PRIVACY_FACTS[lang]) expect(text, fact).toContain(fact);
    await expect(page.locator(`#${PRIVACY_POINTS[lang][7]} + p a`)).toHaveAttribute("href", "https://craftech.io/contact/");
    await expect(article.locator('a[href="/legal/terms.html"]')).toBeVisible();
  });

  test("[FL-119] the terms carry the version of TERMS_PRIVACY and link the privacy notice", async ({ page }) => {
    const lang = language();
    await open(page, `/legal/terms.html#${lang}`);
    await expect(page).toHaveTitle(/Términos/);
    await expect(page.locator('meta[name="legal-version"]')).toHaveAttribute("content", TERMS_PRIVACY.textVersion);
    const article = page.locator(`article#${lang}`);
    await expect(article).toHaveAttribute("data-legal-version", TERMS_PRIVACY.textVersion);
    await expect(article.locator('a[href="/legal/privacy.html"]').first()).toBeVisible();
    await expect(article).toContainText(lang === "en" ? "Argentine Republic" : "República Argentina");
    await expectLayout(page);
  });

  test("[FL-119] the language switch reaches each version, and no page uses a word of ADR-0023", async ({ page }) => {
    const lang = language();
    const other: Language = lang === "en" ? "es" : "en";
    for (const path of ["/legal/privacy.html", "/legal/terms.html"]) {
      await open(page, path);
      for (const target of [lang, other, lang]) {
        await page.getByRole("link", { name: LINK_NAME[target], exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`#${target}$`));
        await expect(page.locator(`article#${target} :is(h1, h2)`).first()).toBeInViewport();
      }
      expect(findNeutralTerms(path, await page.locator("body").innerText())).toEqual([]);
      expect(findNeutralTerms(`${path} (source)`, await page.content())).toEqual([]);
    }
  });
});
