// `CertificateWriter` (docs/architecture.md §11, FL-047, FL-053): what the Lambda does when
// `close_installation` finds the order complete. In order:
//
//   1. the order, in the world and operator the request names (anything else is FORBIDDEN);
//   2. idempotency: an order already CLOSED with its PDF answers the certificate it has;
//   3. the content from the order and its records (content.ts; an incomplete checklist is NOT_COMPLETE);
//   4. masker + G3 on every free-text field (filter.ts); a G3 block writes nothing and answers
//      POLICY_DENIED / G3_BLOCKED, so the caller opens the `OTHER` case (this Lambda has no `Cases`);
//   5. the validated photos from `Evidence/photos/`, each checked against its `sha256` and its JPEG
//      header (a photo that fails is left out and logged, never embedded);
//   6. the PDF with the world's brand as text (render.ts), its `sha256`, the object
//      `Evidence/certificates/…/acta-<n>.pdf` and `WorkOrders/CERT`;
//   7. the order CLOSED with `closedAtSim` (the deliveries' `CP-CERT-EVIDENCE` reads both).
//
// The deliveries are not sent here: the caller (ToolCases or the InstallerWorker, which carry the
// PIPELINE capability) sends them through the outbound pipeline (deliveries.ts, port.ts).
// `renderStoredCertificate` is the same writer for a certificate whose content is already stored: the
// historical certificates the world factory renders with the world's brand (docs/seed-spec.md).
import { z } from "zod";
import { ErrorCode, IsoInstant, ToolError } from "@cuadrilla/shared";
import { certificateObjectKey } from "@cuadrilla/shared/media/keys";
import type { IssueCertificateRequest } from "../agent-tools/common/ports";
import type { Connector } from "../connector/ports";
import type { ResolvedBrand } from "../copy/brand";
import { certificateFileName } from "../copy/es-MX-documents";
import { Sha256Hex } from "../domain/common";
import type { Certificate, Evidence, WorkOrder } from "../domain/work-orders";
import { sha256Hex } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { BrandConfigValue } from "../lib/secret-schemas";
import { type CertificateContent, type CertificatePhoto, CertificateContent as ContentSchema, buildCertificateContent } from "./content";
import { filterCertificateContent } from "./filter";
import type { G3Port } from "./g3";
import { InvalidJpegError, jpegInfo } from "./jpeg";
import { certificateBrand, renderCertificatePdf } from "./render";
import type { CertificateObjects } from "./store";

/** What the Lambda answers: the written certificate, or the code `close_installation` maps to its envelope. */
export const WriterResult = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    certificateId: z.string().regex(/^cert-[A-Za-z0-9-]{1,120}$/),
    n: z.int().min(1),
    sha256: Sha256Hex,
    s3Key: z.string().min(1).max(1024),
    fileName: z.string().regex(/^acta-\d{5}\.pdf$/),
    issuedAtSim: IsoInstant,
    /** The order was already closed with this certificate (a retried invocation). */
    duplicate: z.boolean(),
  }),
  z.strictObject({ ok: z.literal(false), code: ErrorCode, reason: z.string().max(200).optional(), message: z.string().max(300) }),
]);
export type WriterResult = z.infer<typeof WriterResult>;
export type WrittenCertificate = Extract<WriterResult, { ok: true }>;

export interface WriterDeps {
  readonly connector: Pick<Connector, "workOrders" | "people" | "isps">;
  readonly objects: CertificateObjects;
  readonly g3: G3Port;
  /** `BrandConfig`; `undefined` when it cannot be read (the neutral brand is used, render.ts). */
  readonly brand: () => BrandConfigValue | undefined;
  readonly logger: Logger;
}

const CLOSABLE: ReadonlySet<WorkOrder["status"]> = new Set(["SCHEDULED", "IN_PROGRESS", "CLOSED"]);

function written(certificate: Certificate, workOrderNumber: string, duplicate: boolean): WrittenCertificate {
  if (certificate.sha256 === undefined || certificate.s3Key === undefined) throw new ToolError("UNAVAILABLE", "the certificate has no PDF yet");
  return {
    ok: true,
    certificateId: certificate.certificateId,
    n: certificate.n,
    sha256: certificate.sha256,
    s3Key: certificate.s3Key,
    fileName: certificateFileName(workOrderNumber),
    issuedAtSim: certificate.issuedAtSim,
    duplicate,
  };
}

