// The app's web ACLs (ADR-0025 §4, ADR-0030, docs/architecture.md §1): the pool's own ACL against its spec
// (infra/waf-spec.ts) and the module that builds it (infra/waf.ts, read as text), and the account's shared
// edge ACL, looked up by name and never created here. The pool's rate scopes are also run, with a small
// evaluator of the byte-match statements, against the calls the browser makes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COGNITO_RATE_RULES,
  SHARED_EDGE_RULES,
  SHARED_EDGE_WEB_ACL,
  SHARED_SMS_CODE_PATH,
  SMS_CODE_PROCEDURES,
  authRules,
  cognitoTarget,
  webAclName,
  webAclSpec,
  type WafRule,
  type WafStatement,
} from "./waf-spec";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const wafModule = read("infra/waf.ts").replace(/^\s*\/\/.*$/gm, "");

// ---- An evaluator of the byte-match statements, with AWS WAF's text transformations ------------------------

interface Request {
  readonly path: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

function evaluate(statement: WafStatement, request: Request): boolean {
  if ("OrStatement" in statement) return statement.OrStatement.Statements.some((inner) => evaluate(inner, request));
  const { SearchString, FieldToMatch, TextTransformations } = statement.ByteMatchStatement;
  const raw = request.headers?.[FieldToMatch.SingleHeader.Name] ?? "";
  const value = TextTransformations.reduce((text, { Type }) => (Type === "LOWERCASE" ? text.toLowerCase() : text), raw);
  return value === SearchString;
}

describe("shared edge ACL (CLOUDFRONT, on the Router) [FL-114]", () => {
  it("is demos-borde, looked up by name on every deploy and put on the distribution; the app creates no edge ACL", () => {
    expect(SHARED_EDGE_WEB_ACL).toBe("demos-borde");
    expect(wafModule).toContain('aws.wafv2.getWebAclOutput({ name: SHARED_EDGE_WEB_ACL, scope: "CLOUDFRONT" })');
    expect(read("infra/web.ts")).toContain("args.webAclArn = sharedEdgeWebAcl.arn;");
    expect(wafModule.match(/new aws\.wafv2\.WebAcl\(/g)).toHaveLength(1);
    expect(wafModule).not.toMatch(/"EdgeWebAcl"|applicationIntegrationUrl/);
  });

  it("lists the shared rules as craftech/demos declares them, and every SMS code procedure falls under its SMS path", () => {
    expect(SHARED_EDGE_RULES.map((item) => item.name)).toEqual(["BlockList", "IpReputation", "AnonymousIp", "HostingSignup", "SignupRate", "SmsCodeRate", "ApiRate"]);
    for (const procedure of SMS_CODE_PROCEDURES) expect(procedure.toLowerCase().startsWith(SHARED_SMS_CODE_PATH), procedure).toBe(true);
    expect(read("packages/bff/src/routers/trpc.ts")).toContain('"phone.status", "phone.sendCode", "phone.verifyCode", "phone.carrySession", "phone.endSession"');
  });
});

describe("pool ACL (REGIONAL, on the user pool)", () => {
  const rules: WafRule[] = authRules();

  it("[FL-113] has IP reputation and per-IP rates on x-amz-target, all Block", () => {
    expect(rules.map((item) => [item.Priority, item.Name])).toEqual([
      [1, "AWSManagedRulesAmazonIpReputationList"],
      [2, "RateSignUp"],
      [3, "RateCodeEmails"],
      [4, "RateCodeChecks"],
      [5, "RateSignIn"],
    ]);
    expect(COGNITO_RATE_RULES.map((item) => [item.name, item.limit, [...item.operations]])).toEqual([
      ["RateSignUp", 10, ["SignUp"]],
      // The operations that send a code to an inbox get the lowest rate AWS WAF allows.
      ["RateCodeEmails", 10, ["ResendConfirmationCode", "ForgotPassword"]],
      ["RateCodeChecks", 20, ["ConfirmSignUp", "ConfirmForgotPassword"]],
      ["RateSignIn", 100, ["InitiateAuth", "RespondToAuthChallenge"]],
    ]);
    for (const item of rules.slice(1)) expect(item.Action, item.Name).toEqual({ Block: {} });
    const targets = JSON.stringify(rules).match(/"SearchString":"([^"]+)"/g) ?? [];
    expect(targets).toHaveLength(7);
    expect(JSON.stringify(rules)).toContain(`"SearchString":"${cognitoTarget("SignUp")}","FieldToMatch":{"SingleHeader":{"Name":"x-amz-target"}}`);
    expect(cognitoTarget("SignUp")).toBe("awscognitoidentityproviderservice.signup");
  });

  it("[SEC-2B-02] never matches on the body: Cognito hands AWS WAF no user name, so such a rule would block every valid gst-* SignUp", () => {
    const text = JSON.stringify(rules);
    expect(text).not.toMatch(/JsonBody|"Body"|RegexMatchStatement|Username/);
    expect(rules.map((item) => item.Name)).not.toContain("SignupUsernameShape");
    // A valid sign-up call reaches Cognito (and its pre sign-up trigger) with nothing but the rates in the way.
    const signUp: Request = { path: "/", method: "POST", headers: { "x-amz-target": cognitoTarget("SignUp") } };
    for (const item of rules.slice(1)) {
      const scope = Reflect.get(item.Statement.RateBasedStatement as object, "ScopeDownStatement") as WafStatement;
      expect(evaluate(scope, signUp), item.Name).toBe(item.Name === "RateSignUp");
    }
  });
});

describe("the pool's ACL as a whole", () => {
  it("has the fixed name of docs/architecture.md §1 and the scope of ADR-0025 §4", () => {
    expect(read("docs/architecture.md")).toContain(`\`${webAclName("auth")}\``);
    expect(webAclSpec("auth")).toMatchObject({ name: "aws-cds-hackathon-poc-cuadrilla-poc-auth", scope: "REGIONAL", defaultAction: { allow: {} } });
  });

  it("never uses CAPTCHA, in any rule or override", () => {
    expect(JSON.stringify(webAclSpec("auth"))).not.toMatch(/captcha/i);
  });

  it("publishes per-rule metrics with sampled requests and keeps no full logs", () => {
    for (const item of webAclSpec("auth").rules) expect(item.VisibilityConfig).toEqual({ SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: `CuadrillaWaf-auth-${item.Name}` });
    expect(wafModule).not.toMatch(/LoggingConfiguration|logDestination/);
  });

  it("is created from the spec as ruleJson and associated with the user pool", () => {
    expect(wafModule).toContain("ruleJson: JSON.stringify(authSpec.rules)");
    expect(wafModule).toMatch(/new aws\.wafv2\.WebAclAssociation\("AuthWebAclAssociation", \{\s+resourceArn: userPool\.arn,\s+webAclArn: authWebAcl\.arn,/);
    expect(wafModule).not.toMatch(/APIKey|ApiKey|captcha/i);
  });
});
