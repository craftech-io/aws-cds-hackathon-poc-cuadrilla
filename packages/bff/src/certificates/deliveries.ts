// Step 4 of the certificate (docs/architecture.md §11, FL-048, FL-049): its deliveries, through the
// outbound pipeline, from the Lambda that closed the order (ToolCases or the InstallerWorker: they
// carry PIPELINE; `CertificateWriter` does not). One per recipient, recorded in
// `WorkOrders/CERT.deliveries[]`:
//
//   CUSTOMER      CERTIFICATE_EMAIL with the PDF attached, from `actas@` (copy/es-MX-documents.ts)
//   OPS_MAILBOX   the same, to `Isps/META.opsMailbox`
//   INSTALLER     CERTIFICATE as a WhatsApp document; when the policy denies it for the closed 24 h
//                 window (`CP-WA-24H`), the template `acta_instalacion` with the document as header.
//                 A "Cerrar instalación" tap is an inbound message (InboundWhatsApp records it before
//                 queueing), so a closing by button always finds the window open; a `CERT_RETRY`
//                 that arrives with the window expired, or a closing nobody wrote for, gets the template.
//
// The pipeline decides (policy, fence, caps, transport); this module only says what to send and keeps
// the outcome. A delivery already sent is never sent again (a retried closing); a transient failure
// arms one `CERT_RETRY` +5 simulated minutes (docs/architecture.md §8), whose firing resends that
// recipient once (`retryCertificateDelivery`).
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import type { QueuedDelivery } from "../agent-tools/common/fields";
import type { TimerPort } from "../agent-tools/common/ports";
import type { Connector } from "../connector/ports";
import { certificateEmail, certificateFileName } from "../copy/es-MX-documents";
import { type Certificate, type CertificateDelivery, DeliveryTarget, type WorkOrder } from "../domain/work-orders";
import type { Logger } from "../lib/log";
import type { BrandConfigValue } from "../lib/secret-schemas";
import { CertificateContent } from "./content";
import { certificateBrand, formatSimInstant } from "./render";
import { CertificateSend, type CertificateSendOutcome, type CertificateSender } from "./sender";

export const CERT_RETRY_DELAY_MS = 5 * 60_000;

/** Statuses that mean the recipient has it (or is about to): never sent again. */
const DONE: ReadonlySet<CertificateDelivery["status"]> = new Set(["SENT", "DELIVERED", "READ"]);
/** Statuses a `CERT_RETRY` resends. */
const RETRYABLE: ReadonlySet<CertificateDelivery["status"]> = new Set(["FAILED", "DELAYED", "QUEUED"]);
const TARGETS: readonly DeliveryTarget[] = ["CUSTOMER", "OPS_MAILBOX", "INSTALLER"];

export interface DeliveryDeps {
  readonly connector: Pick<Connector, "workOrders" | "people" | "isps">;
  readonly sender: CertificateSender;
  readonly timers: Pick<TimerPort, "arm">;
  /** `BrandConfig` (the subject and body carry the world's operator); `undefined` → neutral brand. */
  readonly brand: () => BrandConfigValue | undefined;
  readonly logger: Logger;
}

export interface DeliveryInput {
  readonly workOrderId: string;
  /** Simulated instant of the sends: the closing, or the firing of the retry. */
  readonly atSim: string;
  readonly correlationId: string;
  /** The installer's tap closed the order: the sends answer an inbound message. */
  readonly inResponseToInbound: boolean;
  readonly turnId?: string;
  /** Only this recipient (a `CERT_RETRY`). */
  readonly only?: DeliveryTarget;
  readonly attempt: "FIRST" | "RETRY";
}

export interface DeliveryResult {
  readonly delivery: CertificateDelivery;
  /** Whether it went to the pipeline in this call (a delivery already done is skipped). */
  readonly attempted: boolean;
  readonly retryArmed: boolean;
}

/** The `CERT_RETRY` timer of one recipient: one per certificate and recipient, so a retry happens once. */
export function certRetryTimerId(workOrderId: string, to: DeliveryTarget): string {
  return `cert-retry-${workOrderId}-${to.toLowerCase().replace(/_/g, "-")}`;
}

/** Arms the single `CERT_RETRY` of a recipient (arming it again returns the existing timer). */
export async function armCertRetry(timers: Pick<TimerPort, "arm">, workOrder: Pick<WorkOrder, "workOrderId" | "clockId">, to: DeliveryTarget, atSim: string): Promise<void> {
  await timers.arm({
    home: { kind: "WORK_ORDER", id: workOrder.workOrderId },
    kind: "CERT_RETRY",
    timerId: certRetryTimerId(workOrder.workOrderId, to),
    clockId: workOrder.clockId,
    dueAtSim: new Date(Date.parse(atSim) + CERT_RETRY_DELAY_MS).toISOString(),
    reason: "CERT_RETRY",
    payload: { to },
  });
}

