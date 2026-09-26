import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CaseReason, ChecklistItem, HazardCategory, PhotoItem, RejectReason, Symptom, TemplateName, WaButtonAction } from "@cuadrilla/shared";
import { DEFAULT_OPERATOR_NAME, type ResolvedBrand, resolveBrand } from "./brand";
import { BUTTON_LABELS, PHOTO_ITEM_BUTTONS, WHATSAPP_LIMITS, buttonTitle, charCount, fitsLimit } from "./buttons";
import { TEMPLATE_GLOSS, enGloss } from "./en-gloss";
import { esMX } from "./es-MX";
import { certificateEmail, certificateFooter, certificateHeader, EMAIL_SENDER_NAMES, validatedBy, zoneChiefSafetyAlert, zoneChiefUnattendedCase } from "./es-MX-documents";
import { findForeignLink, findSensitiveAsk } from "./forbidden";
import { normalizeForMatch, placeholderCount } from "./helpers";
import { CERTIFICATE_TEMPLATE_SAMPLE_KEY, TEMPLATES, renderTemplateBody, templateButtonTitles, templateParamProblem } from "./templates";
import type { CopyPack } from "./types";

const COPY_DIR = dirname(fileURLToPath(import.meta.url));
const PARTNER = { mode: "cobrand", partnerDisplayName: "Socio de Prueba", partnerShortName: "Socio", logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" }, disclaimer: { es: "aviso", en: "notice" } } as const;
const NEUTRAL = resolveBrand({ mode: "neutral" });
const COBRAND = resolveBrand(PARTNER);
const CASE_URL = "https://cuadrilla.demo.craftech.io/app/cases/case-01J9ZQ3V8K2M4N6P8R0T2V4X6Z";

type FunctionKey = { [K in keyof CopyPack]: CopyPack[K] extends (...args: never[]) => unknown ? K : never }[keyof CopyPack];

// Every function of a pack with sample arguments: a new function without samples is a compile error.
const SAMPLES: { readonly [K in FunctionKey]: (pack: CopyPack) => string[] } = {
  brandLine: (pack) => [pack.brandLine(), pack.brandLine("Socio de Prueba")],
  syntheticDemoNotice: (pack) => [pack.syntheticDemoNotice("Socio de Prueba")],
  welcome: (pack) => [pack.welcome("Rogelio", "INSTALLER"), pack.welcome("Adriana", "SUPERVISOR")],
  shiftRegistered: (pack) => [pack.shiftRegistered("07:05 de mañana")],
  closeNotComplete: (pack) => [pack.closeNotComplete([]), pack.closeNotComplete(["ROSETTE_PHOTO"]), pack.closeNotComplete(ChecklistItem.options)],
  leaseBound: (pack) => [pack.leaseBound("Rogelio", 48)],
  caseOpened: (pack) => [pack.caseOpened("Adriana")],
  caseReassigned: (pack) => [pack.caseReassigned("Héctor")],
  caseTaken: (pack) => [pack.caseTaken("Héctor")],
  caseTakenByOther: (pack) => [pack.caseTakenByOther("Héctor")],
  caseBrief: (pack) => [pack.caseBrief({ caseLabel: "C-0412", workOrderNumber: "24818", installerFirstName: "Rogelio", reasonText: "potencia fuera de rango después de 3 pasos", summary: "Tres pasos de §DIAG-03 sin cambio." })],
  caseClosedConfirmation: (pack) => [pack.caseClosedConfirmation("24818", "Rogelio")],
  relayPrefix: (pack) => [pack.relayPrefix("Héctor", "SUPERVISOR"), pack.relayPrefix("Rogelio", "INSTALLER")],
  orderChoiceRow: (pack) => Object.values(pack.orderChoiceRow({ workOrderNumber: "24817", windowText: "09:00 a 11:00", neighborhood: "Col. Las Lomitas" })),
  caseChoiceRow: (pack) => Object.values(pack.caseChoiceRow({ caseLabel: "C-0412", workOrderNumber: "24818", installerFirstName: "Rogelio" })),
  rejectReason: (pack) => RejectReason.options.flatMap((reason) => PhotoItem.options.map((item) => pack.rejectReason(reason, item))),
  caseReason: (pack) => [
    ...CaseReason.options.map((reason) => pack.caseReason({ reason })),
    ...Symptom.options.map((symptom) => pack.caseReason({ reason: "DIAGNOSIS_ATTEMPTS", symptom })),
    ...PhotoItem.options.map((item) => pack.caseReason({ reason: "PHOTO_ATTEMPTS", item })),
    pack.caseReason({ reason: "OTHER", sensitive: "CARD" }),
  ],
};

/** Every text of a pack: plain strings, record values and the samples of every function. */
function packTexts(pack: CopyPack): string[] {
  const texts: string[] = [];
  for (const [key, value] of Object.entries(pack)) {
    if (typeof value === "string") texts.push(value);
    else if (typeof value === "object" && value !== null) texts.push(...Object.values(value as Record<string, string>));
    else texts.push(...SAMPLES[key as FunctionKey](pack));
  }
  return texts;
}

const ALERT = { workOrderNumber: "24819", zoneName: "Norte", zoneChiefFirstName: "Marisol", installerFirstName: "Rogelio", reasonText: "riesgo eléctrico", summary: "Cable de energía pelado en el poste.", caseUrl: CASE_URL, atText: "13/10 15:10" };

function documentTexts(brand: ResolvedBrand): string[] {
  const emails = [
    certificateEmail({ brand, workOrderNumber: "24817", recipient: "CUSTOMER", customerFirstName: "Lucía", closedAtText: "13/10 10:05" }),
    certificateEmail({ brand, workOrderNumber: "24817", recipient: "OPS_MAILBOX", customerFirstName: "Lucía", closedAtText: "13/10 10:05" }),
    zoneChiefSafetyAlert({ brand, ...ALERT }),
    zoneChiefUnattendedCase({ brand, ...ALERT }),
  ];
  return [...emails.flatMap((email) => [email.subject, email.body]), certificateHeader(brand), ...certificateFooter(brand), ...Object.values(EMAIL_SENDER_NAMES)];
}

const templateTexts = TemplateName.options.flatMap((name) => [TEMPLATES[name].body, ...TEMPLATES[name].params.map((param) => param.example), ...templateButtonTitles(name)]);
const ALL_TEXTS = [...packTexts(esMX), ...packTexts(enGloss), ...templateTexts, ...Object.values(TEMPLATE_GLOSS), ...documentTexts(NEUTRAL), ...documentTexts(COBRAND)];

describe("WhatsApp templates (docs/architecture-integrations.md §4.5)", () => {
  it("are exactly the six UTILITY templates in es_MX", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...TemplateName.options].sort());
    for (const name of TemplateName.options) {
      expect(TEMPLATES[name]).toMatchObject({ name, language: "es_MX", category: "UTILITY" });
    }
  });

  it.each(TemplateName.options)("%s: numbered placeholders, one synthetic example each, never at the start or the end", (name) => {
    const { body, params } = TEMPLATES[name];
    expect(placeholderCount(body)).toBe(params.length);
    expect(params.length).toBeGreaterThan(0);
    expect(body.replace(/^[¡¿\s]+/, "")).not.toMatch(/^\{\{/);
    expect(body.replace(/[.!?\s]+$/, "")).not.toMatch(/\}\}$/);
    expect(body).not.toMatch(/\}\}\s*\{\{/);
    for (const param of params) expect(templateParamProblem(param.example)).toBeNull();
    expect(charCount(body)).toBeLessThanOrEqual(WHATSAPP_LIMITS.templateBody);
  });

  it.each(TemplateName.options)("%s: at least three fixed words per parameter", (name) => {
    const { body, params } = TEMPLATES[name];
    const fixedWords = body
      .replace(/\{\{\d+\}\}/g, " ")
      .split(/\s+/)
      .filter((word) => /\p{L}/u.test(word));
    expect(fixedWords.length).toBeGreaterThanOrEqual(3 * params.length);
  });

  it("buttons fit a template quick reply (25) and the plan B reply button (20)", () => {
    for (const name of TemplateName.options) {
      for (const title of templateButtonTitles(name)) {
        expect(fitsLimit(title, WHATSAPP_LIMITS.templateButton)).toBe(true);
        expect(fitsLimit(title, WHATSAPP_LIMITS.replyButton)).toBe(true);
      }
    }
    expect(TEMPLATES.caso_escalado.buttons).toEqual(["TAKE_CASE", "DECLINE_CASE"]);
    expect(TEMPLATES.ordenes_del_dia.buttons).toEqual(["VIEW_ORDERS"]);
  });

  it("only acta_instalacion has a document header, with the synthetic sample of the Seed bucket", () => {
    expect(TEMPLATES.acta_instalacion.header).toEqual({ format: "DOCUMENT", sampleKey: CERTIFICATE_TEMPLATE_SAMPLE_KEY });
    expect(CERTIFICATE_TEMPLATE_SAMPLE_KEY).toBe("templates/acta-muestra.pdf");
    for (const name of TemplateName.options.filter((template) => template !== "acta_instalacion")) expect(TEMPLATES[name].header).toBeUndefined();
  });

  it("render with code-built parameters and reject line breaks or a wrong count", () => {
    const params = TEMPLATES.ordenes_del_dia.params.map((param) => param.example);
    expect(renderTemplateBody("ordenes_del_dia", params)).toBe(
      "Hola Rogelio, hoy tienes 3 instalaciones asignadas en tu ruta. La primera cita es de 09:00 a 11:00. Toca Ver órdenes para recibir el detalle de cada una.",
    );
    expect(() => renderTemplateBody("ordenes_del_dia", ["Rogelio", "3"])).toThrow(/expected 3/);
    expect(() => renderTemplateBody("respuesta_supervisor", ["Héctor\nIbarra", "24818"])).toThrow(/line breaks/);
    expect(templateParamProblem("   ")).not.toBeNull();
    expect(templateParamProblem("a     b")).not.toBeNull();
  });

  it("the English gloss keeps the placeholders of every template", () => {
    for (const name of TemplateName.options) expect(placeholderCount(TEMPLATE_GLOSS[name])).toBe(TEMPLATES[name].params.length);
  });

  it("the case category built by code is the parameter the example shows", () => {
    expect(esMX.caseReason({ reason: "DIAGNOSIS_ATTEMPTS", symptom: "LOW_POWER" })).toBe(TEMPLATES.caso_escalado.params[3]?.example);
    for (const text of SAMPLES.caseReason(esMX)) expect(templateParamProblem(text)).toBeNull();
    // [FL-078] the case of the pre-G1 card block names what it carried, never the number.
    expect(esMX.caseReason({ reason: "OTHER", sensitive: "CARD" })).toBe("datos de tarjeta");
    expect(esMX.caseReason({ reason: "OTHER" })).toBe("otro motivo");
    for (const hazard of HazardCategory.options) expect(templateParamProblem(esMX.hazard[hazard])).toBeNull();
  });
});