/** The bytes of each photo that is the evidence it claims to be, by evidence id; the others are logged and left out. */
async function photoBytes(
  photos: ReadonlyArray<{ readonly photo: CertificatePhoto; readonly read: () => Promise<Uint8Array | undefined> }>,
  logger: Logger,
): Promise<Map<string, Uint8Array>> {
  const bytes = new Map<string, Uint8Array>();
  for (const { photo, read } of photos) {
    let data: Uint8Array | undefined;
    try {
      data = await read();
    } catch (error) {
      logger.warn("certificate.photo_unreadable", { item: photo.item, evidenceId: photo.evidenceId, error });
      continue;
    }
    if (data === undefined) continue;
    if (sha256Hex(data) !== photo.sha256) {
      logger.warn("certificate.photo_mismatch", { item: photo.item, evidenceId: photo.evidenceId });
      continue;
    }
    try {
      jpegInfo(data);
    } catch (error) {
      if (!(error instanceof InvalidJpegError)) throw error;
      logger.warn("certificate.photo_not_jpeg", { item: photo.item, evidenceId: photo.evidenceId, reason: error.message });
      continue;
    }
    bytes.set(photo.evidenceId, data);
  }
  return bytes;
}

interface StoreInput {
  readonly connector: Pick<Connector, "workOrders" | "isps">;
  readonly objects: Pick<CertificateObjects, "putPdf">;
  readonly workOrder: WorkOrder;
  readonly content: CertificateContent;
  readonly brand: ResolvedBrand;
  readonly photos: ReadonlyMap<string, Uint8Array>;
  readonly n: number;
  readonly certificateId: string;
  readonly issuedAtSim: string;
  readonly synthetic?: boolean;
}

/** Renders, writes the object and the `CERT` row (its deliveries are kept). */
async function storeCertificate(input: StoreInput): Promise<Certificate> {
  const { workOrder, content } = input;
  const settings = await input.connector.isps.getSettings(workOrder.ispId);
  const embedded = ContentSchema.parse({ ...content, photos: content.photos.filter((photo) => input.photos.has(photo.evidenceId)) });
  const pdf = renderCertificatePdf({ content: embedded, brand: input.brand, photos: input.photos, ...(settings === undefined ? {} : { timeZone: settings.timezone }) });
  const sha256 = sha256Hex(pdf);
  const s3Key = certificateObjectKey(workOrder.clockId, workOrder.worldEpoch, workOrder.workOrderId, input.n);
  await input.objects.putPdf(s3Key, pdf, sha256);
  return input.connector.workOrders.putCertificate({
    workOrderId: workOrder.workOrderId,
    clockId: workOrder.clockId,
    certificateId: input.certificateId,
    n: input.n,
    issuedAtSim: input.issuedAtSim,
    sha256,
    s3Key,
    content: embedded,
    ...(input.synthetic === true ? { synthetic: true } : {}),
  });
}

function scopeCheck(workOrder: WorkOrder, request: IssueCertificateRequest): void {
  if (workOrder.ispId !== request.ispId || workOrder.clockId !== request.clockId) throw new ToolError("FORBIDDEN", "the order belongs to another world", "CROSS_WORLD");
  if (!CLOSABLE.has(workOrder.status)) throw new ToolError("INVALID", `an order ${workOrder.status} gets no certificate`, workOrder.status);
}

