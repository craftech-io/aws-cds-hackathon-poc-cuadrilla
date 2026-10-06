import { describe, expect, it } from "vitest";
import { resolveBrand } from "../copy/brand";
import { CERTIFICATE_LABELS } from "../copy/es-MX-documents";
import { esMX } from "../copy/es-MX";
import type { CertificateContent } from "./content";
import { InvalidJpegError, jpegInfo } from "./jpeg";
import { writePdf } from "./pdf";
import { pdfString, wrapText } from "./pdf-text";
import { certificateBrand, renderCertificatePdf } from "./render";
import { CLOSED_AT, EV_3, SEED_PHOTOS, mx, readPdf, seedPhoto } from "./testing";

const PARTNER = { mode: "cobrand", partnerDisplayName: "Operadora Socia Demo", partnerShortName: "Socia Demo", logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" }, disclaimer: { es: "aviso", en: "notice" } } as const;

const CONTENT: CertificateContent = {
  workOrderNumber: "24817",
  closedAtSim: CLOSED_AT,
  installerName: "Rogelio Méndez",
  customer: { firstName: "Lucía", addressLine: "Calle Jacaranda 214", neighborhood: "Las Lomitas" },
  plan: "Fibra 300",
  onuSerial: "DEMO3F2C19A0",
  rxPowerDbm: -21.4,
  opticalClass: "B+",
  acceptanceRange: { minDbm: -27, maxDbm: -8 },
  items: [
    { item: "ONU_ONLINE", status: "PASSED", validatedAtSim: mx("2026-10-13 09:55") },
    { item: "POWER_READING_PHOTO", status: "PASSED", validatedBy: "validado por el validador de fotos", validatedAtSim: mx("2026-10-13 09:45") },
    { item: "ONU_LABEL_PHOTO", status: "PASSED", validatedBy: "validado por el validador de fotos", validatedAtSim: mx("2026-10-13 09:46") },
    { item: "ROSETTE_PHOTO", status: "OVERRIDDEN", validatedBy: "validado manualmente por Adriana Robles: roseta fijada y conector visible", validatedAtSim: mx("2026-10-13 09:58") },
    { item: "CUSTOMER_OK", status: "PASSED", validatedAtSim: mx("2026-10-13 10:03") },
  ],
  photos: [
    { item: "POWER_READING_PHOTO", evidenceId: SEED_PHOTOS.POWER_READING_PHOTO.evidenceId, sha256: "1".repeat(64) },
    { item: "ONU_LABEL_PHOTO", evidenceId: SEED_PHOTOS.ONU_LABEL_PHOTO.evidenceId, sha256: "2".repeat(64) },
    { item: "ROSETTE_PHOTO", evidenceId: EV_3, sha256: "3".repeat(64) },
  ],
};

function photos(): Map<string, Uint8Array> {
  return new Map(Object.values(SEED_PHOTOS).map(({ photoId, evidenceId }) => [evidenceId, seedPhoto(photoId)]));
}

const NEUTRAL = resolveBrand({ mode: "neutral" });

describe("certificate PDF writer [FL-047]", () => {
  it("[FL-047] gives the same bytes for the same content, brand and photos, with no date anywhere", async () => {
    const first = renderCertificatePdf({ content: CONTENT, brand: NEUTRAL, photos: photos() });
    const second = renderCertificatePdf({ content: CONTENT, brand: NEUTRAL, photos: photos() });
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const source = Buffer.from(first).toString("latin1");
    expect(source.startsWith("%PDF-1.4\n")).toBe(true);
    expect(source.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(source).not.toMatch(/CreationDate|ModDate|\/ID\s*\[/);
    const { info } = await readPdf(first);
    expect(info).not.toHaveProperty("CreationDate");
    expect(info.Title).toBe(`${CERTIFICATE_LABELS.title} · ${CERTIFICATE_LABELS.workOrder} 24817`);
  });

  it("[FL-047] has extractable text: order, serial, power, class, the five items and who validated them", async () => {
    const { text, pages } = await readPdf(renderCertificatePdf({ content: CONTENT, brand: NEUTRAL, photos: photos() }));
    expect(pages).toBe(1);
    for (const expected of ["24817", "DEMO3F2C19A0", "-21,4 dBm", "B+", "Rogelio Méndez", "Lucía", "Calle Jacaranda 214, Las Lomitas", "Fibra 300", "13/10/2026 10:05"]) expect(text).toContain(expected);
    for (const item of ["ONU_ONLINE", "POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "CUSTOMER_OK"] as const) {
      const name = esMX.checklistItem[item];
      expect(text.toLowerCase()).toContain(name.toLowerCase());
    }
    expect(text).toContain("Validado manualmente por Adriana Robles");
    expect(text).toContain(CERTIFICATE_LABELS.statusOverridden);
    expect(text).toContain(`${CERTIFICATE_LABELS.photos}: 3`);
  });

  it("[FL-047] embeds the three photos as JPEG (DCTDecode) and paints each once", async () => {
    const bytes = renderCertificatePdf({ content: CONTENT, brand: NEUTRAL, photos: photos() });
    const source = Buffer.from(bytes).toString("latin1");
    expect(source.match(/\/Subtype \/Image/g)).toHaveLength(3);
    expect(source.match(/\/Filter \/DCTDecode/g)).toHaveLength(3);
    expect((await readPdf(bytes)).images).toBe(3);
    // A photo whose bytes are missing is left out, never drawn empty.
    const two = new Map(photos());
    two.delete(EV_3);
    const reading = await readPdf(renderCertificatePdf({ content: CONTENT, brand: NEUTRAL, photos: two }));
    expect(reading.images).toBe(2);
    expect(reading.text).toContain(`${CERTIFICATE_LABELS.photos}: 2`);
  });

  it("[FL-047] carries the text brand: the fictitious operator in neutral mode, the partner and the synthetic-demo notice in co-branding", async () => {
    const neutral = (await readPdf(renderCertificatePdf({ content: CONTENT, brand: NEUTRAL, photos: new Map() }))).text;
    expect(neutral).toContain(NEUTRAL.operatorName);
    expect(neutral).toContain("Documento sintético · datos ficticios");

    const cobrand = certificateBrand({ displayName: PARTNER.partnerDisplayName }, PARTNER);
    expect(cobrand.mode).toBe("cobrand");
    const text = (await readPdf(renderCertificatePdf({ content: CONTENT, brand: cobrand, photos: new Map() }))).text;
    expect(text).toContain(`${PARTNER.partnerDisplayName} · Cuadrilla`);
    expect(text).toContain(cobrand.brandLine);
    expect(text).toContain(cobrand.disclaimer?.es ?? "missing");
    expect(text).not.toContain(NEUTRAL.operatorName);
  });

  it("uses the neutral brand for a world that is not the partner's, or without the configuration", () => {
    expect(certificateBrand({ displayName: NEUTRAL.operatorName }, PARTNER).mode).toBe("neutral");
    expect(certificateBrand({ displayName: PARTNER.partnerDisplayName }, undefined).mode).toBe("neutral");
    expect(certificateBrand(undefined, { mode: "neutral" }).mode).toBe("neutral");
  });

  it("wraps long values and breaks onto a second page with its number", async () => {
    const reason = `validado manualmente por Adriana Robles: ${"la roseta quedó fijada con dos taquetes y el conector se ve limpio ".repeat(6)}`;
    const long = { ...CONTENT, items: CONTENT.items.map((item) => (item.item === "ROSETTE_PHOTO" ? { ...item, validatedBy: reason } : item)) };
    expect(wrapText(reason, 300, 10).length).toBeGreaterThan(3);
    const blocks = Array.from({ length: 70 }, (_, index) => ({ kind: "field" as const, label: `Campo ${index}`, value: "valor" }));
    const reading = await readPdf(writePdf({ info: { Title: "t" }, header: [], blocks, footer: ["pie"] }));
    expect(reading.pages).toBe(2);
    expect(reading.text).toContain("1/2");
    expect(reading.text).toContain("2/2");
    expect((await readPdf(renderCertificatePdf({ content: long, brand: NEUTRAL, photos: photos() }))).text).toContain("dos taquetes");
  });

  it("writes WinAnsi text: accents as octal bytes, parentheses escaped, anything outside the encoding as ?", () => {
    expect(pdfString("Lucía (cliente)")).toBe("(Luc\\355a \\(cliente\\))");
    expect(pdfString("ok ✅")).toBe("(ok ?)");
    expect(pdfString("línea\nnueva")).toBe("(l\\355nea nueva)");
  });

  it("reads the JPEG header and refuses what DCTDecode would not show", () => {
    expect(jpegInfo(seedPhoto("ph-meter-01"))).toEqual({ width: 1280, height: 960, components: 3 });
    expect(() => jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(InvalidJpegError);
    expect(() => jpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrow(InvalidJpegError);
    expect(() => writePdf({ info: {}, header: [], footer: [], blocks: [{ kind: "images", images: [{ jpeg: new Uint8Array([1, 2, 3]), caption: "x" }] }] })).toThrow(InvalidJpegError);
  });

  it("refuses a date in the information dictionary", () => {
    expect(() => writePdf({ info: { CreationDate: "D:20261013" }, header: [], footer: [], blocks: [] })).toThrow(RangeError);
  });
});
