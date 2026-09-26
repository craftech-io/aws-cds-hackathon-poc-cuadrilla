// What the channel does with an object of the `Media` bucket: its size and type, its first bytes
// (magic numbers) and deleting it when it is refused. A port, so the tests and the local flows run
// over memory; the adapter below is the S3 one, with the timeouts and retries of lib/clients.ts.
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ChannelError } from "@cuadrilla/shared";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../../lib/clients";
import type { S3Location } from "./client";
import { WHATSAPP_REGION } from "./config";

export interface StoredObject {
  readonly bytes: number;
  readonly contentType?: string;
}

export interface MediaStore {
  /** Size and type of an object; `undefined` when it does not exist. */
  head(location: S3Location): Promise<StoredObject | undefined>;
  /** The first `count` bytes of an object (fewer if it is shorter). */
  readStart(location: S3Location, count: number): Promise<Uint8Array>;
  delete(location: S3Location): Promise<void>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey");
}

function failure(operation: string, error: unknown): ChannelError {
  const name = error instanceof Error ? error.name : "UnknownError";
  return new ChannelError("UNAVAILABLE", "WHATSAPP", `${operation} failed: ${name}`, { cause: error, retryable: true });
}

let sharedClient: S3Client | undefined;

export function createS3MediaStore(client?: S3Client): MediaStore {
  const s3 = (): S3Client => {
    if (client !== undefined) return client;
    sharedClient ??= new S3Client({ region: WHATSAPP_REGION, ...awsClientConfig(CLIENT_TIMEOUTS.s3) });
    return sharedClient;
  };
  return {
    async head(location) {
      try {
        const output = await s3().send(new HeadObjectCommand({ Bucket: location.bucket, Key: location.key }));
        return { bytes: output.ContentLength ?? 0, ...(output.ContentType === undefined ? {} : { contentType: output.ContentType }) };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw failure("HeadObject", error);
      }
    },
    async readStart(location, count) {
      try {
        const output = await s3().send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key, Range: `bytes=0-${Math.max(count - 1, 0)}` }));
        return output.Body === undefined ? new Uint8Array() : await output.Body.transformToByteArray();
      } catch (error) {
        throw failure("GetObject", error);
      }
    },
    async delete(location) {
      try {
        await s3().send(new DeleteObjectCommand({ Bucket: location.bucket, Key: location.key }));
      } catch (error) {
        throw failure("DeleteObject", error);
      }
    },
  };
}
