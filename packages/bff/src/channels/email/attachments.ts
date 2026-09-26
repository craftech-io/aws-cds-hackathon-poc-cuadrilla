// The certificate PDF an email attaches (`RawContent` read from `Evidence/certificates/…`,
// docs/architecture-integrations.md §1). Bounded read, `%PDF-` magic bytes and, when the caller knows
// it, the `sha256` the certificate recorded: SES never gets bytes other than the certificate's
// (`CP-CERT-EVIDENCE` checks the same hash before the send is allowed).
import { createHash } from "node:crypto";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { ChannelError } from "@cuadrilla/shared";

/** A certificate is a few hundred KB; SES v2 accepts 40 MB per message after encoding. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = "%PDF-";

/** Reads one object; the S3 adapter below, an in-memory map in tests. */
export interface AttachmentReader {
  read(key: string, maxBytes: number): Promise<Uint8Array>;
}

export interface CertificateAttachment {
  readonly s3Key: string;
  readonly fileName: string;
  readonly sha256?: string | undefined;
}

function invalid(message: string, cause?: unknown): ChannelError {
  return new ChannelError("INVALID", "EMAIL", message, { retryable: false, cause });
}

/** The PDF bytes, checked; throws `INVALID` (missing, too large, not a PDF, another hash). */
export async function loadCertificatePdf(reader: AttachmentReader, attachment: CertificateAttachment): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await reader.read(attachment.s3Key, MAX_ATTACHMENT_BYTES);
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    throw new ChannelError("UNAVAILABLE", "EMAIL", "the certificate PDF could not be read", { cause: error, retryable: true });
  }
  if (Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString("latin1") !== PDF_MAGIC) throw invalid("the attachment is not a PDF");
  if (attachment.sha256 !== undefined && createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) {
    throw invalid("the attachment is not the certificate that was issued (sha256 differs)");
  }
  return bytes;
}

/** `GetObject` of the `Evidence` bucket with a size bound (the client's timeouts are lib/clients.ts's). */
export function s3AttachmentReader(s3: Pick<S3Client, "send">, bucket: string): AttachmentReader {
  return {
    async read(key, maxBytes) {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (object.ContentLength !== undefined && object.ContentLength > maxBytes) throw invalid(`the attachment exceeds ${maxBytes} bytes`);
      if (object.Body === undefined) throw invalid("the attachment is empty");
      const bytes = await object.Body.transformToByteArray();
      if (bytes.byteLength > maxBytes) throw invalid(`the attachment exceeds ${maxBytes} bytes`);
      return bytes;
    },
  };
}
