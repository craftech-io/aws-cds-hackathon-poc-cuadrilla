import { describe, expect, it } from "vitest";
import { authForwardingVerdict, directUrlProblems, edgeInventory, healthVerdict, rootProblems, signupEdgeVerdict, stateInventory } from "./interim";

const SECURE = {
  "content-security-policy": "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

describe("interim smoke", () => {
  it("accepts the console root with every security header", () => {
    expect(rootProblems(200, SECURE)).toEqual([]);
  });

  it("names each missing header and a non-200 root", () => {
    expect(rootProblems(403, {})).toEqual([
      "GET / answered 403",
      "GET / has no strict Content-Security-Policy",
      "GET / has no Strict-Transport-Security",
      "GET / has no X-Frame-Options DENY",
      "GET / has no X-Content-Type-Options nosniff",
    ]);
    expect(rootProblems(200, { ...SECURE, "x-frame-options": "SAMEORIGIN" })).toEqual(["GET / has no X-Frame-Options DENY"]);
  });

  it("[FL-114] tells a GET query whose Authorization reached the BFF from one CloudFront stripped", () => {
    const refusal = (reason: string) => JSON.stringify({ error: { message: "x", code: -32001, data: { code: "UNAUTHORIZED", httpStatus: 401, reason } } });
    expect(authForwardingVerdict(401, refusal("TOKEN_INVALID"))).toBe("forwarded");
    expect(authForwardingVerdict(401, `[${refusal("TOKEN_INVALID")}]`)).toBe("forwarded");
    expect(authForwardingVerdict(401, refusal("TOKEN_MISSING"))).toBe("stripped");
    expect(authForwardingVerdict(200, "<!doctype html>")).toBe("failed");
    expect(authForwardingVerdict(403, "")).toBe("failed");
  });

  it("tells the BFF health probe from the console's fallback page", () => {
    expect(healthVerdict(200, "application/json", JSON.stringify({ result: { data: { ok: true, service: "bff" } } }))).toBe("ok");
    expect(healthVerdict(200, "text/html; charset=utf-8", "<!doctype html>")).toBe("not-deployed");
    expect(healthVerdict(503, "application/json", "{}")).toBe("failed");
    expect(healthVerdict(200, "application/json", "not json")).toBe("failed");
    expect(healthVerdict(200, "application/json", JSON.stringify({ result: { data: { ok: false } } }))).toBe("failed");
  });

  it("reads table and function names from the app's own SST state, nothing else", () => {
    const state = {
      stack: "organization/app/poc",
      latest: {
        resources: [
          { type: "aws:dynamodb/table:Table", outputs: { name: "app-poc-WorldsTable-b" } },
          { type: "aws:dynamodb/table:Table", outputs: { name: "app-poc-CasesTable-a" } },
          { type: "aws:lambda/function:Function", outputs: { name: "app-poc-BffFunction-c" } },
          { type: "aws:s3/bucket:Bucket", outputs: { bucket: "app-poc-media" } },
          { type: "aws:lambda/function:Function", outputs: {} },
          { type: "pulumi:pulumi:Stack" },
        ],
      },
    };
    expect(stateInventory(state)).toEqual({
      tables: ["app-poc-CasesTable-a", "app-poc-WorldsTable-b"],
      functions: ["app-poc-BffFunction-c"],
    });
    expect(stateInventory({ latest: { resources: [] } })).toEqual({ tables: [], functions: [] });
    expect(() => stateInventory({ stack: "x" })).toThrow(/latest.resources/);
    expect(() => stateInventory(null)).toThrow(/latest.resources/);
  });
});

describe("interim smoke of the sign-up's edge (ADR-0025 §3-§4) [FL-114]", () => {
  it("takes AWS WAF's challenge, and the app's empty 400 for a batch, as the only good answers", () => {
    expect(signupEdgeVerdict(202, { "x-amzn-waf-action": "challenge" }, "<html>")).toBe("challenge");
    expect(signupEdgeVerdict(405, { "x-amzn-waf-action": "Challenge" }, "")).toBe("challenge");
    expect(signupEdgeVerdict(400, {}, "")).toBe("rejected");
    expect(signupEdgeVerdict(200, {}, '{"result":{"data":{"ticket":"x"}}}')).toBe("failed");
    expect(signupEdgeVerdict(429, {}, '{"error":{"message":"RATE_LIMITED"}}')).toBe("failed");
    expect(signupEdgeVerdict(400, {}, '{"error":{"message":"INVALID"}}')).toBe("failed");
  });

  it("demands 403 without a body from the Bff's Function URL called directly", () => {
    expect(directUrlProblems(403, "")).toEqual([]);
    expect(directUrlProblems(200, "{}")).toEqual(["POST to the Bff's Function URL answered 200 with a body: expected 403 without a body"]);
    expect(directUrlProblems(403, "Forbidden")).toHaveLength(1);
  });

  const EDGE_ARN = "arn:aws:wafv2:us-east-1:1:global/webacl/app-poc-edge/1";
  const AUTH_ARN = "arn:aws:wafv2:us-east-1:1:regional/webacl/app-poc-auth/2";
  const POOL = "arn:aws:cognito-idp:us-east-1:1:userpool/us-east-1_x";
  const state = (resources: unknown[]) => ({ latest: { resources } });
  const attached = [
    { type: "aws:lambda/functionUrl:FunctionUrl", outputs: { authorizationType: "NONE", functionUrl: "https://bff.lambda-url.us-east-1.on.aws/" } },
    { type: "aws:lambda/functionUrl:FunctionUrl", outputs: { authorizationType: "AWS_IAM", functionUrl: "https://mock.lambda-url.us-east-1.on.aws/" } },
    { type: "aws:wafv2/webAcl:WebAcl", outputs: { name: "app-poc-edge", arn: EDGE_ARN } },
    { type: "aws:wafv2/webAcl:WebAcl", outputs: { name: "app-poc-auth", arn: AUTH_ARN } },
    { type: "aws:cloudfront/distribution:Distribution", outputs: { webAclId: EDGE_ARN } },
    { type: "aws:cognito/userPool:UserPool", outputs: { arn: POOL } },
    { type: "aws:wafv2/webAclAssociation:WebAclAssociation", outputs: { webAclArn: AUTH_ARN, resourceArn: POOL } },
  ];

  it("finds the one public Function URL and both web ACLs attached, from the app's own state", () => {
    expect(edgeInventory(state(attached))).toEqual({ publicFunctionUrls: ["https://bff.lambda-url.us-east-1.on.aws/"], problems: [] });
  });

  it("reports a second public URL, a Router without the edge ACL and a pool without its ACL", () => {
    const broken = [...attached.slice(0, 4), { type: "aws:lambda/functionUrl:FunctionUrl", outputs: { authorizationType: "NONE", functionUrl: "https://x/" } }, { type: "aws:cloudfront/distribution:Distribution", outputs: { webAclId: "" } }];
    expect(edgeInventory(state(broken)).problems).toEqual([
      "expected exactly one public Function URL (the Bff's), found 2",
      "the edge web ACL is not on the Router's distribution",
      "the user pool's web ACL is not associated with the pool",
    ]);
  });
});
