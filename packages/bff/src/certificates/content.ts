// What the installation certificate shows (docs/architecture.md §11), built by code from the order and
// its records, never from text of the model: the order number and closing instant, the installer's
// name, the customer's first name, street and neighborhood (no phone, no email, no internal note), the
// plan, the ONU serial, the received power and the optical class, each checklist item with who
// validated it and when, and the photos that were validated. No operator: the brand is the world's
// and render.ts adds it, so a historical certificate of the seed (`WorkOrders/CERT.content`, the same
// shape) renders with whatever brand its world has (ADR-0018, docs/seed-spec.md "Actas históricas").
import { z } from "zod";
import { ChecklistItem, ConnectorError, EvidenceId, IsoInstant, OnuSerial, OpticalClass, PhotoId, PhotoItem, ToolError, WorkOrderNumber } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import { validatedBy } from "../copy/es-MX-documents";
import { Sha256Hex } from "../domain/common";
import { AcceptanceRange } from "../domain/isps";
import type { ChecklistEntry, Evidence, WorkOrder } from "../domain/work-orders";

const Text = z.string().trim().min(1).max(500);

export const CertificateItemStatus = z.enum(["PASSED", "OVERRIDDEN"]);
export type CertificateItemStatus = z.infer<typeof CertificateItemStatus>;

export const CertificateItem = z.object({
  item: ChecklistItem,
  status: CertificateItemStatus,
  /** "validado por el validador de fotos" or "validado manualmente por <name>: <reason>" (copy/). */
  validatedBy: Text.optional(),
  validatedAtSim: IsoInstant.optional(),
});
export type CertificateItem = z.infer<typeof CertificateItem>;

export const CertificatePhoto = z.object({
  item: PhotoItem,
  evidenceId: EvidenceId,
  /** Photo of the synthetic set or seeding render (the historical certificates of the seed). */
  photoId: PhotoId.optional(),
  sha256: Sha256Hex,
});
export type CertificatePhoto = z.infer<typeof CertificatePhoto>;

export const CertificateContent = z.object({
  workOrderNumber: WorkOrderNumber,
  closedAtSim: IsoInstant,
  installerName: Text.max(170),
  customer: z.object({ firstName: Text.max(80), addressLine: Text.max(200), neighborhood: Text.max(120) }),
  plan: Text.max(80),
  onuSerial: OnuSerial,
  rxPowerDbm: z.number().optional(),
  opticalClass: OpticalClass,
  acceptanceRange: AcceptanceRange.optional(),
  items: z.array(CertificateItem).min(1).max(ChecklistItem.options.length),
  photos: z.array(CertificatePhoto).max(PhotoItem.options.length),
});
export type CertificateContent = z.infer<typeof CertificateContent>;

/** The validated photo of each photo item: what the certificate embeds. */
export interface PhotoEvidence {
  readonly item: PhotoItem;
  readonly evidence: Evidence;
}

export interface ContentRecords {
  readonly content: CertificateContent;
  readonly photos: readonly PhotoEvidence[];
}

const DONE: ReadonlySet<ChecklistEntry["status"]> = new Set(["PASSED", "OVERRIDDEN"]);

function isPhotoItem(item: ChecklistItem): item is PhotoItem {
  return (PhotoItem.options as readonly string[]).includes(item);
}

async function supervisorName(connector: Pick<Connector, "isps">, ispId: string, userId: string): Promise<string> {
  const user = await connector.isps.getUser(ispId, userId);
  return user?.name ?? userId;
}

async function itemOf(connector: Pick<Connector, "isps">, workOrder: WorkOrder, entry: ChecklistEntry): Promise<CertificateItem> {
  const status = CertificateItemStatus.parse(entry.status);
  if (status === "OVERRIDDEN" && entry.override !== undefined) {
    const name = await supervisorName(connector, workOrder.ispId, entry.override.userId);
    return { item: entry.item, status, validatedBy: validatedBy({ by: "PERSON", name, reason: entry.override.reason }), validatedAtSim: entry.override.atSim };
  }
  if (isPhotoItem(entry.item) && entry.validationId !== undefined) {
    return { item: entry.item, status, validatedBy: validatedBy({ by: "VALIDATOR" }), ...(entry.updatedAtSim === undefined ? {} : { validatedAtSim: entry.updatedAtSim }) };
  }
  return { item: entry.item, status, ...(entry.updatedAtSim === undefined ? {} : { validatedAtSim: entry.updatedAtSim }) };
}

/**
 * The content of the order's certificate from its records. Throws `NOT_COMPLETE` when an item is not
 * `PASSED` or `OVERRIDDEN` or a photo item has no stored evidence (`CP-CERT-EVIDENCE`: never a
 * certificate of an incomplete checklist, whoever asked), `NOT_FOUND` when a record is missing.
 */
export async function buildCertificateContent(
  connector: Pick<Connector, "workOrders" | "people" | "isps">,
  workOrder: WorkOrder,
  closedAtSim: string,
): Promise<ContentRecords> {
  const [entries, installer, customer, zone] = await Promise.all([
    connector.workOrders.listChecklist(workOrder.workOrderId),
    connector.people.getPerson(workOrder.installerId),
    connector.people.getCustomer(workOrder.customerId),
    connector.isps.getZone(workOrder.ispId, workOrder.zoneId),
  ]);
  if (installer === undefined) throw new ConnectorError("NOT_FOUND", `installer of ${workOrder.workOrderId}`, "People");
  if (customer === undefined) throw new ConnectorError("NOT_FOUND", `customer of ${workOrder.workOrderId}`, "People");
  const byItem = new Map(entries.map((entry) => [entry.item, entry]));
  const missing = ChecklistItem.options.filter((item) => !DONE.has(byItem.get(item)?.status ?? "PENDING"));
  if (missing.length > 0) throw new ToolError("NOT_COMPLETE", `the checklist of ${workOrder.workOrderId} is not complete`, missing.join(","));

  const items: CertificateItem[] = [];
  const photos: PhotoEvidence[] = [];
  for (const item of ChecklistItem.options) {
    const entry = byItem.get(item) as ChecklistEntry;
    items.push(await itemOf(connector, workOrder, entry));
    if (!isPhotoItem(item)) continue;
    const evidence = entry.evidenceId === undefined ? undefined : await connector.workOrders.getEvidence(workOrder.workOrderId, entry.evidenceId);
    if (evidence === undefined) throw new ToolError("NOT_COMPLETE", `the ${item} of ${workOrder.workOrderId} has no stored evidence`, item);
    photos.push({ item, evidence });
  }

  const content = CertificateContent.parse({
    workOrderNumber: workOrder.workOrderNumber,
    closedAtSim,
    installerName: `${installer.firstName} ${installer.lastName}`,
    customer: { firstName: customer.firstName, addressLine: customer.addressLine, neighborhood: customer.neighborhood },
    plan: workOrder.plan,
    onuSerial: workOrder.onuSerial,
    ...(workOrder.lastOnuReading?.rxPowerDbm === undefined ? {} : { rxPowerDbm: workOrder.lastOnuReading.rxPowerDbm }),
    opticalClass: zone?.opticalClass ?? workOrder.opticalClass,
    ...(zone === undefined ? {} : { acceptanceRange: zone.acceptanceRange }),
    items,
    photos: photos.map(({ item, evidence }) => ({ item, evidenceId: evidence.evidenceId, ...(evidence.photoId === undefined ? {} : { photoId: evidence.photoId }), sha256: evidence.sha256 })),
  });
  return { content, photos };
}
