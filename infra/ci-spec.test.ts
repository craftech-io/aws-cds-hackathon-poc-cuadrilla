// The CloudFront names infra/ci.ts and infra/web.ts give the Router, and the bucket names the CSP
// allows, must fall inside the fences of the CI bootstrap (infra/bootstrap/ci-role.yaml): a name
// outside them fails the deploy closed, and a fence wider than them reaches the parts of other
// projects of the shared account.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_BUCKETS,
  BUCKET_PREFIX_LENGTH,
  CI_DEPLOY_STAGE,
  CLOUDFRONT_NAME_MAX_LENGTH,
  CONSOLE_CSP,
  DISPLAY_BUCKETS,
  UPLOAD_BUCKETS,
  browserBucketName,
  bucketPrefix,
  cloudFrontFunctionName,
  cloudFrontFunctionPrefix,
  consoleHeadersPolicyName,
  routerKeyValueStoreName,
} from "./ci-spec";

const APP = "aws-cds-hackathon-poc-cuadrilla";
const ACCOUNT = "776805327629";
const template = readFileSync(resolve(process.cwd(), "infra/bootstrap/ci-role.yaml"), "utf8");

/** `Default:` of one entry of the template's `Parameters:`. */
function parameterDefault(name: string): string {
  const match = template.match(new RegExp(`\\n  ${name}:\\n(?:    .*\\n)*?    Default: (.+)\\n`));
  expect(match, `parameter ${name}`).not.toBeNull();
  return (match?.[1] ?? "").trim();
}

// Logical names SST 4.17.1 gives the CloudFront functions of the Router (router.ts) and of a
// StaticSite served without it (static-site.ts).
const SST_FUNCTION_NAMES = [
  "RouterCloudfrontFunctionRequest",
  "RouterCloudfrontFunctionResponse",
  "ConsoleCloudfrontFunctionRequest",
  "ConsoleCloudfrontFunctionResponse",
];

const infraSource = (file: string): string => readFileSync(resolve(process.cwd(), "infra", file), "utf8");

/** SST's prefixName (platform/src/components/naming.ts) for a 63-char bucket with its 9-char suffix. */
function sstBucketMain(app: string, stage: string, logical: string): string {
  const name = `${logical}Bucket`;
  const max = 63 - 9;
  return `${app.substring(0, max - stage.length - name.length - 2)}-${stage}-${name}`;
}

