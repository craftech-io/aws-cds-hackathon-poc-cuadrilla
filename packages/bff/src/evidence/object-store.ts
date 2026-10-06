// `EvidenceObjectStore` over S3 (docs/architecture.md §6): `ToolEvidence` reads the candidate photo
// from `Media` (s3:GetObject) and writes the evidence copy to `Evidence` (s3:PutObject on its photo
// prefix). Timeouts and SDK retries of lib/clients.ts; the bucket names come from the SST links.
// A candidate over the limit is refused by its `ContentLength` before its body is read.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ConnectorError } from "@cuadrilla/shared";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { bucketName } from "../lib/resource";
import type { EvidenceObjectStore } from "./ports";

export interface S3Sender {
  send(command: GetObjectCommand | PutObjectCommand): Promise<unknown>;
}

export interface S3EvidenceStoreDeps {
  readonly client?: S3Sender;
  readonly mediaBucket?: () => string;
  readonly evidenceBucket?: () => string;
}

interface GetOutput {
  readonly ContentLength?: number;
  readonly Body?: { transformToByteArray(): Promise<Uint8Array>; destroy?: () => void };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound");
}

function unavailable(operation: string, error: unknown): ConnectorError {
  return new ConnectorError("UNAVAILABLE", `${operation} failed: ${error instanceof Error ? error.name : "UnknownError"}`, "S3", { cause: error });
}

let sharedClient: S3Client | undefined;

export function s3EvidenceStore(deps: S3EvidenceStoreDeps = {}): EvidenceObjectStore {
  const s3 = (): S3Sender => {
    if (deps.client !== undefined) return deps.client;
    sharedClient ??= new S3Client(awsClientConfig(CLIENT_TIMEOUTS.s3));
    return sharedClient;
  };
  const media = deps.mediaBucket ?? (() => bucketName("Media"));
  const evidence = deps.evidenceBucket ?? (() => bucketName("Evidence"));
  return {
    async readMedia(key, maxBytes) {
      let output: GetOutput;
      try {
        output = (await s3().send(new GetObjectCommand({ Bucket: media(), Key: key }))) as GetOutput;
      } catch (error) {
        if (isNotFound(error)) return { ok: false, problem: "MISSING" };
        throw unavailable("GetObject", error);
      }
      if (output.Body === undefined) return { ok: false, problem: "MISSING" };
      if ((output.ContentLength ?? 0) > maxBytes) {
        output.Body.destroy?.();
        return { ok: false, problem: "TOO_LARGE" };
      }
      const bytes = await output.Body.transformToByteArray();
      return bytes.length > maxBytes ? { ok: false, problem: "TOO_LARGE" } : { ok: true, bytes };
    },
    async putEvidencePhoto(key, jpeg) {
      try {
        await s3().send(new PutObjectCommand({ Bucket: evidence(), Key: key, Body: jpeg, ContentType: "image/jpeg" }));
      } catch (error) {
        throw unavailable("PutObject", error);
      }
    },
  };
}
