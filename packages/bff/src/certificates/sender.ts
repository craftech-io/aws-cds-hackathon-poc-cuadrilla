// What the certificate's deliveries ask of the outbound pipeline (docs/architecture.md §11 step 4, the
// pipeline of WP-28): one send per recipient, written by code (`author SYSTEM`), with the PDF that
// `WorkOrders/CERT` records and its `sha256` (`CP-CERT-EVIDENCE`). The pipeline applies the contact
// policy, the recipient fence, the caps and the transport, and answers with an outcome, never an
// exception for an expected denial. Validated with zod: it is an edge between two modules of
// different packages of work, like any other.
import { z } from "zod";
import { ClockId, IspId, IsoInstant, PersonId, WorkOrderId } from "@cuadrilla/shared";
import { Sha256Hex } from "../domain/common";

/** The certificate PDF a send carries: document, template header or email attachment. */
export const CertificateDocument = z.strictObject({
  s3Key: z.string().min(1).max(1024),
  fileName: z.string().regex(/^acta-\d{5}\.pdf$/),
  sha256: Sha256Hex,
});
export type CertificateDocument = z.infer<typeof CertificateDocument>;

const Common = {
  clockId: ClockId,
  ispId: IspId,
  workOrderId: WorkOrderId,
  sentAtSim: IsoInstant,
  correlationId: z.string().min(1).max(128),
};

/** `CERTIFICATE_EMAIL` to the customer or to the operations mailbox (texts of copy/es-MX-documents.ts). */
export const CertificateEmailSend = z.strictObject({
  ...Common,
  channel: z.literal("EMAIL"),
  kind: z.literal("CERTIFICATE_EMAIL"),
  toRole: z.enum(["CUSTOMER", "OPS_MAILBOX"]),
  /** The registered address (`Customer.email`, `Isp.opsMailbox`); the fence of the world decides. */
  to: z.string().min(3).max(320),
  subject: z.string().min(1).max(400),
  bodyText: z.string().min(1).max(20_000),
  attachment: CertificateDocument,
  /** Stable per certificate, recipient and attempt: an email already sent is never sent twice. */
  mailId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
export type CertificateEmailSend = z.infer<typeof CertificateEmailSend>;

/** `CERTIFICATE` to the installer: the PDF as a document, or the template `acta_instalacion` with it as header. */
export const CertificateWhatsAppSend = z
  .strictObject({
    ...Common,
    channel: z.literal("WHATSAPP"),
    kind: z.literal("CERTIFICATE"),
    personId: PersonId,
    form: z.enum(["DOCUMENT", "TEMPLATE"]),
    document: CertificateDocument,
    templateName: z.literal("acta_instalacion").optional(),
    /** `{{1}}` = the work order number (copy/templates.ts). */
    templateParams: z.array(z.string().regex(/^\d{5}$/)).length(1).optional(),
    /** The installer's tap closed the order (quiet hours exempt an answer to an inbound message). */
    inResponseToInbound: z.boolean(),
    turnId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    /** Stable per certificate, form and attempt: the pipeline never sends the same one twice. */
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  })
  .refine((send) => (send.form === "TEMPLATE") === (send.templateName !== undefined && send.templateParams !== undefined), "a template send names acta_instalacion and its parameter; a document send names none");
export type CertificateWhatsAppSend = z.infer<typeof CertificateWhatsAppSend>;

export const CertificateSend = z.union([CertificateEmailSend, CertificateWhatsAppSend]);
export type CertificateSend = z.infer<typeof CertificateSend>;

export type CertificateSendOutcome =
  | { readonly status: "SENT"; readonly mailId?: string; readonly messageId?: string }
  /** The policy deferred it (quiet hours): the pipeline armed its `DEFERRED_SEND`. */
  | { readonly status: "DEFERRED"; readonly nextAllowedAt?: string }
  /** The policy, the fence or a cap refused it; `ruleIds` names the rule (`CP-WA-24H` for a closed window). */
  | { readonly status: "DENIED"; readonly ruleIds: readonly string[]; readonly reason?: string }
  | { readonly status: "FAILED"; readonly retryable: boolean; readonly reason?: string };

/** The outbound pipeline as the certificate sees it (WP-28 provides the adapter). */
export interface CertificateSender {
  send(request: CertificateSend): Promise<CertificateSendOutcome>;
}