/** Mail id of one recipient's email: stable, so a retried closing finds the email already sent. */
function mailIdOf(certificate: Certificate, to: DeliveryTarget, attempt: DeliveryInput["attempt"]): string {
  return `mail-${certificate.certificateId}-${to.toLowerCase().replace(/_/g, "-")}${attempt === "RETRY" ? "-r1" : ""}`;
}

function deliveryOf(to: DeliveryTarget, channel: CertificateDelivery["channel"], outcome: CertificateSendOutcome, atSim: string, detail?: string): CertificateDelivery {
  const base = { to, channel, updatedAtSim: atSim };
  switch (outcome.status) {
    case "SENT":
      return { ...base, status: "SENT", ...(outcome.mailId === undefined ? {} : { mailId: outcome.mailId }), ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }), ...(detail === undefined ? {} : { detail }) };
    case "DEFERRED":
      return { ...base, status: "QUEUED", detail: `DEFERRED${outcome.nextAllowedAt === undefined ? "" : ` until ${outcome.nextAllowedAt}`}` };
    case "DENIED":
      return { ...base, status: "DENIED", detail: [...outcome.ruleIds, outcome.reason].filter((part) => part !== undefined).join(" ").slice(0, 200) };
    case "FAILED":
      return { ...base, status: "FAILED", ...(outcome.reason === undefined ? {} : { detail: outcome.reason.slice(0, 200) }) };
  }
}

interface Prepared {
  readonly certificate: Certificate;
  readonly workOrder: WorkOrder;
  readonly content: CertificateContent;
  readonly document: { readonly s3Key: string; readonly fileName: string; readonly sha256: string };
  readonly opsMailbox: string | undefined;
  readonly customerEmail: string;
  readonly timeZone: string | undefined;
  readonly emailText: (recipient: "CUSTOMER" | "OPS_MAILBOX") => { subject: string; body: string };
}

async function prepare(deps: DeliveryDeps, workOrderId: string): Promise<Prepared> {
  const { connector } = deps;
  const [certificate, workOrder] = await Promise.all([connector.workOrders.getCertificate(workOrderId), connector.workOrders.requireWorkOrder(workOrderId)]);
  if (certificate?.sha256 === undefined || certificate.s3Key === undefined) throw new ToolError("NOT_FOUND", `order ${workOrderId} has no certificate PDF to deliver`);
  const content = CertificateContent.parse(certificate.content);
  const [customer, isp, settings] = await Promise.all([connector.people.getCustomer(workOrder.customerId), connector.isps.getIsp(workOrder.ispId), connector.isps.getSettings(workOrder.ispId)]);
  if (customer === undefined) throw new ToolError("NOT_FOUND", `customer of ${workOrderId}`);
  const brand = certificateBrand(isp, deps.brand());
  const closedAtText = formatSimInstant(content.closedAtSim, settings?.timezone);
  return {
    certificate,
    workOrder,
    content,
    document: { s3Key: certificate.s3Key, fileName: certificateFileName(workOrder.workOrderNumber), sha256: certificate.sha256 },
    opsMailbox: isp?.opsMailbox,
    customerEmail: customer.email,
    timeZone: settings?.timezone,
    emailText: (recipient) => certificateEmail({ brand, workOrderNumber: workOrder.workOrderNumber, recipient, customerFirstName: content.customer.firstName, closedAtText }),
  };
}

function common(prepared: Prepared, input: DeliveryInput) {
  const { workOrder } = prepared;
  return { clockId: workOrder.clockId, ispId: workOrder.ispId, workOrderId: workOrder.workOrderId, sentAtSim: input.atSim, correlationId: input.correlationId };
}

/** Every send is validated before it reaches the pipeline (an edge between two modules). */
function send(deps: DeliveryDeps, request: CertificateSend): Promise<CertificateSendOutcome> {
  return deps.sender.send(CertificateSend.parse(request));
}

/** A recipient's outcome and whether a later retry may succeed. */
interface Sent {
  readonly delivery: CertificateDelivery;
  readonly retryable: boolean;
}

function sentOf(to: DeliveryTarget, channel: CertificateDelivery["channel"], outcome: CertificateSendOutcome, atSim: string, detail?: string): Sent {
  return { delivery: deliveryOf(to, channel, outcome, atSim, detail), retryable: outcome.status === "FAILED" && outcome.retryable };
}

async function sendEmail(deps: DeliveryDeps, prepared: Prepared, input: DeliveryInput, to: "CUSTOMER" | "OPS_MAILBOX"): Promise<Sent> {
  const address = to === "CUSTOMER" ? prepared.customerEmail : prepared.opsMailbox;
  if (address === undefined) return { delivery: { to, channel: "EMAIL", status: "DENIED", updatedAtSim: input.atSim, detail: "NO_ADDRESS" }, retryable: false };
  const text = prepared.emailText(to);
  const request: CertificateSend = {
    channel: "EMAIL",
    kind: "CERTIFICATE_EMAIL",
    ...common(prepared, input),
    toRole: to,
    to: address,
    subject: text.subject,
    bodyText: text.body,
    attachment: prepared.document,
    mailId: mailIdOf(prepared.certificate, to, input.attempt),
  };
  return sentOf(to, "EMAIL", await send(deps, request), input.atSim);
}

