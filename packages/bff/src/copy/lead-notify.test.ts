import { describe, expect, it } from "vitest";
import { findNeutralTerms } from "../../../../scripts/lint/neutral-terms";
import { type LeadNoticeInput, neutralizeVisitorText, renderLeadNotice } from "./lead-notify";

const BASE: LeadNoticeInput = {
  leadId: "01K6ABCDEFGHJKMNPQRSTVWXYZ",
  email: "ana.prueba@example.com",
  name: "Ana Prueba",
  company: "Fibra Demo",
  jobTitle: "Jefa de campo",
  locale: "es-MX",
  contactAccepted: true,
  contactVersion: "2026-09-26",
  origin: "WEB",
  utm: { source: "linkedin", campaign: "fibra-2026" },
  referrerOrigin: "https://example.org",
  signupAt: "2026-10-01T15:04:59.000Z",
};

describe("text of the lead notice", () => {
  it("names the product, the reference, the date, the language, the consent, the origin and the attribution", () => {
    const { subject, text } = renderLeadNotice(BASE);
    expect(subject).toBe("Nuevo lead de la demo Cuadrilla · Fibra Demo");
    expect(text.split("\n")[0]).toBe("Nuevo lead de la demo Cuadrilla.");
    for (const line of [
      "Referencia: 01K6ABCDEFGHJKMNPQRSTVWXYZ",
      "Fecha de alta: 2026-10-01 15:04 UTC",
      "Idioma: español (es-MX)",
      "Consentimiento de contacto: sí (versión 2026-09-26)",
      "Origen: web",
      "Sitio de referencia: example[.]org",
      "UTM: source=linkedin, campaign=fibra-2026",
      "Datos declarados por el visitante, sin verificar:",
      "Nombre: Ana Prueba",
      "Empresa: Fibra Demo",
      "Cargo: Jefa de campo",
      "Email: ana[.]prueba@example[.]com",
    ]) {
      expect(text).toContain(line);
    }
  });

  it("says 'sin empresa' in the subject and '(no lo indicó)' for an absent field", () => {
    const { subject, text } = renderLeadNotice({ ...BASE, company: undefined, name: undefined, jobTitle: "   " });
    expect(subject).toBe("Nuevo lead de la demo Cuadrilla · sin empresa");
    expect(text).toContain("Nombre: (no lo indicó)");
    expect(text).toContain("Cargo: (no lo indicó)");
  });

  it("puts NO CONTACTAR first in the subject and the body without the contact consent", () => {
    const { subject, text } = renderLeadNotice({ ...BASE, contactAccepted: false });
    expect(subject).toBe("NO CONTACTAR · Nuevo lead de la demo Cuadrilla · Fibra Demo");
    expect(text.split("\n")[0]).toBe("NO CONTACTAR: esta persona no aceptó que Craftech la contacte por esta solución.");
    expect(text).toContain("Consentimiento de contacto: no (versión 2026-09-26)");
  });

  it("marks the operator's test notice PRUEBA", () => {
    const { subject, text } = renderLeadNotice({ ...BASE, test: true });
    expect(subject.startsWith("PRUEBA · ")).toBe(true);
    expect(text.split("\n")[0]).toMatch(/^PRUEBA:/);
  });

  it("neutralizes schemes, domains and IP addresses, and keeps a field on one bounded line", () => {
    expect(neutralizeVisitorText("Visita https://ejemplo.com/a?b=1 o www.otro.org")).toBe("Visita ejemplo[.]com/a?b=1 o www[.]otro[.]org");
    expect(neutralizeVisitorText("javascript:alert(1) mailto:x@ejemplo.mx")).toBe("alert(1) x@ejemplo[.]mx");
    expect(neutralizeVisitorText("http://10.0.0.1/x")).toBe("10[.]0[.]0[.]1/x");
    expect(neutralizeVisitorText("uno\r\ndos\u2028tres\u0007")).toBe("uno dos tres");
    expect([...neutralizeVisitorText("a".repeat(500))]).toHaveLength(160);
  });

  it("builds an HTML part that escapes every value and carries no anchor", () => {
    const { html } = renderLeadNotice({ ...BASE, name: '<a href="https://phish.example.com">x</a>', company: "<img src=x onerror=alert(1)>" });
    expect(html).not.toMatch(/<a[\s>]/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;a href=");
    expect(html).toContain('<meta name="format-detection"');
  });

  it("uses no word of ADR-0023 (it is a visible surface)", () => {
    for (const input of [BASE, { ...BASE, contactAccepted: false }, { ...BASE, test: true }]) {
      const { subject, text, html } = renderLeadNotice(input);
      expect(findNeutralTerms("lead-notify", `${subject}\n${text}\n${html}`)).toEqual([]);
    }
  });
});
