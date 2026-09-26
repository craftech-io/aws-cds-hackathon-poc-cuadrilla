// What the SES client reads from the stage: the `EmailChannel` Linkable of infra/messaging-email.ts
// (the identity domain and the configuration set, through `readLinked`, never `process.env`), the
// `Evidence` bucket the certificate PDFs live in, and the SES and S3 clients with the timeouts of
// lib/clients.ts. Kept apart from outbound.ts so tests build an `EmailChannelConfig` by hand.
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { z } from "zod";
import { EMAIL_SENDER_NAMES } from "../../copy/es-MX-documents";
import type { EmailKind } from "../../domain/conversations";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../../lib/clients";
import { bucketName, currentStage, readLinked } from "../../lib/resource";

const Domain = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/, "expected a lower-case domain");

/** The fields of the `EmailChannel` Linkable this client needs; any other property is ignored. */
export const EmailChannelResource = z.object({
  identityDomain: Domain,
  configurationSetName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});
export type EmailChannelResource = z.infer<typeof EmailChannelResource>;

export interface EmailChannelConfig extends EmailChannelResource {
  /** Bucket of the certificate PDFs attached to `CERTIFICATE_EMAIL`. */
  readonly evidenceBucket: string;
  /** Value of the `stage` email tag. */
  readonly stage: string;
}

export function emailChannelConfig(): EmailChannelConfig {
  const linked = readLinked("EmailChannel", EmailChannelResource);
  return { ...linked, evidenceBucket: bucketName("Evidence"), stage: currentStage() };
}

export interface EmailSender {
  /** Generic visible name: the operator's name only goes in the subject and the body (ADR-0018). */
  readonly name: string;
  readonly address: string;
}

/** `actas@` for certificates, `avisos@` for the zone chief's alerts (docs/architecture-integrations.md §1). */
export function senderOf(kind: EmailKind, identityDomain: string): EmailSender {
  return kind === "CERTIFICATE_EMAIL"
    ? { name: EMAIL_SENDER_NAMES.certificates, address: `actas@${identityDomain}` }
    : { name: EMAIL_SENDER_NAMES.alerts, address: `avisos@${identityDomain}` };
}

let ses: SESv2Client | undefined;
let s3: S3Client | undefined;

/** The container's SES client (5 s per attempt, the SDK's standard retries with backoff). */
export function sesClient(): SESv2Client {
  ses ??= new SESv2Client(awsClientConfig(CLIENT_TIMEOUTS.ses));
  return ses;
}

export function s3Client(): S3Client {
  s3 ??= new S3Client(awsClientConfig(CLIENT_TIMEOUTS.s3));
  return s3;
}
