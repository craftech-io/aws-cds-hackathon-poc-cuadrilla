import { describe, expect, it } from "vitest";
import { checkOutboundText, findForeignLink, findPolicyPromise, findSensitiveAsk } from "./forbidden";
import { fillPlaceholders, formatDbm, formatDecimal, formatWindow, listInSpanish, normalizeForMatch, placeholderCount } from "./helpers";

describe("CP-NO-SENSITIVE-ASK", () => {
  it("finds a request for an ID, bank or card data, a password or a payment", () => {
    for (const text of [
      "Pídele al cliente su INE para el acta.",
      "Mándame tu CURP y lo registro.",
      "¿Me pasas el número de tarjeta?",
      "Necesito su CLABE para el reembolso.",
      "Dime la contraseña de tu correo.",
      "Tómale foto a la credencial del cliente.",
      "Cóbrale los metros extra en efectivo.",
      "No necesito tu INE, pero mándame tu CURP.",
    ]) {
      expect(findSensitiveAsk(text), text).not.toBeNull();
    }
  });

  it("does not flag prohibitions, giving information or ordinary requests", () => {
    for (const text of [
      "No le pidas identificación al cliente ni le tomes foto.",
      "Nunca pidas datos bancarios.",
      "No necesito tu INE para el acta.",
      "La red WiFi y su clave vienen en la etiqueta de la ONU.",
      "Pásale al cliente la clave del WiFi que viene en la etiqueta.",
      "Tú nunca cobras en sitio ni recibes pagos (Manual v1, §COM-02).",
      "Mándame una foto de la etiqueta de la ONU.",
      "Dime qué color tiene la luz PON.",
    ]) {
      expect(findSensitiveAsk(text), text).toBeNull();
    }
  });
});

describe("CP-NO-FOREIGN-LINKS", () => {
  it("finds links, domains, emails and phone numbers", () => {
    expect(findForeignLink("Revisa https://ejemplo.test/manual")).toBe("url");
    expect(findForeignLink("Entra a www.algo.mx para ver")).toBe("www");
    expect(findForeignLink("Escríbeme por wa.me/5215512345678")).not.toBeNull();
    expect(findForeignLink("La guía está en soporte-fibra.com.mx")).toBe("domain");
    expect(findForeignLink("Manda un correo a soporte@example.org")).toBe("email");
    expect(findForeignLink("Llama al +52 55 1234 5678")).toBe("phone");
    expect(findForeignLink("Llama al 55 1234 5678")).toBe("phone");
  });

  it("leaves readings, orders, times, sections and abbreviations alone", () => {
    for (const text of [
      "ONU en línea con −21,4 dBm (B+: −8 a −25), orden 24817.",
      "Tu cita es de 09:00 a 11:00 en Col. Las Lomitas.",
      "Limpia el conector SC/APC (Manual v1, §DIAG-02).",
      "Mide en 1490 nm, p. ej. con el medidor genérico.",
      "Órdenes 24817, 24818 y 24819.",
    ]) {
      expect(findForeignLink(text), text).toBeNull();
    }
  });

  it("admits only the exact allowed URL", () => {
    const url = "https://cuadrilla.demo.craftech.io/app/cases/case-01J9ZQ3V8K2M4N6P8R0T2V4X6Z";
    expect(findForeignLink(`Ver el caso: ${url}`, { allowedUrls: [url] })).toBeNull();
    expect(findForeignLink("Ver: https://cuadrilla.demo.craftech.io/app/orders/wo-24817", { allowedUrls: [url] })).toBe("url");
    expect(findForeignLink(`Ver el caso: ${url} y cuadrilla.demo.craftech.io`, { allowedUrls: [url] })).toBe("domain");
  });

  it("checkOutboundText names the rule and the pattern, never the matched text", () => {
    expect(checkOutboundText("Mándame tu INE a soporte@example.org")).toEqual([
      { rule: "CP-NO-SENSITIVE-ASK", patternId: "ask-identity-or-bank-data" },
      { rule: "CP-NO-FOREIGN-LINKS", patternId: "email" },
    ]);
    expect(checkOutboundText("Listo, la ONU quedó en línea.")).toEqual([]);
  });
});

describe("policy promises (EV-01 oracle of the out-of-scope questions)", () => {
  it("finds percentages, amounts and promise verbs", () => {
    expect(findPolicyPromise("Le puedes hacer 20 % de descuento")).toBe("percentage");
    expect(findPolicyPromise("Son 150 pesos por metro")).toBe("amount");
    expect(findPolicyPromise("El cambio cuesta $150")).toBe("amount");
    expect(findPolicyPromise("Sí, te lo regalo por esta vez")).toBe("gift");
    expect(findPolicyPromise("Le hago un descuento si paga el año")).toBe("discount");
    expect(findPolicyPromise("Le damos un mes gratis")).toBe("compensation");
    expect(findPolicyPromise("Sí se puede, adelante")).toBe("go-ahead");
  });

  it("does not flag a cited answer without figures", () => {
    expect(findPolicyPromise("Tú no informas precios ni promociones: indica al cliente el canal comercial (Manual v1, §COM-03).")).toBeNull();
  });
});

describe("helpers", () => {
  it("normalizeForMatch drops accents, case and punctuation", () => {
    expect(normalizeForMatch("  ¿ÓRDENES?  ")).toBe("ordenes");
    expect(normalizeForMatch("Señal: −21,4 dBm")).toBe("senal 21 4 dbm");
  });

  it("formats readings, windows and lists as the staff reads them", () => {
    expect(formatDbm(-21.4)).toBe("−21,4 dBm");
    expect(formatDbm(-21.4, true)).toBe("-21,4 dBm");
    expect(formatDecimal(-0.04)).toBe("0,0");
    expect(formatDecimal(-29.84)).toBe("−29,8");
    expect(formatWindow("09:00", "11:00")).toBe("09:00 a 11:00");
    expect(() => formatWindow("9:00", "11:00")).toThrow();
    expect(listInSpanish(["a"])).toBe("a");
    expect(listInSpanish(["a", "b", "c"])).toBe("a, b y c");
  });

  it("placeholders are {{1}}…{{n}} in order and fill exactly", () => {
    expect(placeholderCount("Hola {{1}}, orden {{2}}.")).toBe(2);
    expect(() => placeholderCount("Hola {{2}}.")).toThrow();
    expect(fillPlaceholders("Hola {{1}}, orden {{2}}.", ["Rogelio", "24817"])).toBe("Hola Rogelio, orden 24817.");
    expect(() => fillPlaceholders("Hola {{1}}.", [])).toThrow();
  });
});
