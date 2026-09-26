// Texts of the documents Cuadrilla sends by email and prints in the certificate PDF, in Mexican
// Spanish (ADR-0013). Companion of es-MX.ts, split only by size. The operator's name always comes
// from the resolved brand (brand.ts, ADR-0018): the visible sender stays generic in both modes and
// the name goes in the subject and the body; in co-branding the first line of every email body is
// the brand line and the last one the synthetic-demo disclaimer. No customer phone or email is ever
// a parameter: the certificate shows the customer's first name, street and neighborhood only.
import { type ResolvedBrand, operatorLabel } from "./brand";

/** Visible sender names; never the operator's name (it would sit in the `From` header). */
export const EMAIL_SENDER_NAMES = { certificates: "Cuadrilla · Actas", alerts: "Cuadrilla · Alertas" } as const;

export interface EmailText {
  readonly subject: string;
  /** Plain text; the HTML part is generated from it. */
  readonly body: string;
}

/** `acta-24817.pdf`: attachment and WhatsApp document name. */
export function certificateFileName(workOrderNumber: string): string {
  if (!/^\d{5}$/.test(workOrderNumber)) throw new RangeError(`expected a 5-digit work order number, got "${workOrderNumber}"`);
  return `acta-${workOrderNumber}.pdf`;
}

/** Closing line of every email and of the certificate: the disclaimer, or the synthetic-data note. */
function closingNotice(brand: ResolvedBrand): string {
  return brand.disclaimer?.es ?? brand.notice.es;
}

function body(brand: ResolvedBrand, lines: readonly string[]): string {
  return [brand.brandLine, "", ...lines, "", closingNotice(brand)].join("\n");
}

export interface CertificateEmailInput {
  readonly brand: ResolvedBrand;
  readonly workOrderNumber: string;
  readonly recipient: "CUSTOMER" | "OPS_MAILBOX";
  readonly customerFirstName: string;
  /** Simulated date and time of the closing, already formatted ("martes 13/10/2026, 10:05"). */
  readonly closedAtText: string;
}

/** `CERTIFICATE_EMAIL` to the customer or to the operations mailbox, with the PDF attached. */
export function certificateEmail({ brand, workOrderNumber, recipient, customerFirstName, closedAtText }: CertificateEmailInput): EmailText {
  const subject = `Acta de instalación · Orden ${workOrderNumber} · ${operatorLabel(brand)}`;
  const greeting =
    recipient === "CUSTOMER"
      ? [`Hola ${customerFirstName}:`, "", `Tu servicio de internet por fibra quedó instalado (${closedAtText}). Te enviamos adjunta el acta de instalación de la orden ${workOrderNumber}, con las fotos de evidencia validadas.`]
      : [`Copia para operaciones del acta de la orden ${workOrderNumber}, cerrada ${closedAtText}.`, `Cliente: ${customerFirstName}.`];
  return { subject, body: body(brand, [...greeting, "", `Operadora: ${brand.operatorName}.`, "Este correo se envió automáticamente; no es necesario responderlo."]) };
}

export interface ZoneChiefAlertInput {
  readonly brand: ResolvedBrand;
  readonly workOrderNumber: string;
  readonly zoneName: string;
  readonly zoneChiefFirstName: string;
  readonly installerFirstName: string;
  /** Hazard (`hazard`) or case category (`caseReason`) in words, built by code. */
  readonly reasonText: string;
  /** Summary verified by G2 and the deterministic checks, or the fixed one built by code. */
  readonly summary: string;
  /** Console link to the case: the only URL any message carries (CP-NO-FOREIGN-LINKS). */
  readonly caseUrl: string;
  /** Simulated time of the report or of the case opening ("13/10 15:10"). */
  readonly atText: string;
}

function subjectTag(brand: ResolvedBrand): string {
  return brand.mode === "cobrand" ? ` · ${operatorLabel(brand)}` : "";
}

/** `ZONE_CHIEF_ALERT` for a safety hazard: sent together with the supervisor's template. */
export function zoneChiefSafetyAlert(input: ZoneChiefAlertInput): EmailText {
  const { brand, workOrderNumber, zoneName, zoneChiefFirstName, installerFirstName, reasonText, summary, caseUrl, atText } = input;
  return {
    subject: `[Cuadrilla] Alerta de seguridad · Orden ${workOrderNumber} · Zona ${zoneName}${subjectTag(brand)}`,
    body: body(brand, [
      `Hola ${zoneChiefFirstName}:`,
      "",
      `${installerFirstName} reportó un riesgo de seguridad en la orden ${workOrderNumber} (${atText}): ${reasonText}.`,
      "Ya recibió la instrucción de seguridad del manual y la orden quedó en espera. El supervisor de turno recibió la alerta al mismo tiempo.",
      `Resumen: ${summary}`,
      "",
      `Ver el caso en la consola: ${caseUrl}`,
    ]),
  };
}

/** `ZONE_CHIEF_ALERT` when no supervisor took the case on either rung. */
export function zoneChiefUnattendedCase(input: ZoneChiefAlertInput): EmailText {
  const { brand, workOrderNumber, zoneChiefFirstName, installerFirstName, reasonText, summary, caseUrl, atText } = input;
  return {
    subject: `[Cuadrilla] Caso sin atender · Orden ${workOrderNumber}${subjectTag(brand)}`,
    body: body(brand, [
      `Hola ${zoneChiefFirstName}:`,
      "",
      `Ningún supervisor tomó el caso de ${installerFirstName} en la orden ${workOrderNumber}, abierto ${atText}, por este motivo: ${reasonText}.`,
      `Resumen: ${summary}`,
      "El caso sigue abierto en la consola y cualquier supervisor puede tomarlo.",
      "",
      `Ver el caso en la consola: ${caseUrl}`,
    ]),
  };
}

// ---- Certificate (PDF) ---------------------------------------------------------------------------------

/** Labels of the certificate; the writer lays them out and fills the values from the order. */
export const CERTIFICATE_LABELS = {
  title: "Acta de instalación",
  workOrder: "Orden",
  date: "Fecha y hora",
  installer: "Instalador",
  customer: "Cliente",
  address: "Domicilio",
  plan: "Plan",
  onuSerial: "Serial de la ONU",
  rxPower: "Potencia recibida",
  opticalClass: "Clase óptica",
  checklist: "Checklist de cierre",
  photos: "Fotos validadas",
  statusPassed: "Validado",
  statusOverridden: "Validado manualmente",
} as const;

/** Who validated an item, as the certificate prints it (validator or a named supervisor). */
export function validatedBy(input: { readonly by: "VALIDATOR" } | { readonly by: "PERSON"; readonly name: string; readonly reason: string }): string {
  if (input.by === "VALIDATOR") return "validado por el validador de fotos";
  return `validado manualmente por ${input.name}: ${input.reason}`;
}

/** Header line: "<partner> · Cuadrilla" in co-branding, the fictitious operator with its tag otherwise. */
export function certificateHeader(brand: ResolvedBrand): string {
  return brand.mode === "cobrand" ? `${brand.operatorName} · Cuadrilla` : `${operatorLabel(brand)} · Cuadrilla`;
}

/** Footer lines: synthetic-document note and brand line, then the disclaimer in co-branding. */
export function certificateFooter(brand: ResolvedBrand): string[] {
  if (brand.mode === "cobrand") return [brand.brandLine, closingNotice(brand)];
  return [`Documento sintético · datos ficticios · ${brand.brandLine}`];
}