describe("names shared with the bootstrap template", () => {
  it("uses the app name, deploy stage and bucket prefix the template defaults to", () => {
    expect(parameterDefault("AppName")).toBe(APP);
    expect(parameterDefault("DeployStage")).toBe(CI_DEPLOY_STAGE);
    expect(parameterDefault("BucketPrefix")).toBe(bucketPrefix(APP));
    expect(bucketPrefix(APP)).toBe("aws-cds-hackathon-poc-cua");
  });

  it("keeps SST-named buckets of up to 18 characters inside the bucket prefix", () => {
    for (const logical of ["Media", "Evidence", "Manual", "Seed", "A".repeat(16), "B".repeat(18)]) {
      expect(sstBucketMain(APP, CI_DEPLOY_STAGE, logical).toLowerCase().startsWith(bucketPrefix(APP))).toBe(true);
    }
    expect(sstBucketMain(APP, CI_DEPLOY_STAGE, "C".repeat(19)).startsWith(bucketPrefix(APP))).toBe(false);
    expect(BUCKET_PREFIX_LENGTH).toBe(25);
  });

  it("names the fixed buckets inside the prefix and within S3's 63 characters", () => {
    for (const purpose of BROWSER_BUCKETS) {
      const name = browserBucketName(APP, CI_DEPLOY_STAGE, purpose, ACCOUNT);
      expect(name.startsWith(bucketPrefix(APP))).toBe(true);
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("fences functions by the same prefix the names are built with", () => {
    const fence = `function/${cloudFrontFunctionPrefix("${AppName}", "${DeployStage}")}*"`;
    expect(template.split(fence).length - 1).toBe(2);
  });

  it("names every CloudFront function of the app and hands the bootstrap store to the Router", () => {
    expect(infraSource("ci.ts")).toMatch(
      /\$transform\(aws\.cloudfront\.Function, \(args, _opts, name\) => \{\n\s+args\.name = cloudFrontFunctionName\(\$app\.name, \$app\.stage, name\);/,
    );
    const web = infraSource("web.ts");
    expect(web).toContain("aws.cloudfront.KeyValueStore.get(\"RouterBootstrapKvStore\", routerKeyValueStoreName($app.name, $app.stage))");
    expect(web).toMatch(/viewerRequest: \{ injection: "", kvStore: bootstrapKvStoreArn \}/);
  });

  it("names the Router key-value store as the template creates it", () => {
    expect(template).toContain(`Name: !Sub "${routerKeyValueStoreName("${AppName}", "${DeployStage}")}"`);
    expect(routerKeyValueStoreName(APP, CI_DEPLOY_STAGE).length).toBeLessThanOrEqual(CLOUDFRONT_NAME_MAX_LENGTH);
  });
});

describe("cloudFrontFunctionName", () => {
  it("keeps every SST function of the deploy stage whole and under the fence", () => {
    const names = SST_FUNCTION_NAMES.map((logical) => cloudFrontFunctionName(APP, CI_DEPLOY_STAGE, logical));
    for (const name of names) {
      expect(name.startsWith(`${APP}-${CI_DEPLOY_STAGE}-`)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(CLOUDFRONT_NAME_MAX_LENGTH);
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("is deterministic, with no random suffix to escape the fence", () => {
    expect(cloudFrontFunctionName(APP, "poc", "RouterCloudfrontFunctionRequest")).toBe(`${APP}-poc-RouterRequest`);
  });

  it("never matches the name SST would give, whose truncated app prefix other apps share", () => {
    const sstDefault = "aws-cds-hackathon-p-poc-RouterCloudfrontFunctionRequest-abcdefgh";
    expect(sstDefault.startsWith(cloudFrontFunctionPrefix(APP, CI_DEPLOY_STAGE))).toBe(false);
  });

  it("throws instead of truncating a name that would leave the fence", () => {
    expect(() => cloudFrontFunctionName(APP, "poc", "A".repeat(40))).toThrow(/at most 64/);
    expect(() => cloudFrontFunctionName(APP, "poc", "CloudfrontFunction")).toThrow();
  });
});

describe("security headers of the console", () => {
  it("puts the console behind the policy the template creates, with a strict CSP", () => {
    expect(template).toContain(`Name: !Sub "${consoleHeadersPolicyName("${AppName}", "${DeployStage}")}"`);
    expect(template).toContain(`ContentSecurityPolicy: !Sub "${CONSOLE_CSP}"`);
    expect(template).toMatch(/FrameOptions: \{ FrameOption: DENY, Override: true \}/);
    expect(template).toMatch(/StrictTransportSecurity: \{ AccessControlMaxAgeSec: 31536000/);
    expect(template).toMatch(/ContentTypeOptions: \{ Override: true \}/);
    const web = infraSource("web.ts");
    expect(web).toContain("aws.cloudfront.getResponseHeadersPolicyOutput({ name: consoleHeadersPolicyName($app.name, $app.stage) })");
    expect(web).toContain("args.defaultCacheBehavior = withHeadersPolicy(args.defaultCacheBehavior, consoleHeadersPolicyId)");
  });

  it("uploads only to Media and reaches only its own origin and Cognito besides", () => {
    expect(UPLOAD_BUCKETS).toEqual(["media"]);
    const connect = CONSOLE_CSP.split("; ").find((directive) => directive.startsWith("connect-src")) ?? "";
    expect(connect.split(" ")).toEqual([
      "connect-src",
      "'self'",
      "https://cognito-idp.${Region}.amazonaws.com",
      "https://${BucketPrefix}-${DeployStage}-media-${AWS::AccountId}.s3.${Region}.amazonaws.com",
    ]);
    expect(CONSOLE_CSP).toContain("frame-ancestors 'none'");
    expect(CONSOLE_CSP).toContain("script-src 'self'");
    expect(CONSOLE_CSP).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|\*/);
  });

  it("shows images and audio from Media, Evidence and Seed (the brand logos), never from another origin", () => {
    expect([...DISPLAY_BUCKETS].sort()).toEqual(["evidence", "media", "seed"]);
    for (const directive of ["img-src", "media-src"]) {
      const sources = (CONSOLE_CSP.split("; ").find((entry) => entry.startsWith(directive)) ?? "").split(" ").slice(1);
      const buckets = sources.filter((source) => source.startsWith("https://"));
      expect(buckets.map((origin) => /-\$\{DeployStage\}-([a-z]+)-/.exec(origin)?.[1]).sort(), directive).toEqual(["evidence", "media", "seed"]);
      expect(sources.filter((source) => !source.startsWith("https://")).every((source) => ["'self'", "data:", "blob:"].includes(source))).toBe(true);
    }
  });

  it("fits CloudFront's 1,783-character limit for a Content-Security-Policy once substituted", () => {
    const rendered = CONSOLE_CSP.replaceAll("${BucketPrefix}", bucketPrefix(APP))
      .replaceAll("${DeployStage}", CI_DEPLOY_STAGE)
      .replaceAll("${AWS::AccountId}", ACCOUNT)
      .replaceAll("${Region}", "us-east-1");
    expect(rendered).not.toContain("${");
    expect(rendered.length).toBeLessThanOrEqual(1783);
    for (const bucket of DISPLAY_BUCKETS) expect(rendered).toContain(`https://${browserBucketName(APP, CI_DEPLOY_STAGE, bucket, ACCOUNT)}.s3.us-east-1.amazonaws.com`);
  });
});
