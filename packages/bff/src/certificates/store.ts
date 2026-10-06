// The objects of a certificate in the `Evidence` bucket (docs/architecture.md §6): the validated photos
// it embeds (`photos/…`, JPEG without metadata, read with a size bound) and the PDF it writes
// (`certificates/<workOrderId>/acta-<n>.pdf`, under `guest/<seg>/` in a guest world). The keys come
// from the evidence rows and from @cuadrilla/shared's `certificateObjectKey`, never from a caller.
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { s3AttachmentReader } from "../channels/email/attachments";
import { s3Client } from "../channels/email/config";
import { bucketName } from "../lib/resource";

/** A validated photo is at most a few MB (WhatsApp caps images at 5 MB; the simulator likewise). */
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

export interface CertificateObjects {
  /** Bytes of an evidence photo; throws when it is missing or larger than `MAX_PHOTO_BYTES`. */
  readPhoto(key: string): Promise<Uint8Array>;
  /** Writes the PDF; the same key is overwritten by a re-render (a historical certificate after a brand change). */
  putPdf(key: string, bytes: Uint8Array, sha256: string): Promise<void>;
}

/** The `Evidence` bucket through the container's S3 client (lib/clients.ts timeouts and retries). */
export function s3CertificateObjects(s3: Pick<S3Client, "send"> = s3Client(), bucket: () => string = () => bucketName("Evidence")): CertificateObjects {
  return {
    readPhoto: (key) => s3AttachmentReader(s3, bucket()).read(key, MAX_PHOTO_BYTES),
    async putPdf(key, bytes, sha256) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key: key,
          Body: bytes,
          ContentType: "application/pdf",
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
          Metadata: { sha256 },
        }),
      );
    },
  };
}
