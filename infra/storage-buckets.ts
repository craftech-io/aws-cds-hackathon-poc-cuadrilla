// S3 buckets of docs/architecture.md §6: layout, retention and CORS live in storage-keys.ts (checked by
// storage-keys.test.ts). Imported by infra/storage.ts.
//
//   Media      WhatsApp media (live), the phone simulator's uploads, Transcribe output; 30 days
//   Evidence   validated photos and installation certificates; life of the stage
//   Manual     the procedures manual the Knowledge Base ingests (infra/storage-kb.ts); life of the stage
//   Seed       world templates, synthetic photos and voices, evaluation set, Transcribe vocabulary
//              (infra/media.ts), the partner's logos and the template header sample; life of the stage
//
// Every bucket: private (BlockPublicAccess on all four settings, SST's default), HTTPS enforced by the
// SST component's policy (Deny when `aws:SecureTransport` is false), SSE-S3 declared explicitly,
// incomplete multipart uploads aborted after 7 days, `qa/` and `eval/` gone in two days where QA and
// evaluation worlds write (Media, Evidence), and `forceDestroy` (SST's default) so removing the stage
// empties them. Only Media has a CORS rule: SST's default rule allows every origin and method, so
// every other bucket gets `cors: false`.
//
// Fixed physical names (ci-spec.ts `browserBucketName`, account id as suffix so nobody else can hold
// them) for the three buckets the browser reaches with presigned URLs, because the console's CSP
// lives in the CI bootstrap and must know them before the first deploy: Media (POST from the
// simulator, GET of photos and audio), Evidence (GET of photos and certificates) and Seed (GET of the
// partner's logos under `brand/`). Manual keeps SST's name, under the same bucket prefix.
//
// The lifecycle configuration is ONE resource per bucket (S3 replaces it, never merges), so every rule
// of a bucket lives here, the Transcribe output backstop of Media included; no other module may add
// one. A bucket also has exactly one policy, the SST component's.
//
// Verify: `aws --profile craftech-demos s3api get-bucket-lifecycle-configuration --bucket <name>` ·
// `get-bucket-cors` (Media only) · `get-bucket-policy` · `get-public-access-block` ·
// `get-bucket-encryption`.

import { browserBucketName } from "./ci-spec";
import { appUrl } from "./dns";
import type { BucketName } from "./iam-capabilities";
import { BUCKET_SPECS, assertBucketLogicalName, browserUploadCors, lifecycleRules, type BucketNaming, type BucketSpec } from "./storage-keys";

const accountId = aws.getCallerIdentityOutput({}).accountId;

/** Fixed physical name of a bucket, or `undefined` to keep SST's. */
function fixedName(naming: BucketNaming): $util.Output<string> | undefined {
  switch (naming.kind) {
    case "browser":
      return accountId.apply((account) => browserBucketName($app.name, $app.stage, naming.purpose, account));
    case "sst":
      return undefined;
  }
}

function corsOf(spec: BucketSpec): sst.aws.BucketArgs["cors"] {
  if (!spec.browserUploads) return false;
  const cors = browserUploadCors(appUrl);
  return {
    allowOrigins: cors.allowOrigins,
    allowMethods: cors.allowMethods,
    allowHeaders: cors.allowHeaders,
    exposeHeaders: cors.exposeHeaders,
    maxAge: `${cors.maxAgeSeconds} seconds`,
  };
}

function bucket(name: BucketName): sst.aws.Bucket {
  const spec: BucketSpec = BUCKET_SPECS[name];
  const physicalName = fixedName(spec.naming);

  const created = new sst.aws.Bucket(assertBucketLogicalName(name), {
    cors: corsOf(spec),
    transform: {
      bucket: (args) => {
        if (physicalName !== undefined) args.bucket = physicalName;
      },
    },
  });

  new aws.s3.BucketServerSideEncryptionConfiguration(`${name}Encryption`, {
    bucket: created.name,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
  });

  new aws.s3.BucketLifecycleConfiguration(`${name}Lifecycle`, {
    bucket: created.name,
    rules: lifecycleRules(spec),
  });

  return created;
}

export const mediaBucket = bucket("Media");
export const evidenceBucket = bucket("Evidence");
export const manualBucket = bucket("Manual");
export const seedBucket = bucket("Seed");

/** Every bucket of the app, by logical name (the same name `Resource.<Name>` exposes). */
export const buckets = {
  Media: mediaBucket,
  Evidence: evidenceBucket,
  Manual: manualBucket,
  Seed: seedBucket,
} as const satisfies Record<BucketName, sst.aws.Bucket>;
