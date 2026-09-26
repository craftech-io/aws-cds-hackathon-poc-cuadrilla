// Synthetic sample of the document header of the `acta_instalacion` template
// (`Seed/templates/acta-muestra.pdf`, docs/architecture-integrations.md §4.5): the file Meta reviews
// with the template. One A4 page with the certificate's labels from copy/ and example values, marked
// as a sample, with no operator name (ADR-0018). A tiny PDF writer with the standard Helvetica
// fonts, WinAnsi encoding and no creation date: the same input gives the same bytes.
import { ChecklistItem } from "@cuadrilla/shared";
import { resolveBrand } from "../../../packages/bff/src/copy/brand";
import { esMX } from "../../../packages/bff/src/copy/es-MX";
import { CERTIFICATE_LABELS, certificateFileName, certificateFooter } from "../../../packages/bff/src/copy/es-MX-documents";
import { formatDbm } from "../../../packages/bff/src/copy/helpers";

export const ACTA_SAMPLE_FILE = "scripts/seed/photos/templates/acta-muestra.pdf";

/** Example values: the story order with a first name only, no phone, no email, no operator. */
const SAMPLE = {
  workOrderNumber: "24817",
  closedAt: "13/10/2026 10:05",
  installer: "Rogelio",
  customer: "Lucía",
  address: "Calle Jacaranda 214, Col. Las Lomitas",
  plan: "Fibra 300",
  onuSerial: "DEMO3F2C19A0",
  rxPowerDbm: -21.4,
  opticalClass: "B+",
} as const;

const SAMPLE_MARK = "MUESTRA";
const SAMPLE_NOTE = "Muestra sintética del encabezado de la plantilla acta_instalacion: datos ficticios, sin valor.";

interface Line {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly bold?: boolean;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A PDF string literal in WinAnsi (Latin-1 for these texts), escaping `\`, `(` and `)`. */
function pdfString(text: string): string {
  const bytes = [...text].map((char) => {
    const code = char === "·" ? 0xb7 : (char.codePointAt(0) ?? 0);
    if (code > 0xff) throw new RangeError(`"${char}" is not in the PDF's WinAnsi encoding`);
    return code;
  });
  return `(${bytes.map((code) => (code === 0x5c || code === 0x28 || code === 0x29 ? `\\${String.fromCharCode(code)}` : String.fromCharCode(code))).join("")})`;
}

function contentStream(): string {
  const [footer = ""] = certificateFooter(resolveBrand({ mode: "neutral" }));
  const rows: Array<readonly [string, string]> = [
    [CERTIFICATE_LABELS.workOrder, SAMPLE.workOrderNumber],
    [CERTIFICATE_LABELS.date, SAMPLE.closedAt],
    [CERTIFICATE_LABELS.installer, SAMPLE.installer],
    [CERTIFICATE_LABELS.customer, SAMPLE.customer],
    [CERTIFICATE_LABELS.address, SAMPLE.address],
    [CERTIFICATE_LABELS.plan, SAMPLE.plan],
    [CERTIFICATE_LABELS.onuSerial, SAMPLE.onuSerial],
    [CERTIFICATE_LABELS.rxPower, formatDbm(SAMPLE.rxPowerDbm, true)],
    [CERTIFICATE_LABELS.opticalClass, SAMPLE.opticalClass],
  ];
  const lines: Line[] = [
    { text: `${CERTIFICATE_LABELS.title} · ${SAMPLE_MARK}`, x: 56, y: 770, size: 20, bold: true },
    { text: SAMPLE_NOTE, x: 56, y: 748, size: 9 },
    ...rows.flatMap(([label, value], index) => [
      { text: label, x: 56, y: 700 - index * 24, size: 11, bold: true },
      { text: value, x: 220, y: 700 - index * 24, size: 11 },
    ]),
    { text: CERTIFICATE_LABELS.checklist, x: 56, y: 460, size: 12, bold: true },
    ...ChecklistItem.options.map((item, index) => ({
      text: `${capitalize(esMX.checklistItem[item])}: ${CERTIFICATE_LABELS.statusPassed}`,
      x: 72,
      y: 436 - index * 20,
      size: 10,
    })),
    { text: `${CERTIFICATE_LABELS.photos}: 3`, x: 56, y: 320, size: 11, bold: true },
    { text: certificateFileName(SAMPLE.workOrderNumber), x: 56, y: 296, size: 9 },
    { text: footer, x: 56, y: 60, size: 9 },
  ];
  const text = lines.map((line) => `BT /${line.bold === true ? "F2" : "F1"} ${line.size} Tf ${line.x} ${line.y} Td ${pdfString(line.text)} Tj ET`);
  const watermark = `q 0.9 g BT /F2 96 Tf 0.7071 0.7071 -0.7071 0.7071 150 250 Tm ${pdfString(SAMPLE_MARK)} Tj ET Q`;
  const rules = "0.6 G 1 w 56 740 m 539 740 l S 56 480 m 539 480 l S 56 80 m 539 80 l S";
  return [watermark, rules, ...text].join("\n");
}

/** The PDF bytes. Objects: catalog, pages, page, two fonts, content, info (no dates). */
export function actaSamplePdf(): Buffer {
  const content = contentStream();
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    `<< /Title ${pdfString(`${CERTIFICATE_LABELS.title} · ${SAMPLE_MARK}`)} /Producer (Cuadrilla seed) >>`,
  ];
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
