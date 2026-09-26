// What a caller asks the single SES client to send (the pipeline, `CertificateWriter`'s deliveries,
// the ladder's zone-chief alert) and the `SendEmail` input it becomes (docs/architecture-integrations.md
// §1): `Content.Simple` with `Subject`, `Body.Text` and a minimal `Body.Html`, all `Charset UTF-8`;
// the certificate PDF as an `ATTACHMENT`; the generic visible sender of the kind; the stage's
// configuration set; the normalized `EmailTags`; and `X-Cuadrilla-Mail-Id`. Validated with zod: the
// request is an edge like any other.
import type { SendEmailCommandInput } from "@aws-sdk/client-sesv2";
import { z } from "zod";
import { CaseId, ClockId, IsoInstant, WorkOrderId, ispIdOfClock } from "@cuadrilla/shared";
import { Actor, S3Key, Sha256Hex } from "../../domain/common";
import { EmailKind } from "../../domain/conversations";
import type { EmailChannelConfig } from "./config";
import { senderOf } from "./config";
import { MAX_BODY_CHARS, htmlFromText } from "./content";
import { MAIL_ID_HEADER, assertAsciiHeader, formatMailbox } from "./mime";
import { emailTags } from "./tags";

/** Id of one email: its outbox row, its pending mark, its `EmailTags.mailId` and its header. */
export const MailId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "expected a mail id");
export type MailId = z.infer<typeof MailId>;

export const EmailRecipientRole = z.enum(["CUSTOMER", "OPS_MAILBOX", "ZONE_CHIEF"]);
export type EmailRecipientRole = z.infer<typeof EmailRecipientRole>;

/** `acta-24817.pdf` (copy/es-MX-documents.ts `certificateFileName`). */
const CertificateFileName = z.string().regex(/^acta-\d{5}\.pdf$/, "expected acta-<number>.pdf");

export const EmailSendRequest = z
  .object({
    clockId: ClockId,
    kind: EmailKind,
    toRole: EmailRecipientRole,
    /** The address as registered (`Customer.email`, `Isp.opsMailbox`, the zone chief's `Person.email`). */
    to: z.string().min(1).max(320),
    subject: z.string().min(1).max(400),
    bodyText: z.string().min(1).max(MAX_BODY_CHARS),
    workOrderId: WorkOrderId,
    caseId: CaseId.optional(),
    attachment: z.object({ s3Key: S3Key, fileName: CertificateFileName, sha256: Sha256Hex.optional() }).strict().optional(),
    /** The world's simulated instant of the send (outbox order, audit). */
    sentAtSim: IsoInstant,
    /** A caller that may retry passes its own id: a mail already sent is never sent twice. */
    mailId: MailId.optional(),
    actor: Actor,
  })
  .strict()
  .superRefine((request, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (request.kind === "CERTIFICATE_EMAIL") {
      if (request.toRole === "ZONE_CHIEF") issue("toRole", "a certificate goes to the customer or the operations mailbox");
      if (request.attachment === undefined) issue("attachment", "a certificate email carries the PDF");
    } else {
      if (request.toRole !== "ZONE_CHIEF") issue("toRole", "an alert goes to the zone chief");
      if (request.caseId === undefined) issue("caseId", "an alert names its case");
      if (request.attachment !== undefined) issue("attachment", "an alert carries no attachment");
    }
  });
export type EmailSendRequest = z.output<typeof EmailSendRequest>;
export type EmailSendRequestInput = z.input<typeof EmailSendRequest>;

export interface SendEmailParts {
  readonly request: EmailSendRequest;
  /** The fenced, normalized recipient. */
  readonly to: string;
  readonly mailId: string;
  readonly config: EmailChannelConfig;
  readonly pdf?: Uint8Array | undefined;
}

/** The `SendEmail` input of one email; throws `INVALID` for a header value that is not safe. */
export function buildSendEmailInput(parts: SendEmailParts): SendEmailCommandInput {
  const { request, to, mailId, config, pdf } = parts;
  const sender = senderOf(request.kind, config.identityDomain);
  const html = htmlFromText(request.subject, request.bodyText, { kind: request.kind, identityDomain: config.identityDomain, caseId: request.caseId });
  const attachment = request.attachment;
  return {
    FromEmailAddress: formatMailbox(sender.name, sender.address),
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: request.subject, Charset: "UTF-8" },
        Body: { Text: { Data: request.bodyText, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
        Headers: [{ Name: MAIL_ID_HEADER, Value: assertAsciiHeader(mailId, "mail id") }],
        ...(attachment === undefined || pdf === undefined
          ? {}
          : { Attachments: [{ FileName: attachment.fileName, ContentType: "application/pdf", ContentDisposition: "ATTACHMENT", ContentTransferEncoding: "BASE64", RawContent: pdf }] }),
      },
    },
    ConfigurationSetName: config.configurationSetName,
    EmailTags: emailTags({ ispId: ispIdOfClock(request.clockId), workOrderId: request.workOrderId, mailId, kind: request.kind, stage: config.stage }),
  };
}

/** How the outbox shows the sender: the visible name and the address, as a person reads them. */
export function displayFrom(request: Pick<EmailSendRequest, "kind">, config: Pick<EmailChannelConfig, "identityDomain">): string {
  const sender = senderOf(request.kind, config.identityDomain);
  return `${sender.name} <${sender.address}>`;
}
