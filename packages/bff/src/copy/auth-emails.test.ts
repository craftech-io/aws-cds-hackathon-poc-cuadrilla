import { describe, expect, it } from "vitest";
import { findNeutralTerms } from "../../../../scripts/lint/neutral-terms";
import { AUTH_EMAIL_KINDS, AUTH_EMAILS_ES, type AuthEmailKind, type AuthEmailLocale, authEmailLocale, renderAuthEmail } from "./auth-emails";
import { AUTH_EMAILS_EN } from "./auth-emails.en";
import { findForeignLink, findSensitiveAsk } from "./forbidden";

const LINKS = { loginUrl: "https://cuadrilla.demo.craftech.io/login", logoUrl: "https://cuadrilla.demo.craftech.io/brand/logo-craftech-color.png" };
const LOCALES: readonly AuthEmailLocale[] = ["es-MX", "en"];
const render = (kind: AuthEmailKind, locale: AuthEmailLocale) => renderAuthEmail(kind, locale, { code: "{####}", username: "{username}" }, LINKS);

describe("authentication emails [FL-104] [FL-106] [FL-109]", () => {
  it("[FL-104] every message in es-MX and en carries the code, the expiry, the ignore line, the synthetic-demo notice and Powered by Craftech", () => {
    for (const locale of LOCALES) {
      const texts = locale === "en" ? AUTH_EMAILS_EN : AUTH_EMAILS_ES;
      for (const kind of AUTH_EMAIL_KINDS) {
        const { subject, html } = render(kind, locale);
        expect(html, `${kind} ${locale}`).toContain("{####}");
        expect(html).toContain(`lang="${texts.htmlLang}"`);
        expect(subject).toContain(texts.syntheticTag);
        expect(subject.length).toBeLessThanOrEqual(140);
        expect(html.length).toBeLessThan(20_000);
        expect(html).toContain(texts[kind].expiry.replace(/'/g, "&#39;"));
        expect(html).toContain(texts[kind].ignore.replace(/'/g, "&#39;"));
        expect(html).toContain(texts.disclaimer);
        expect(html).toContain("Powered by");
        expect(html).toContain('alt="Craftech"');
      }
      expect(render("ADMIN_CREATE_USER", locale).html).toContain("{username}");
      expect(render("ADMIN_CREATE_USER", locale).html).toContain(`href="${LINKS.loginUrl}"`);
    }
  });

  it("[FL-120] no message, rendered, uses a word of ADR-0023, and none asks for sensitive data or links outside the product", () => {
    for (const locale of LOCALES) {
      for (const kind of AUTH_EMAIL_KINDS) {
        const { subject, html } = render(kind, locale);
        expect(findNeutralTerms(`${kind} ${locale}`, `${subject}\n${html}`)).toEqual([]);
      }
    }
    for (const texts of [AUTH_EMAILS_ES, AUTH_EMAILS_EN]) {
      for (const kind of AUTH_EMAIL_KINDS) {
        for (const text of Object.values(texts[kind])) {
          expect(findSensitiveAsk(text), text).toBeNull();
          expect(findForeignLink(text), text).toBeNull();
        }
      }
    }
  });

  it("the English texts have exactly the keys of the Spanish ones", () => {
    const shape = (value: unknown): unknown => (typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)])) : typeof value);
    expect(shape(AUTH_EMAILS_EN)).toEqual(shape(AUTH_EMAILS_ES));
  });

  it("[FL-104] the language follows the locale attribute, Mexican Spanish by default", () => {
    expect(authEmailLocale("en")).toBe("en");
    for (const other of ["es-MX", undefined, "pt-BR", "EN", ""]) expect(authEmailLocale(other)).toBe("es-MX");
  });

  it("links only to https and never takes markup from a link", () => {
    expect(() => renderAuthEmail("SIGN_UP", "es-MX", { code: "{####}" }, { ...LINKS, logoUrl: "javascript:alert(1)" })).toThrow(RangeError);
    expect(() => renderAuthEmail("ADMIN_CREATE_USER", "en", { code: "{####}", username: "{username}" }, { ...LINKS, loginUrl: 'https://x.test/"><script>' })).toThrow(RangeError);
    expect(() => renderAuthEmail("ADMIN_CREATE_USER", "en", { code: "{####}" }, LINKS)).toThrow(RangeError);
  });
});
