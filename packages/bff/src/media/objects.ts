// What the transcription does with objects of the `Media` bucket: read a voice note (to measure its
// duration) and the output JSON of a job, each up to a byte limit, and delete them. A port, so the
// tests and the local flows run over memory; the adapter is S3 with the timeouts and retries of
// lib/clients.ts. Errors carry the operation and the exception name only, never the key.
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";

export interface ObjectLocation {
  readonly bucket: string;
  readonly key: string;
}

/** The object is larger than the limit it was read with; nothing past the limit was downloaded. */
export class ObjectTooLargeError extends Error {
  override readonly name = "ObjectTooLargeError";
  constructor(readonly maxBytes: number) {
    super(`object larger than ${maxBytes} bytes`);
  }
}

export class MediaObjectError extends Error {
  override readonly name = "MediaObjectError";
  readonly retryable = true;
}

export interface MediaObjectsPort {
  /** The whole object, or `undefined` when it does not exist; throws `ObjectTooLargeError` past `maxBytes`. */
  read(location: ObjectLocation, maxBytes: number): Promise<Uint8Array | undefined>;
  /** Deletes the object; one that no longer exists counts as deleted. */
  delete(location: ObjectLocation): Promise<void>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

let sharedClient: S3Client | undefined;

export function createS3MediaObjects(client?: S3Client): MediaObjectsPort {
  const s3 = (): S3Client => {
    if (client !== undefined) return client;
    sharedClient ??= new S3Client({ region: "us-east-1", ...awsClientConfig(CLIENT_TIMEOUTS.s3) });
    return sharedClient;
  };
  return {
    async read(location, maxBytes) {
      if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive integer");
      try {
        // One byte past the limit tells a file of exactly `maxBytes` from a larger one.
        const output = await s3().send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key, Range: `bytes=0-${maxBytes}` }));
        const bytes = output.Body === undefined ? new Uint8Array() : await output.Body.transformToByteArray();
        if (bytes.length > maxBytes) throw new ObjectTooLargeError(maxBytes);
        return bytes;
      } catch (error) {
        if (error instanceof ObjectTooLargeError) throw error;
        const name = errorName(error);
        if (name === "NoSuchKey" || name === "NotFound") return undefined;
        // A range over an empty object is unsatisfiable: the object exists and has no bytes.
        if (name === "InvalidRange") return new Uint8Array();
        throw new MediaObjectError(`GetObject failed: ${name}`, { cause: error });
      }
    },
    async delete(location) {
      try {
        await s3().send(new DeleteObjectCommand({ Bucket: location.bucket, Key: location.key }));
      } catch (error) {
        throw new MediaObjectError(`DeleteObject failed: ${errorName(error)}`, { cause: error });
      }
    },
  };
}
