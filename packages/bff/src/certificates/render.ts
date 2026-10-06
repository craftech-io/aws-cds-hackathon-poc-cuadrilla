// The layout of the installation certificate (docs/architecture.md §11): the content of content.ts,
// the brand of the world as text (the writer embeds JPEG only, never a logo) and the labels of
// copy/es-MX-documents.ts, turned into the blocks of pdf.ts. A visible surface (ADR-0023): every word
// a person reads comes from copy/ or from the order; this file only places them.
//
//   neutral   header "<fictitious operator> (ficticia) · Cuadrilla", footer with the synthetic-document note
//   cobrand   header "<partner> · Cuadrilla", footer with the brand line and the synthetic-demo notice
import type { ChecklistItem } from "@cuadrilla/shared";
import { type ResolvedBrand, resolveBrand } from "../copy/brand";
import { esMX } from "../copy/es-MX";
import { CERTIFICATE_LABELS, certificateFooter, certificateHeader } from "../copy/es-MX-documents";
import { formatDbm } from "../copy/helpers";
import type { Isp } from "../domain/isps";
import type { BrandConfigValue } from "../lib/secret-schemas";
import { MEXICO_CITY_TIME_ZONE, zonedParts } from "../services/business-hours/zoned-time";
import type { CertificateContent, CertificateItem } from "./content";
import { type PdfBlock, type PdfDocumentSpec, type PdfImage, writePdf } from "./pdf";

/** JPEG bytes of one embedded photo, by evidence id. */
export type PhotoBytes = ReadonlyMap<string, Uint8Array>;

export interface RenderInput {
  readonly content: CertificateContent;
  readonly brand: ResolvedBrand;
  /** Bytes of the photos of `content.photos`; a photo without bytes is left out. */
  readonly photos: PhotoBytes;
  /** IANA zone of the world (`Isps/SETTINGS.timezone`). */
  readonly timeZone?: string;
}

/**
 * The brand a world's certificate carries: the co-branding of `BrandConfig` when the world's
 * `Isps/META.displayName` is the partner (a sign-up world may stay neutral, ADR-0025 §2), the neutral
 * brand otherwise. Without the configuration the neutral brand is used, never a guess.
 */
export function certificateBrand(isp: Pick<Isp, "displayName"> | undefined, config: BrandConfigValue | undefined): ResolvedBrand {
  if (config?.mode === "cobrand") {
    const cobrand = resolveBrand(config);
    if (isp?.displayName === cobrand.operatorName) return cobrand;
  }
  return resolveBrand({ mode: "neutral" });
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** "13/10/2026 10:05" in the world's zone. */
export function formatSimInstant(iso: string, timeZone: string = MEXICO_CITY_TIME_ZONE): string {
  const parts = zonedParts(new Date(iso), timeZone);
  const [year, month, day] = parts.date.split("-");
  return `${day}/${month}/${year} ${parts.time}`;
}

/** "13/10 10:02": the day and time an item was validated. */
function formatShort(iso: string, timeZone: string): string {
  const parts = zonedParts(new Date(iso), timeZone);
  const [, month, day] = parts.date.split("-");
  return `${day}/${month} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function itemName(item: ChecklistItem): string {
  return capitalize(esMX.checklistItem[item]);
}

function itemBlocks(item: CertificateItem, timeZone: string): PdfBlock[] {
  const status = item.status === "OVERRIDDEN" ? CERTIFICATE_LABELS.statusOverridden : CERTIFICATE_LABELS.statusPassed;
  const when = item.validatedAtSim === undefined ? "" : ` (${formatShort(item.validatedAtSim, timeZone)})`;
  const detail = `${item.validatedBy === undefined ? status : capitalize(item.validatedBy)}${when}`;
  return [
    { kind: "text", text: itemName(item.item), bold: true, gapBefore: 4 },
    { kind: "text", text: detail, size: 9, gray: 0.25, indent: 12 },
  ];
}

function powerText(content: CertificateContent): string {
  return content.rxPowerDbm === undefined ? "—" : formatDbm(content.rxPowerDbm, true);
}

/** The blocks and the information dictionary of the certificate. */
export function certificateDocument(input: RenderInput): PdfDocumentSpec {
  const { content, brand } = input;
  const timeZone = input.timeZone ?? MEXICO_CITY_TIME_ZONE;
  const images: PdfImage[] = content.photos.flatMap((photo) => {
    const jpeg = input.photos.get(photo.evidenceId);
    return jpeg === undefined ? [] : [{ jpeg, caption: itemName(photo.item) }];
  });
  const title = `${CERTIFICATE_LABELS.title} · ${CERTIFICATE_LABELS.workOrder} ${content.workOrderNumber}`;
  const blocks: PdfBlock[] = [
    { kind: "text", text: CERTIFICATE_LABELS.title, size: 20, bold: true },
    { kind: "text", text: certificateHeader(brand), size: 11, gray: 0.25, gapBefore: 2 },
    { kind: "rule", gapBefore: 8 },
    { kind: "field", label: CERTIFICATE_LABELS.workOrder, value: content.workOrderNumber, gapBefore: 8 },
    { kind: "field", label: CERTIFICATE_LABELS.date, value: formatSimInstant(content.closedAtSim, timeZone), gapBefore: 3 },
    { kind: "field", label: CERTIFICATE_LABELS.installer, value: content.installerName, gapBefore: 3 },
    { kind: "field", label: CERTIFICATE_LABELS.customer, value: content.customer.firstName, gapBefore: 3 },
    { kind: "field", label: CERTIFICATE_LABELS.address, value: `${content.customer.addressLine}, ${content.customer.neighborhood}`, gapBefore: 3 },
    { kind: "field", label: CERTIFICATE_LABELS.plan, value: content.plan, gapBefore: 3 },
    { kind: "field", label: CERTIFICATE_LABELS.onuSerial, value: content.onuSerial, gapBefore: 3 },
    { kind: "field", label: CERTIFICATE_LABELS.rxPower, value: powerText(content), gapBefore: 3 },
    { kind: "field", label: CERTIFICATE_LABELS.opticalClass, value: content.opticalClass, gapBefore: 3 },
    { kind: "rule", gapBefore: 8 },
    { kind: "text", text: CERTIFICATE_LABELS.checklist, size: 12, bold: true, gapBefore: 8 },
    ...content.items.flatMap((item) => itemBlocks(item, timeZone)),
    { kind: "rule", gapBefore: 8 },
    { kind: "text", text: `${CERTIFICATE_LABELS.photos}: ${images.length}`, size: 12, bold: true, gapBefore: 8 },
    ...(images.length === 0 ? [] : [{ kind: "images", images, perRow: 3, gapBefore: 6 } satisfies PdfBlock]),
  ];
  return {
    info: { Title: title, Producer: "Cuadrilla" },
    header: [title],
    blocks,
    footer: certificateFooter(brand),
  };
}

/** The certificate's PDF bytes: the same content, brand and photos always give the same bytes. */
export function renderCertificatePdf(input: RenderInput): Uint8Array {
  return writePdf(certificateDocument(input));
}
