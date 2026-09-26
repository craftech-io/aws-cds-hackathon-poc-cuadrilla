// Names the CI bootstrap (infra/bootstrap/ci-role.yaml) and the app must agree on, as plain data
// and pure functions. No SST or Pulumi dependency: infra/ci.ts and infra/web.ts apply them, and
// infra/ci-spec.test.ts checks them, against the template text as well, without an AWS account.
//
// CloudFront is account-wide and its functions, key-value stores and cache policies are not fenced by
// `sst:app` as the rest of the app is (functions carry the default tags since aws 7.33.0, but the
// deploy role reads and writes their tags by name too):
//
//   function          ARN `function/<name>`. SST would name it `<app, truncated>-<stage>-<logical>-
//                     <random>`, and the truncated app name is shared by any app whose name starts
//                     the same. infra/ci.ts pins `<app>-<stage>-<logical>` instead, so the role
//                     updates, publishes, tags and deletes only `function/<app>-<DeployStage>-*` (a
//                     create has no resource-level permission, and a name is unique in the account).
//   key-value store   ARN `key-value-store/<opaque id>`, and it is the routing table of the Router.
//                     The bootstrap creates the store of the deploy stage with a fixed name and the
//                     role writes only that ARN; infra/web.ts hands it to the Router.
//   cache policy      ARN `cache-policy/<opaque id>`: created and read freely, changed only on the
//                     id the operator declares (template parameter RouterCachePolicyId).
//
// The console's Content-Security-Policy lives in the bootstrap (the deploy role cannot change a
// response headers policy), so every origin it allows must be known before the first deploy. The
// browser talks to three buckets (docs/architecture.md §6 and §10): it POSTs photos and recorded
// voice notes to `Media` from the phone simulator, and it shows photos, audio and certificates from
// `Media` and `Evidence` and the partner's logos from `Seed/brand/` through presigned GETs. Their
// names are therefore fixed here, with the account id as suffix (global S3 names; nobody else can
// hold them) and the bucket prefix the CI role is fenced to. infra/storage-buckets.ts (WP-06) names
// the three buckets with `browserBucketName`.

import { WAF_CSP_SOURCES } from "./web-spec";

/** The only stage CI deploys (template parameter DeployStage). */
export const CI_DEPLOY_STAGE = "poc";

/** CloudFront limit and alphabet for function and key-value store names. */
export const CLOUDFRONT_NAME_MAX_LENGTH = 64;
const CLOUDFRONT_NAME = /^[A-Za-z0-9_-]+$/;

/** Every CloudFront function of a stage starts with this; the deploy role is fenced to it. */
export function cloudFrontFunctionPrefix(app: string, stage: string): string {
  return `${app}-${stage}-`;
}

/**
 * Deterministic name of a CloudFront function, from the Pulumi logical name SST gives it
 * (`RouterCloudfrontFunctionRequest` → `<app>-<stage>-RouterRequest`). Throws instead of truncating:
 * a truncated name would fall outside the prefix the deploy role is fenced to.
 */
export function cloudFrontFunctionName(app: string, stage: string, logicalName: string): string {
  const compact = logicalName.replace(/[^A-Za-z0-9]/g, "").replace(/CloudfrontFunction/g, "");
  const name = `${cloudFrontFunctionPrefix(app, stage)}${compact}`;
  if (compact.length === 0 || name.length > CLOUDFRONT_NAME_MAX_LENGTH || !CLOUDFRONT_NAME.test(name)) {
    throw new Error(
      `CloudFront function "${logicalName}" cannot be named "${name}": at most ${CLOUDFRONT_NAME_MAX_LENGTH} ` +
        `characters of [A-Za-z0-9_-] under the prefix the CI deploy role is fenced to. Shorten the component name.`,
    );
  }
  return name;
}

/** Name of the console's response headers policy the bootstrap creates (ConsoleResponseHeadersPolicy). */
export function consoleHeadersPolicyName(app: string, stage: string): string {
  return `${app}-${stage}-console`;
}

/** Name of the Router key-value store the bootstrap creates for a stage (resource RouterKeyValueStore). */
export function routerKeyValueStoreName(app: string, stage: string): string {
  return `${app}-${stage}-router`;
}

// ---- Buckets -----------------------------------------------------------------------------------

/**
 * Leading characters of the app name that survive SST's truncation inside a 63-character bucket
 * name (`<app>-<stage>-<logical>Bucket-<8 random>`, platform/src/components/naming.ts): with the
 * stage `poc`, 25 characters keep working for logical bucket names of up to 18 characters.
 * Template parameter BucketPrefix; infra/ci-spec.test.ts recomputes it.
 */
export const BUCKET_PREFIX_LENGTH = 25;

export function bucketPrefix(app: string): string {
  return app.slice(0, BUCKET_PREFIX_LENGTH);
}

/** The buckets the browser reaches with presigned URLs, so the CSP must name them. */
export const BROWSER_BUCKETS = ["media", "evidence", "seed"] as const;
export type BrowserBucket = (typeof BROWSER_BUCKETS)[number];

/** The only bucket the browser writes to (presigned POST of the phone simulator). */
export const UPLOAD_BUCKETS = ["media"] as const satisfies readonly BrowserBucket[];

/** Buckets whose objects the console shows (photos, audio, certificates, brand logos). */
export const DISPLAY_BUCKETS = ["media", "evidence", "seed"] as const satisfies readonly BrowserBucket[];

/** Fixed name of a browser-facing bucket: `<prefix>-<stage>-<purpose>-<account>`. */
export function browserBucketName(app: string, stage: string, purpose: BrowserBucket, accountId: string): string {
  return `${bucketPrefix(app)}-${stage}-${purpose}-${accountId}`;
}

// ---- Content-Security-Policy -------------------------------------------------------------------

/** Origin of a browser-facing bucket as CloudFormation writes it (`${...}` left for !Sub). */
function templateBucketOrigin(purpose: BrowserBucket): string {
  return `https://\${BucketPrefix}-\${DeployStage}-${purpose}-\${AWS::AccountId}.s3.\${Region}.amazonaws.com`;
}

/**
 * Content-Security-Policy of the console, landing and legal pages. The console only talks to its own
 * origin, to Cognito's endpoint (SRP sign-in and the own sign-up, packages/web/src/lib/auth/cognito.ts),
 * to the bucket it uploads to and to AWS WAF (the silent challenge of the sign-up, infra/web-spec.ts
 * WAF_CSP_SOURCES); it shows images and audio from its own origin and from the three browser buckets
 * (the TOTP QR is an inline SVG). Scripts only from its own origin and the AWS WAF SDK, and nothing
 * may frame it. `${...}` is left for CloudFormation to substitute.
 */
export const CONSOLE_CSP = [
  "default-src 'self'",
  `script-src 'self' ${WAF_CSP_SOURCES["script-src"].join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${DISPLAY_BUCKETS.map(templateBucketOrigin).join(" ")}`,
  `media-src 'self' blob: ${DISPLAY_BUCKETS.map(templateBucketOrigin).join(" ")}`,
  "font-src 'self' data:",
  `connect-src 'self' https://cognito-idp.\${Region}.amazonaws.com ${UPLOAD_BUCKETS.map(templateBucketOrigin).join(" ")} ${WAF_CSP_SOURCES["connect-src"].join(" ")}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");
