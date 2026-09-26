// The SES client of a Lambda (the pipeline, `CertificateWriter`, the QaDriver's `fence.probe`): the
// container's connector, SES and S3 clients and `Runtime` store, with the caller's request logger so
// every line carries its correlation id. Tests build `createEmailClient` with their own dependencies.
import { connector } from "../../connector/index";
import type { Logger } from "../../lib/log";
import { seedOverrides } from "../../lib/secrets";
import { runtimeStore } from "../../ops/defaults";
import { s3AttachmentReader } from "./attachments";
import { emailChannelConfig, s3Client, sesClient } from "./config";
import { type EmailClient, createEmailClient } from "./outbound";

/**
 * Demo recipients of the operator's demo world. A function without the `SeedOverrides` link (or with
 * an unreadable value) gets none: the fence then denies them, it never widens.
 */
function demoRecipientsReader(logger: Logger): () => readonly string[] {
  return () => {
    try {
      return seedOverrides().demoRecipients?.emails ?? [];
    } catch (error) {
      logger.warn("demo recipients unavailable: the fence admits only the SES simulator", { error });
      return [];
    }
  };
}

export function emailClient(logger: Logger): EmailClient {
  return createEmailClient({
    connector: connector(),
    ses: sesClient(),
    attachments: { read: (key, maxBytes) => s3AttachmentReader(s3Client(), emailChannelConfig().evidenceBucket).read(key, maxBytes) },
    config: emailChannelConfig,
    demoRecipients: demoRecipientsReader(logger),
    caps: { store: runtimeStore() },
    logger,
  });
}