describe("resolveBrand (ADR-0018)", () => {
  it("neutral: the fictitious default operator, tagged, with the plain brand line and no disclaimer", () => {
    expect(NEUTRAL).toMatchObject({ mode: "neutral", operatorName: DEFAULT_OPERATOR_NAME, brandLine: "Cuadrilla · Powered by Craftech", disclaimer: null, logoAssetKeys: null });
    expect(NEUTRAL.tag).toEqual({ es: "ficticia", en: "fictitious" });
    expect(NEUTRAL.notice.es).toMatch(/ficticia/);
  });

  it("cobrand: the partner from the configuration, the co-branding line and the mandatory disclaimer", () => {
    expect(COBRAND).toMatchObject({ mode: "cobrand", operatorName: "Socio de Prueba", operatorShortName: "Socio", brandLine: "Cuadrilla for Socio de Prueba · Powered by Craftech" });
    expect(COBRAND.disclaimer?.es).toBe("Demo sintética: el manual, las políticas y los datos son inventados y no son las políticas reales de Socio de Prueba.");
    expect(COBRAND.disclaimer?.en).toContain("Socio de Prueba");
    expect(COBRAND.notice).toEqual(COBRAND.disclaimer);
    expect(COBRAND.tag.es).toBe("demo sintética");
    expect(COBRAND.logoAssetKeys).toEqual(PARTNER.logoAssetKeys);
    expect(JSON.stringify(COBRAND)).not.toContain(DEFAULT_OPERATOR_NAME);
  });

  it("rejects an invalid configuration instead of drawing a wrong brand", () => {
    expect(() => resolveBrand({ mode: "cobrand" } as never)).toThrow();
    expect(() => resolveBrand({ mode: "neutral", partnerDisplayName: "x" } as never)).toThrow();
    expect(() => resolveBrand({ ...PARTNER, logoAssetKeys: { onLight: "partner.png", onDark: "brand/x.svg" } } as never)).toThrow();
  });
});