async function sendToInstaller(deps: DeliveryDeps, prepared: Prepared, input: DeliveryInput): Promise<Sent> {
  const base = {
    channel: "WHATSAPP" as const,
    kind: "CERTIFICATE" as const,
    ...common(prepared, input),
    personId: prepared.workOrder.installerId,
    document: prepared.document,
    inResponseToInbound: input.inResponseToInbound,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  };
  const key = `${prepared.certificate.certificateId}-installer${input.attempt === "RETRY" ? "-r1" : ""}`;
  const document = await send(deps, { ...base, form: "DOCUMENT", idempotencyKey: `${key}-document` });
  if (document.status !== "DENIED" || !document.ruleIds.includes("CP-WA-24H")) return sentOf("INSTALLER", "WHATSAPP", document, input.atSim, "DOCUMENT");
  // The window is closed: the approved template carries the same PDF as its document header.
  const template = await send(deps, { ...base, form: "TEMPLATE", templateName: "acta_instalacion", templateParams: [prepared.workOrder.workOrderNumber], idempotencyKey: `${key}-template` });
  return sentOf("INSTALLER", "WHATSAPP", template, input.atSim, "TEMPLATE acta_instalacion");
}

/**
 * Sends the certificate of an order to every recipient (or to `input.only`) through the pipeline and
 * records each outcome in `CERT.deliveries[]`. A delivery already done is skipped; on a retry, only a
 * delivery that failed, was delayed or is still queued is sent again, and no new retry is armed.
 */
export async function deliverCertificate(deps: DeliveryDeps, input: DeliveryInput): Promise<DeliveryResult[]> {
  const prepared = await prepare(deps, input.workOrderId);
  const log = deps.logger.child({ component: "certificate.deliveries", workOrderId: input.workOrderId, correlationId: input.correlationId });
  const results: DeliveryResult[] = [];
  for (const to of input.only === undefined ? TARGETS : [input.only]) {
    const current = prepared.certificate.deliveries.find((delivery) => delivery.to === to);
    const skip = current !== undefined && (input.attempt === "FIRST" ? DONE.has(current.status) : !RETRYABLE.has(current.status));
    if (skip) {
      results.push({ delivery: current, attempted: false, retryArmed: false });
      continue;
    }
    let sent: Sent;
    try {
      sent = to === "INSTALLER" ? await sendToInstaller(deps, prepared, input) : await sendEmail(deps, prepared, input, to);
    } catch (error) {
      log.error("certificate.delivery_error", { to, error });
      sent = { delivery: { to, channel: to === "INSTALLER" ? "WHATSAPP" : "EMAIL", status: "FAILED", updatedAtSim: input.atSim, detail: "PIPELINE_ERROR" }, retryable: true };
    }
    const { delivery, retryable } = sent;
    await deps.connector.workOrders.setDelivery(input.workOrderId, delivery);
    let retryArmed = false;
    if (retryable && input.attempt === "FIRST") {
      try {
        await armCertRetry(deps.timers, prepared.workOrder, to, input.atSim);
        retryArmed = true;
      } catch (error) {
        // The certificate exists and the delivery is recorded FAILED: the console shows it; never fail the closing for it.
        log.error("certificate.retry_not_armed", { to, error });
      }
    }
    log.info("certificate.delivery", { to, channel: delivery.channel, status: delivery.status, detail: delivery.detail, attempt: input.attempt, retryArmed });
    results.push({ delivery, attempted: true, retryArmed });
  }
  return results;
}

/** What `close_installation` reports: every delivery handed to the pipeline (docs/tool-catalog.md). */
export function queuedDeliveries(results: readonly DeliveryResult[]): QueuedDelivery[] {
  return results.map(({ delivery }) => ({ to: delivery.to, channel: delivery.channel, status: "QUEUED" as const }));
}

/** Payload of a `CERT_RETRY` timer. */
export const CertRetryPayload = z.object({ to: DeliveryTarget });

/** The firing of a `CERT_RETRY` (`fire_timer` of the worker): the one resend of that recipient. */
export async function retryCertificateDelivery(
  deps: DeliveryDeps,
  timer: { readonly home: { readonly kind: string; readonly id: string }; readonly payload: unknown },
  firing: { readonly eventAtSim: string; readonly correlationId: string },
): Promise<DeliveryResult[]> {
  if (timer.home.kind !== "WORK_ORDER") throw new ToolError("INVALID", "a CERT_RETRY lives on a work order");
  const payload = CertRetryPayload.safeParse(timer.payload);
  if (!payload.success) throw new ToolError("INVALID", "a CERT_RETRY names its recipient");
  return deliverCertificate(deps, { workOrderId: timer.home.id, atSim: firing.eventAtSim, correlationId: firing.correlationId, inResponseToInbound: false, only: payload.data.to, attempt: "RETRY" });
}