/** Steps 1-7 of the header; throws `ToolError` for what `WriterResult` reports as a failure. */
export async function writeCertificate(deps: WriterDeps, request: IssueCertificateRequest): Promise<WrittenCertificate> {
  const { connector } = deps;
  const log = deps.logger.child({ component: "certificate", workOrderId: request.workOrderId, correlationId: request.correlationId });
  const workOrder = await connector.workOrders.requireWorkOrder(request.workOrderId);
  scopeCheck(workOrder, request);
  const existing = await connector.workOrders.getCertificate(workOrder.workOrderId);
  if (workOrder.status === "CLOSED" && existing?.sha256 !== undefined && existing.s3Key !== undefined) {
    log.info("certificate.duplicate", { certificateId: existing.certificateId });
    return written(existing, workOrder.workOrderNumber, true);
  }

  const { content, photos } = await buildCertificateContent(connector, workOrder, request.closedAtSim);
  const filtered = await filterCertificateContent(content, deps.g3);
  if (!filtered.ok) {
    log.warn("certificate.g3_blocked", { entities: filtered.entities });
    throw new ToolError("POLICY_DENIED", "G3 blocked the certificate content", "G3_BLOCKED");
  }
  const byId = new Map<string, Evidence>(photos.map(({ evidence }) => [evidence.evidenceId, evidence]));
  const bytes = await photoBytes(
    filtered.content.photos.map((photo) => ({ photo, read: async () => {
      const evidence = byId.get(photo.evidenceId);
      return evidence === undefined ? undefined : deps.objects.readPhoto(evidence.s3Key);
    } })),
    log,
  );
  const isp = await connector.isps.getIsp(workOrder.ispId);
  const brand = certificateBrand(isp, deps.brand());
  const n = existing?.n ?? 1;
  const certificate = await storeCertificate({
    connector,
    objects: deps.objects,
    workOrder,
    content: filtered.content,
    brand,
    photos: bytes,
    n,
    certificateId: existing?.certificateId ?? `cert-${workOrder.workOrderId}-${n}`,
    issuedAtSim: request.closedAtSim,
  });
  if (workOrder.status !== "CLOSED") {
    const actor = request.closedBy === "HARNESS" ? "AGENT" : request.closedBy;
    await connector.workOrders.updateWorkOrder(workOrder.workOrderId, { closedAtSim: request.closedAtSim });
    await connector.workOrders.setStatus(workOrder.workOrderId, "CLOSED", { actor, atSim: request.closedAtSim, reason: "CERTIFICATE_ISSUED" }, { from: ["SCHEDULED", "IN_PROGRESS"] });
  }
  log.info("certificate.issued", { certificateId: certificate.certificateId, photos: bytes.size, masked: filtered.masked, g3: filtered.g3, brandMode: brand.mode, sha256: certificate.sha256?.slice(0, 12) });
  return written(certificate, workOrder.workOrderNumber, false);
}

/** `writeCertificate` as the Lambda answers it: a `ToolError` becomes `{ok: false}`; anything else throws (Lambda retries). */
export async function writeCertificateResult(deps: WriterDeps, request: IssueCertificateRequest): Promise<WriterResult> {
  try {
    return await writeCertificate(deps, request);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { ok: false, code: error.code, message: error.message.slice(0, 300), ...(error.reason === undefined ? {} : { reason: error.reason.slice(0, 200) }) };
  }
}

export interface StoredRenderDeps {
  readonly connector: Pick<Connector, "workOrders" | "isps">;
  readonly objects: Pick<CertificateObjects, "putPdf">;
  /** Bytes of a stored photo (the world factory reads `Seed/photos/<photoId>.jpg` or the evidence object). */
  readonly photo: (photo: CertificatePhoto) => Promise<Uint8Array | undefined>;
  readonly brand: ResolvedBrand;
  readonly logger: Logger;
}

/**
 * Renders a certificate whose content is already stored (`WorkOrders/CERT.content`: the historical
 * certificates of the seed, or a re-render after a brand change) with `deps.brand`, writes its PDF and
 * fills `sha256`/`s3Key`; `pdfPending` goes away and the deliveries stay. Masked, not sent to G3: the
 * stored content was filtered when it was written (or is the synthetic seed).
 */
export async function renderStoredCertificate(deps: StoredRenderDeps, certificate: Certificate): Promise<Certificate> {
  const parsed = ContentSchema.safeParse(certificate.content);
  if (!parsed.success) throw new ToolError("INVALID", `the stored content of ${certificate.certificateId} is not a certificate`);
  const workOrder = await deps.connector.workOrders.requireWorkOrder(certificate.workOrderId);
  const filtered = await filterCertificateContent(parsed.data, undefined);
  if (!filtered.ok) throw new ToolError("POLICY_DENIED", "the stored certificate content was refused", filtered.reason);
  const log = deps.logger.child({ component: "certificate", workOrderId: certificate.workOrderId });
  const bytes = await photoBytes(filtered.content.photos.map((photo) => ({ photo, read: () => deps.photo(photo) })), log);
  return storeCertificate({
    connector: deps.connector,
    objects: deps.objects,
    workOrder,
    content: filtered.content,
    brand: deps.brand,
    photos: bytes,
    n: certificate.n,
    certificateId: certificate.certificateId,
    issuedAtSim: certificate.issuedAtSim,
    synthetic: certificate.synthetic,
  });
}
