import { describe, expect, it } from "vitest";
import { detectLanguage, isInLanguage } from "./language";

// Texts to the staff, as the agent and copy/ write them (es-MX, tuteo).
const SPANISH_TEXTS = [
  "Revisa que el cordón esté conectado a la roseta y a la ONU; limpia el conector SC/APC (Manual v1, §DIAG-02).",
  "Listo. Para cerrar mándame 3 fotos: la lectura del medidor, la etiqueta de la ONU y la roseta.",
  "Hasta 15 m de cable dentro del domicilio no tiene costo. Tú nunca cobras en sitio (Manual v1, §COM-04).",
  "Hay reflejo sobre la etiqueta y no se lee el serial: inclina el teléfono y apaga el flash.",
  "Escalé tu caso a Adriana, tu supervisora de turno.",
  "No está en el manual; ¿quieres que lo consulte con tu supervisora?",
  "Hoy tienes 3 instalaciones. La primera es de 09:00 a 11:00.",
];

// English texts that must never reach an installer: glosses and a model that switched language.
const ENGLISH_TEXTS = [
  "Clean the connector and check that the cord is plugged into the rosette. Then send me a photo of the meter reading.",
  "There is glare on the label: tilt the phone and turn off the flash.",
  "Your case was escalated to your shift supervisor; they'll reply here.",
  "Today you have 3 installations. The first one is from 09:00 to 11:00.",
];

describe("detectLanguage", () => {
  it("recognizes the Spanish of the messages to the staff, tuteo included", () => {
    for (const text of SPANISH_TEXTS) expect(detectLanguage(text).language, text).toBe("es");
  });

  it("recognizes English, even with the product's and the manual's tokens in it", () => {
    for (const text of ENGLISH_TEXTS) expect(detectLanguage(text).language, text).toBe("en");
  });

  it("does not guess on texts without enough evidence", () => {
    for (const text of ["", "OK", "24817", "DEMO3F2C19A0", "−21,4 dBm", "ONU PON", "[CURP] [TELEFONO]", "https://cuadrilla.demo.craftech.io/app"]) {
      expect(detectLanguage(text).language, text).toBe("und");
    }
  });

  it("calls a half-and-half text undecided instead of picking a side", () => {
    expect(detectLanguage("Hola, please send la foto").language).toBe("und");
  });

  it("ignores masked markers, links and emails, and handles decomposed accents", () => {
    expect(detectLanguage("Te paso el [CURP] y la [CLABE] de la señora").language).toBe("es");
    expect(detectLanguage("Please write to ops@simulator.amazonses.com or visit https://example.test/de/la/que").language).toBe("en");
    expect(detectLanguage("Instalación lista, gracias").language).toBe("es");
  });

  it("is deterministic and reports its evidence", () => {
    const text = SPANISH_TEXTS[1] ?? "";
    expect(detectLanguage(text)).toEqual(detectLanguage(text));
    expect(detectLanguage(text).es).toBeGreaterThan(detectLanguage(text).en);
  });
});

describe("isInLanguage", () => {
  it("is true only for the detected language", () => {
    expect(isInLanguage(SPANISH_TEXTS[0] ?? "", "es")).toBe(true);
    expect(isInLanguage(SPANISH_TEXTS[0] ?? "", "en")).toBe(false);
    expect(isInLanguage(ENGLISH_TEXTS[0] ?? "", "en")).toBe(true);
    expect(isInLanguage("OK", "es")).toBe(false);
    expect(isInLanguage("OK", "en")).toBe(false);
  });
});