describe("nothing static names the operator", () => {
  const forms = [DEFAULT_OPERATOR_NAME, DEFAULT_OPERATOR_NAME.split(" ")[0] ?? DEFAULT_OPERATOR_NAME].map(normalizeForMatch);

  it("no file of copy/ other than brand.ts contains the default operator's name", () => {
    const files = readdirSync(COPY_DIR).filter((file) => file.endsWith(".ts") && file !== "brand.ts");
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      const text = normalizeForMatch(readFileSync(join(COPY_DIR, file), "utf8"));
      for (const form of forms) expect(text.includes(form), `${file} names the default operator`).toBe(false);
    }
  });

  it("no rendered text, template or example contains it, and templates never say which operator", () => {
    for (const text of [...packTexts(esMX), ...packTexts(enGloss), ...templateTexts, ...Object.values(TEMPLATE_GLOSS)]) {
      for (const form of forms) expect(normalizeForMatch(text)).not.toContain(form);
    }
    for (const name of TemplateName.options) expect(normalizeForMatch(TEMPLATES[name].body)).not.toContain("operadora");
  });

  it("the visible email senders are generic in both modes", () => {
    expect(EMAIL_SENDER_NAMES).toEqual({ certificates: "Cuadrilla · Actas", alerts: "Cuadrilla · Alertas" });
  });
});

