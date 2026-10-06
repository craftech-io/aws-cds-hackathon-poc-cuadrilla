// The outbound pipeline (outbound/pipeline.ts `sendOutbound`) as the certificate's `CertificateSender`:
// each send becomes a request written by code (`author SYSTEM`, `textSource CODE`) with the PDF of
// `WorkOrders/CERT` (`attachmentSha256` for `CP-CERT-EVIDENCE`), and the pipeline's answer becomes the
// delivery's outcome. The pipeline resolves every address from the records (`LAM-RECIPIENT`); the
// email address of the send is only what the deliveries expected and is not passed on.
import type { Logger } from "../lib/log";
import type { OutboundDeps } from "../outbound/deps";
import { sendOutbound } from "../outbound/pipeline";
import type { OutboundInput, OutboundResult } from "../outbound/types";
import type { CertificateSend, CertificateSendOutcome, CertificateSender } from "./sender";

function requestOf(send: CertificateSend): OutboundInput {
  const common = { author: "SYSTEM", textSource: "CODE" as const, eventAtSim: send.sentAtSim, workOrderId: send.workOrderId };
  if (send.channel === "EMAIL") {
    return { ...common, channel: "EMAIL", kind: "CERTIFICATE_EMAIL", toRole: send.toRole, subject: send.subject, text: send.bodyText, attachment: send.attachment, messageId: send.mailId };
  }
  const media = { media: { bucket: "Evidence" as const, key: send.document.s3Key }, filename: send.document.fileName };
  return {
    ...common,
    channel: "WHATSAPP",
    kind: "CERTIFICATE",
    personId: send.personId,
    inResponseToInbound: send.inResponseToInbound,
    attachmentSha256: send.document.sha256,
    messageId: send.idempotencyKey,
    ...(send.turnId === undefined ? {} : { turnId: send.turnId }),
    ...(send.form === "TEMPLATE" ? { template: { name: send.templateName ?? "acta_instalacion", params: [...(send.templateParams ?? [])], document: media } } : { document: media }),
  };
}

/** The pipeline's answer as a delivery outcome; only an unavailable channel is worth a `CERT_RETRY`. */
export function outcomeOf(send: CertificateSend, result: OutboundResult): CertificateSendOutcome {
  switch (result.status) {
    case "SENT":
      return send.channel === "EMAIL" ? { status: "SENT", mailId: result.messageId } : { status: "SENT", messageId: result.messageId };
    case "DEFERRED":
      return { status: "DEFERRED", nextAllowedAt: result.nextAllowedAt };
    case "REFUSED": {
      const { code, reason: detail } = result.failure.error;
      const reason = detail ?? code;
      if (code === "UNAVAILABLE") return { status: "FAILED", retryable: true, reason };
      return { status: "DENIED", ruleIds: [...result.ruleIds], reason };
    }
  }
}

export function pipelineCertificateSender(deps: OutboundDeps, logger: Logger): CertificateSender {
  return {
    async send(send) {
      const result = await sendOutbound(deps, requestOf(send), { actor: "SYSTEM", correlationId: send.correlationId, log: logger, refs: { workOrderId: send.workOrderId } });
      return outcomeOf(send, result);
    },
  };
}
