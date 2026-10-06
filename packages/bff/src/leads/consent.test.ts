import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONSENTS, CONTACT, ConsentAnswers, LEGAL_PATHS, TERMS_PRIVACY, consentSegments } from "@cuadrilla/shared/legal/consents";
import { CONTROL_BODY_LEGEND_ES, PRIVACY_CONTROLLER, interimMarkersIn } from "@cuadrilla/shared/legal/controller";
import { assertConsents, consentIssues, consentRecords, contactWithdrawal } from "./consent";
import { answers } from "./testing";

const AT = new Date("2026-10-01T15:00:00.000Z");
const legalPage = (name: "privacy" | "terms") => readFileSync(fileURLToPath(new URL(`../../../web/public/legal/${name}.html`, import.meta.url)), "utf8");
const declaredVersions = (html: string) => [...html.matchAll(/(?:name="legal-version" content|data-legal-version)="([^"]+)"/g)].map((match) => match[1]);

describe("consents of the sign-up [FL-115]", () => {
  it("[FL-115] TERMS_PRIVACY and CONTACT have an id, a YYYY-MM-DD version and a text in es-MX and en", () => {
    for (const consent of [TERMS_PRIVACY, CONTACT]) {
      expect(CONSENTS[consent.id]).toBe(consent);
      expect(consent.textVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(consent.text["es-MX"].length).toBeGreaterThan(20);
      expect(consent.text.en.length).toBeGreaterThan(20);
    }
    expect(TERMS_PRIVACY.required).toBe(true);
    expect(CONTACT.required).toBe(false);
    expect(CONTACT.text["es-MX"]).toBe("Acepto que Craftech me contacte por esta solución.");
    expect(CONTACT.text.en).toBe("I agree that Craftech may contact me about this solution.");
  });

  it("[FL-115] [FL-119] the TERMS_PRIVACY box itself names the international transfer, in both languages", () => {
    expect(TERMS_PRIVACY.text["es-MX"]).toContain("Estados Unidos");
    expect(TERMS_PRIVACY.text["es-MX"]).toContain("otras regiones de AWS");
    expect(TERMS_PRIVACY.text.en).toContain("United States");
    expect(TERMS_PRIVACY.text.en).toContain("other AWS regions");
  });

  it("[FL-115] the box's links cut the text without changing it, to the two legal pages", () => {
    for (const locale of ["es-MX", "en"] as const) {
      const segments = consentSegments(TERMS_PRIVACY, locale);
      expect(segments.map((segment) => segment.text).join("")).toBe(TERMS_PRIVACY.text[locale]);
      expect(segments.flatMap((segment) => ("href" in segment ? [segment.href] : []))).toEqual([LEGAL_PATHS.terms, LEGAL_PATHS.privacy]);
      expect(consentSegments(CONTACT, locale)).toEqual([{ text: CONTACT.text[locale] }]);
    }
  });

  it("[FL-115] a version other than the one in force, or TERMS_PRIVACY not accepted, is INVALID", () => {
    expect(consentIssues(answers(false))).toEqual([]);
    expect(consentIssues(answers(true, false))).toEqual([{ id: "TERMS_PRIVACY", reason: "REQUIRED" }]);
    expect(consentIssues(answers(true, true, "2026-01-01"))).toEqual([
      { id: "TERMS_PRIVACY", reason: "STALE_VERSION" },
      { id: "CONTACT", reason: "STALE_VERSION" },
    ]);
    expect(() => assertConsents(answers(true, false))).toThrow(expect.objectContaining({ code: "INVALID", reason: "CONSENT_TERMS_PRIVACY_REQUIRED" }));
    expect(() => assertConsents({ ...answers(true), CONTACT: { accepted: true, textVersion: "2025-12-31" } })).toThrow(expect.objectContaining({ code: "INVALID" }));
  });

  it("[FL-115] the form must send both answers, unchecked included, and nothing else", () => {
    expect(ConsentAnswers.safeParse(answers(false)).success).toBe(true);
    expect(ConsentAnswers.safeParse({ TERMS_PRIVACY: answers(true).TERMS_PRIVACY }).success).toBe(false);
    expect(ConsentAnswers.safeParse({ ...answers(true), MARKETING: { accepted: true, textVersion: TERMS_PRIVACY.textVersion } }).success).toBe(false);
  });

  it("[FL-115] stores each answer with the server's real time, the version in force and the form's language", () => {
    const records = consentRecords(answers(false), "en", AT);
    expect(records.TERMS_PRIVACY).toEqual({ id: "TERMS_PRIVACY", accepted: true, at: AT.toISOString(), textVersion: TERMS_PRIVACY.textVersion, locale: "en" });
    expect(records.CONTACT).toEqual({ id: "CONTACT", accepted: false, at: AT.toISOString(), textVersion: CONTACT.textVersion, locale: "en" });
    expect(contactWithdrawal("es-MX", AT)).toEqual({ id: "CONTACT", accepted: false, at: AT.toISOString(), textVersion: CONTACT.textVersion, locale: "es-MX" });
  });

  it("[FL-119] the legal pages carry the version of TERMS_PRIVACY, in es-MX and in en", () => {
    for (const page of ["privacy", "terms"] as const) {
      const versions = declaredVersions(legalPage(page));
      expect(versions.length, page).toBe(3);
      for (const version of versions) expect(version, page).toBe(TERMS_PRIVACY.textVersion);
      expect(legalPage(page)).toContain(`Versión ${TERMS_PRIVACY.textVersion}`);
      expect(legalPage(page)).toContain(`Version ${TERMS_PRIVACY.textVersion}`);
    }
  });

  it("[FL-119] the privacy notice quotes the TERMS_PRIVACY box word for word, in both languages", () => {
    const html = legalPage("privacy");
    expect(html).toContain(`<blockquote data-consent="TERMS_PRIVACY" lang="es-MX">${TERMS_PRIVACY.text["es-MX"]}</blockquote>`);
    expect(html).toContain(`<blockquote data-consent="TERMS_PRIVACY" lang="en">${TERMS_PRIVACY.text.en}</blockquote>`);
  });

  it("[FL-119] the privacy notice names the controller of ADR-0027, its seat, the mailbox, the contact form and the control-body legend", () => {
    const html = legalPage("privacy");
    const mailto = `<a href="mailto:${PRIVACY_CONTROLLER.mailbox}">${PRIVACY_CONTROLLER.mailbox}</a>`;
    expect(html).toContain(`<strong>${PRIVACY_CONTROLLER.name}</strong>`);
    expect(html).toContain(PRIVACY_CONTROLLER.seat["es-MX"]);
    expect(html).toContain(PRIVACY_CONTROLLER.seat.en);
    expect(html.split(mailto).length - 1, "mailbox in points 1, 7 and 8 of each language").toBe(6);
    expect(html.split(`href="${PRIVACY_CONTROLLER.contactUrl}"`).length - 1, "contact form in points 7 and 8 of each language").toBe(4);
    expect(html).toContain(CONTROL_BODY_LEGEND_ES);
    expect(html).toContain("Law No. 25,326");
    expect(html).toContain("lo que ocurra primero");
    expect(html).toContain("whichever comes first");
    expect(html).toContain("<strong>Base legal</strong>: tu consentimiento.");
    expect(html).toContain("<strong>Legal basis</strong>: your consent.");
  });

  it("[FL-119] the terms name the controller and the same two channels to delete an account", () => {
    const html = legalPage("terms");
    expect(html).toContain(`Craftech, con domicilio en la ${PRIVACY_CONTROLLER.seat["es-MX"]}`);
    expect(html).toContain(`Craftech, based in the ${PRIVACY_CONTROLLER.seat.en}`);
    expect(html.split(`href="mailto:${PRIVACY_CONTROLLER.mailbox}"`).length - 1).toBe(2);
  });

  it("[FL-119] no legal page carries an interim marker, an invented tax id or a street address", () => {
    for (const page of ["privacy", "terms"] as const) {
      const html = legalPage(page);
      expect(interimMarkersIn(html), page).toEqual([]);
      expect(html, page).not.toMatch(/CUIT|\b\d{2}-\d{8}-\d\b|\bcalle\b|\bpiso\b|\bstreet\b/i);
    }
    expect(interimMarkersIn("Domicilio legal: en confirmación")).not.toEqual([]);
    expect(interimMarkersIn("Registered address: being confirmed")).not.toEqual([]);
  });
});
