// The buckets of a local world (docs/test-plan.md §2, level LF): one map of objects, the console's own
// memory buckets (packages/bff/src/routers/console-testing.ts), with the repository's seed files behind
// `Seed` and `Manual` (tests/ui-server/world.ts `repositoryObject`). Each module of the stage reaches it
// through the port it uses in a Lambda, so a photo the phone uploads is the same object the channel
// checks, the validator reads, the evidence copy is written next to and the certificate embeds.
//
// The physical name of a bucket is `cuadrilla-local-<logical>` (S3 names are lower case; Transcribe checks
// the media URI it is given); the ports that name a bucket by its logical name keep it.
import { createHash } from "node:crypto";
import type { MediaStore } from "../../../packages/bff/src/channels/whatsapp/media-store";
import type { AttachmentReader } from "../../../packages/bff/src/channels/email/attachments";
import type { CertificateObjects } from "../../../packages/bff/src/certificates/store";
import type { EvidenceObjectStore } from "../../../packages/bff/src/evidence/ports";
import type { BucketName } from "../../../packages/bff/src/lib/resource";
import { ObjectTooLargeError, type ObjectLocation } from "../../../packages/bff/src/media/objects";
import type { MemoryMediaObjects } from "../../../packages/bff/src/media/testing";
import { type MemoryObjects, memoryObjects } from "../../../packages/bff/src/routers/console-testing";
import { seedPhotoKey } from "../../../packages/bff/src/worlds/photo-catalog";
import type { SeedMediaCopier } from "../../../packages/bff/src/worlds/presets";
import { repositoryObject } from "../../ui-server/world";

/** Origin of the presigned links of a local world (nothing listens there). */
export const LOCAL_ORIGIN = "http://127.0.0.1:0";

const CONTENT_TYPES: Readonly<Record<string, string>> = { jpg: "image/jpeg", jpeg: "image/jpeg", ogg: "audio/ogg", pdf: "application/pdf", json: "application/json" };

/** Physical names of the buckets of a local world. */
export const LOCAL_BUCKETS: Readonly<Record<BucketName, string>> = { Media: "cuadrilla-local-media", Evidence: "cuadrilla-local-evidence", Manual: "cuadrilla-local-manual", Seed: "cuadrilla-local-seed" };

function bucketOf(name: string): BucketName {
  if (name === "Media" || name === "Evidence" || name === "Manual" || name === "Seed") return name;
  const logical = (Object.keys(LOCAL_BUCKETS) as BucketName[]).find((bucket) => LOCAL_BUCKETS[bucket] === name);
  if (logical === undefined) throw new Error(`a local world has no bucket ${name}`);
  return logical;
}

function contentTypeOf(key: string): string {
  return CONTENT_TYPES[key.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export interface FlowObjects extends MemoryObjects {
  /** The bytes of an object, synchronously (the fake Transcribe's script reads the voice note it is given). */
  bytesOf(bucket: BucketName, key: string): Uint8Array | undefined;
  /** Every key of a bucket under a prefix. */
  keys(bucket: BucketName, prefix?: string): string[];
  /** `InboundWhatsApp`'s view of `Media` (channels/whatsapp/media-store.ts). */
  readonly mediaStore: MediaStore;
  /** `transcribe_voice_note`'s view (media/objects.ts), shaped as the fake Transcribe writes its output. */
  readonly mediaObjects: MemoryMediaObjects;
  /** The validator's view of `Media` and `Evidence` (evidence/ports.ts). */
  readonly evidence: EvidenceObjectStore;
  /** The certificate writer's view of `Evidence` (certificates/store.ts). */
  readonly certificates: CertificateObjects;
  /** The SES client's attachments (`Evidence`). */
  readonly attachments: AttachmentReader;
  /** The world factory's copies of the seed photos (presets `candidates` and `checklist`). */
  readonly seedCopier: SeedMediaCopier;
}

export function flowObjects(): FlowObjects {
  const base = memoryObjects(LOCAL_ORIGIN, repositoryObject);
  const bytesOf = (bucket: BucketName, key: string) => base.blobs.get(`${bucket}/${key}`)?.bytes;
  const put = (location: ObjectLocation, bytes: Uint8Array | string) => base.put(bucketOf(location.bucket), location.key, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes, contentTypeOf(location.key));
  const deleted: string[] = [];
  const mediaObjects: MemoryMediaObjects = {
    get objects() {
      return new Map([...base.blobs.entries()].map(([key, blob]) => [key, blob.bytes] as const));
    },
    deleted,
    put,
    has: (location) => base.blobs.has(`${bucketOf(location.bucket)}/${location.key}`),
    async read(location, maxBytes) {
      const bytes = bytesOf(bucketOf(location.bucket), location.key);
      if (bytes !== undefined && bytes.length > maxBytes) throw new ObjectTooLargeError(maxBytes);
      return bytes;
    },
    async delete(location) {
      deleted.push(`${bucketOf(location.bucket)}/${location.key}`);
      base.blobs.delete(`${bucketOf(location.bucket)}/${location.key}`);
    },
  };
  const copy = async (photoId: string, bucket: "Media" | "Evidence", key: string): Promise<void> => {
    const source = await base.get("Seed", seedPhotoKey(photoId));
    if (source === undefined) throw new Error(`no seed photo ${photoId}`);
    base.put(bucket, key, source.bytes, "image/jpeg");
  };
  return {
    ...base,
    bytesOf,
    keys: (bucket, prefix = "") => [...base.blobs.keys()].filter((key) => key.startsWith(`${bucket}/${prefix}`)).map((key) => key.slice(bucket.length + 1)),
    mediaStore: {
      head: ({ key }) => base.media.head(key),
      readStart: ({ key }, count) => base.media.readStart(key, count),
      delete: ({ key }) => base.media.delete(key),
    },
    mediaObjects,
    evidence: {
      async readMedia(key, maxBytes) {
        const bytes = bytesOf("Media", key);
        if (bytes === undefined) return { ok: false, problem: "MISSING" };
        return bytes.length > maxBytes ? { ok: false, problem: "TOO_LARGE" } : { ok: true, bytes };
      },
      putEvidencePhoto: async (key, jpeg) => base.put("Evidence", key, jpeg, "image/jpeg"),
    },
    certificates: {
      async readPhoto(key) {
        const bytes = bytesOf("Evidence", key);
        if (bytes === undefined) throw new Error(`no evidence photo ${key}`);
        return bytes;
      },
      async putPdf(key, bytes, sha256) {
        if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`the PDF of ${key} does not match its sha256`);
        base.put("Evidence", key, bytes, "application/pdf");
      },
    },
    attachments: {
      async read(key, maxBytes) {
        const bytes = bytesOf("Evidence", key);
        if (bytes === undefined) throw new Error(`no attachment ${key}`);
        if (bytes.length > maxBytes) throw new Error(`the attachment ${key} is larger than ${maxBytes} bytes`);
        return bytes;
      },
    },
    seedCopier: { copySeedPhoto: (photoId, key) => copy(photoId, "Media", key), copySeedPhotoToEvidence: (photoId, key) => copy(photoId, "Evidence", key) },
  };
}
