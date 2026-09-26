/// <reference path="../../sst-env.d.ts" />
// The S3 side of the world factory: the guest template in `Seed/worlds/` (where the IaC uploaded it,
// with the digest of the `WorldTemplates` link) and the `guest/<seg>/` objects of `Media` and `Evidence`
// that the destruction of a generation empties. Both with the timeouts of lib/clients.ts.
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { bucketName, readLinked } from "../lib/resource";
import type { ObjectBucket, ObjectStore } from "./guest-lifecycle";
import { type TemplateSource, TemplateError } from "./template";

let s3: S3Client | undefined;
const client = (): S3Client => (s3 ??= new S3Client(awsClientConfig(CLIENT_TIMEOUTS.s3)));

const WorldTemplatesLink = z.object({ templates: z.record(z.string(), z.object({ key: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })) });

/** The templates the IaC uploaded (`Resource.WorldTemplates`), read from the `Seed` bucket. */
export function s3TemplateSource(sender: Pick<S3Client, "send"> = client()): TemplateSource {
  return {
    locate(name) {
      const object = readLinked("WorldTemplates", WorldTemplatesLink).templates[name];
      if (object === undefined) throw new TemplateError(`template ${name} was not uploaded`);
      return object;
    },
    async read(key) {
      const output = await sender.send(new GetObjectCommand({ Bucket: bucketName("Seed"), Key: key }));
      const text = await output.Body?.transformToString("utf-8");
      if (text === undefined) throw new TemplateError(`template ${key} is empty`);
      return text;
    },
  };
}

const DELETE_BATCH = 1_000;

/** Lists and deletes the objects under a prefix of `Media` or `Evidence` (never an empty prefix). */
export function s3ObjectStore(sender: Pick<S3Client, "send"> = client()): ObjectStore {
  return {
    async deletePrefix(bucket: ObjectBucket, prefix: string) {
      if (!prefix.startsWith("guest/")) throw new RangeError("only guest/ prefixes are deleted here");
      const name = bucketName(bucket);
      let deleted = 0;
      let token: string | undefined;
      do {
        const page = await sender.send(new ListObjectsV2Command({ Bucket: name, Prefix: prefix, MaxKeys: DELETE_BATCH, ContinuationToken: token }));
        const keys = (page.Contents ?? []).map((object) => object.Key).filter((key): key is string => key !== undefined && key.startsWith(prefix));
        if (keys.length > 0) {
          await sender.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
          deleted += keys.length;
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);
      return deleted;
    },
  };
}