describe("no fixed text breaks the outbound rules", () => {
  it("no text asks for an ID, bank or card data, a password or a payment (CP-NO-SENSITIVE-ASK)", () => {
    expect(ALL_TEXTS.length).toBeGreaterThan(150);
    for (const text of ALL_TEXTS) expect(findSensitiveAsk(text), text).toBeNull();
  });

  it("no text carries a link, domain, email or phone, except the console link of a zone chief alert (CP-NO-FOREIGN-LINKS)", () => {
    for (const text of ALL_TEXTS) expect(findForeignLink(text, { allowedUrls: [CASE_URL] }), text).toBeNull();
    expect(findForeignLink(zoneChiefSafetyAlert({ brand: NEUTRAL, ...ALERT }).body)).toBe("url");
  });
});

describe("fixed notices of es-MX.ts", () => {
  it("[FL-050] closeNotComplete lists the missing items in checklist order", () => {
    expect(esMX.closeNotComplete(["ROSETTE_PHOTO"])).toBe("Todavía no puedo cerrar la instalación. Falta: la foto de la roseta instalada.");
    expect(esMX.closeNotComplete(["CUSTOMER_OK", "ROSETTE_PHOTO", "CUSTOMER_OK"])).toBe(
      "Todavía no puedo cerrar la instalación. Faltan: la foto de la roseta instalada y la conformidad del cliente.",
    );
    expect(esMX.closeNotComplete(["ROSETTE_PHOTO", "ONU_ONLINE", "POWER_READING_PHOTO"])).toMatch(/Faltan: la ONU en línea .*, la foto de la lectura del medidor y la foto de la roseta instalada\.$/);
    expect(esMX.closeNotComplete([])).toMatch(/en espera/);
  });

  it("[FL-067] the safety instruction is one fixed text with §SEG-01's content and no parameter", () => {
    expect(typeof esMX.safetyInstruction).toBe("string");
    for (const fragment of ["No toques el cable", "escalera", "al menos 10 metros", "avisa a las personas", "señaliza", "no reanudes"]) expect(esMX.safetyInstruction).toContain(fragment);
    expect(esMX.safetyInstruction).not.toMatch(/\{|\$|<|>/);
    expect(enGloss.safetyInstruction).toMatch(/10 meters/);
  });

  it("every rejection reason has an actionable text for every photo item", () => {
    for (const item of PhotoItem.options) {
      const texts = RejectReason.options.map((reason) => esMX.rejectReason(reason, item));
      expect(new Set(texts).size).toBe(RejectReason.options.length);
      for (const text of texts) expect(text).toMatch(/^[A-ZÁÉÍÓÚÑ].{20,280}\.$/u);
    }
    expect(esMX.rejectReason("GLARE", "ONU_LABEL_PHOTO")).toBe("Hay reflejo sobre la etiqueta de la ONU y no se lee el serial: inclina un poco el teléfono y apaga el flash.");
  });

  it("the bridge prefixes name the person and their role", () => {
    expect(esMX.relayPrefix("Héctor", "SUPERVISOR")).toBe("Héctor (supervisor): ");
    expect(esMX.relayPrefix("Rogelio", "INSTALLER")).toBe("Rogelio (instalador): ");
  });

  it("the brand line and the disclaimer take the partner's name as a parameter", () => {
    expect(esMX.brandLine()).toBe("Cuadrilla · Powered by Craftech");
    expect(esMX.brandLine("Socio de Prueba")).toBe("Cuadrilla for Socio de Prueba · Powered by Craftech");
    expect(esMX.syntheticDemoNotice("Socio de Prueba")).toMatch(/^Demo sintética: .* Socio de Prueba\.$/);
  });

  it("list rows fit WhatsApp's limits", () => {
    for (const pack of [esMX, enGloss]) {
      const order = pack.orderChoiceRow({ workOrderNumber: "24817", windowText: "09:00 a 11:00", neighborhood: "Col. Las Lomitas" });
      const kase = pack.caseChoiceRow({ caseLabel: "C-0412", workOrderNumber: "24818", installerFirstName: "Rogelio" });
      for (const row of [order, kase]) {
        expect(fitsLimit(row.title, WHATSAPP_LIMITS.listRowTitle)).toBe(true);
        expect(fitsLimit(row.description, WHATSAPP_LIMITS.listRowDescription)).toBe(true);
      }
    }
  });
});

describe("buttons (docs/architecture-integrations.md §4.1)", () => {
  it("every action and photo item has a reply-button title of at most 20 characters and a gloss", () => {
    for (const action of WaButtonAction.options) {
      expect(fitsLimit(BUTTON_LABELS[action].es, WHATSAPP_LIMITS.replyButton), action).toBe(true);
      expect(BUTTON_LABELS[action].en.trim()).not.toBe("");
    }
    for (const item of PhotoItem.options) expect(fitsLimit(PHOTO_ITEM_BUTTONS[item].es, WHATSAPP_LIMITS.replyButton)).toBe(true);
    expect(charCount("Cerrar instalación")).toBe(18);
  });

  it("an item title only goes with CHOOSE_ITEM", () => {
    expect(buttonTitle("CHOOSE_ITEM", "ROSETTE_PHOTO")).toBe("Roseta instalada");
    expect(buttonTitle("CLOSE_INSTALLATION")).toBe("Cerrar instalación");
    expect(buttonTitle("CUSTOMER_OK", undefined, "en")).toBe("Customer OK");
    expect(() => buttonTitle("CUSTOMER_OK", "ROSETTE_PHOTO")).toThrow(/CHOOSE_ITEM/);
  });
});

describe("documents (es-MX-documents.ts)", () => {
  it("certificate email: operator in the subject with its tag, brand first and notice last", () => {
    const neutral = certificateEmail({ brand: NEUTRAL, workOrderNumber: "24817", recipient: "CUSTOMER", customerFirstName: "Lucía", closedAtText: "13/10 10:05" });
    expect(neutral.subject).toBe(`Acta de instalación · Orden 24817 · ${DEFAULT_OPERATOR_NAME} (ficticia)`);
    const cobrand = certificateEmail({ brand: COBRAND, workOrderNumber: "24817", recipient: "OPS_MAILBOX", customerFirstName: "Lucía", closedAtText: "13/10 10:05" });
    expect(cobrand.subject).toBe("Acta de instalación · Orden 24817 · Socio de Prueba (demo sintética)");
    const lines = cobrand.body.split("\n");
    expect(lines[0]).toBe(COBRAND.brandLine);
    expect(lines[lines.length - 1]).toBe(COBRAND.disclaimer?.es);
  });

  it("zone chief alerts: subjects of docs/architecture-integrations.md §1 and the console link", () => {
    expect(zoneChiefSafetyAlert({ brand: NEUTRAL, ...ALERT }).subject).toBe("[Cuadrilla] Alerta de seguridad · Orden 24819 · Zona Norte");
    expect(zoneChiefUnattendedCase({ brand: NEUTRAL, ...ALERT, workOrderNumber: "24818" }).subject).toBe("[Cuadrilla] Caso sin atender · Orden 24818");
    expect(zoneChiefSafetyAlert({ brand: COBRAND, ...ALERT }).subject).toMatch(/\(demo sintética\)$/);
    expect(zoneChiefUnattendedCase({ brand: COBRAND, ...ALERT }).body).toContain(`Ver el caso en la consola: ${CASE_URL}`);
  });

  it("certificate header and footer follow the brand mode", () => {
    expect(certificateHeader(COBRAND)).toBe("Socio de Prueba · Cuadrilla");
    expect(certificateFooter(NEUTRAL)).toEqual(["Documento sintético · datos ficticios · Cuadrilla · Powered by Craftech"]);
    expect(certificateFooter(COBRAND)).toEqual([COBRAND.brandLine, COBRAND.disclaimer?.es]);
    expect(validatedBy({ by: "PERSON", name: "Adriana Solís", reason: "lectura legible en la segunda foto" })).toMatch(/^validado manualmente por Adriana Solís: /);
  });
});
