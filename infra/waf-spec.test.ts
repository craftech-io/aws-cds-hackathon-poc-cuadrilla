// The two web ACLs (ADR-0025 §4, docs/architecture.md §1) against their spec (infra/waf-spec.ts) and the
// module that builds them (infra/waf.ts, read as text). The sign-up scope is also run, with a small
// evaluator of the byte-match statements, against the paths a tRPC batch or an encoded path would use.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_IP_HEADER,
  ANONYMOUS_IP_HEADER_AT_ORIGIN,
  BOT_CONTROL_RULE,
  COGNITO_RATE_RULES,
  DECODE_AND_LOWERCASE,
  SIGNUP_SCOPE,
  authRules,
  cognitoTarget,
  edgeRules,
  requireIntegrationUrl,
  webAclName,
  webAclSpec,
  type WafRule,
  type WafStatement,
} from "./waf-spec";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const wafModule = read("infra/waf.ts").replace(/^\s*\/\/.*$/gm, "");
const rule = (rules: WafRule[], name: string): WafRule => {
  const found = rules.find((candidate) => candidate.Name === name);
  expect(found, name).toBeDefined();
  return found as WafRule;
};

// ---- An evaluator of the byte-match statements, with AWS WAF's text transformations ------------------------

interface Request {
  readonly path: string;
  readonly query?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

function transform(value: string, transformations: readonly { Type: string }[]): string {
  return transformations.reduce((text, { Type }) => {
    if (Type === "URL_DECODE") return decodeURIComponent(text.replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
    if (Type === "LOWERCASE") return text.toLowerCase();
    return text;
  }, value);
}

function evaluate(statement: WafStatement, request: Request): boolean {
  if ("AndStatement" in statement) return statement.AndStatement.Statements.every((inner) => evaluate(inner, request));
  if ("OrStatement" in statement) return statement.OrStatement.Statements.some((inner) => evaluate(inner, request));
  if ("NotStatement" in statement) return !evaluate(statement.NotStatement.Statement, request);
  const { SearchString, FieldToMatch, PositionalConstraint, TextTransformations } = statement.ByteMatchStatement;
  const raw = "UriPath" in FieldToMatch ? request.path : "QueryString" in FieldToMatch ? (request.query ?? "") : "SingleHeader" in FieldToMatch ? (request.headers?.[FieldToMatch.SingleHeader.Name] ?? "") : (request.method ?? "POST");
  const value = transform(raw, TextTransformations);
  if (PositionalConstraint === "STARTS_WITH") return value.startsWith(SearchString);
  if (PositionalConstraint === "CONTAINS") return value.includes(SearchString);
  return value === SearchString;
}

describe("sign-up scope of rules 2 to 4 (ADR-0025 §4) [FL-113] [FL-114]", () => {
  it("catches the sign-up in every shape tRPC would still run it", () => {
    const shapes: Request[] = [
      { path: "/api/signup.start" },
      { path: "/api/x,signup.start", query: "batch=1" },
      { path: "/api/health.live,signup.start", query: "batch=1" },
      { path: "/api/%73ignup.start", query: "batch=1" },
      { path: "/api/signup%2Estart", query: "batch=1" },
      { path: "/api/SIGNUP.START" },
      { path: "/api/x", query: "input=%7B%7D&p=signup.start" },
    ];
    for (const request of shapes) expect(evaluate(SIGNUP_SCOPE, request), JSON.stringify(request)).toBe(true);
  });

  it("leaves the rest of the console and the API alone", () => {
    for (const request of [{ path: "/" }, { path: "/signup" }, { path: "/api/health.live,brand.get", query: "batch=1" }, { path: "/legal/privacy.html" }]) {
      expect(evaluate(SIGNUP_SCOPE, request), JSON.stringify(request)).toBe(false);
    }
  });

  it("compares by content after URL_DECODE and LOWERCASE, never STARTS_WITH /api/signup.", () => {
    const text = JSON.stringify(SIGNUP_SCOPE);
    expect(text).not.toContain("/api/signup.");
    const matches = text.match(/"PositionalConstraint":"CONTAINS","TextTransformations":/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(DECODE_AND_LOWERCASE).toEqual([
      { Priority: 0, Type: "URL_DECODE" },
      { Priority: 1, Type: "LOWERCASE" },
    ]);
    for (const [, transformations] of text.matchAll(/"TextTransformations":(\[[^\]]*\])/g)) expect(JSON.parse(transformations ?? "[]")).toEqual(DECODE_AND_LOWERCASE);
  });

  it("is the same value in the four rules", () => {
    const rules = edgeRules();
    expect(rule(rules, "RateSignupPerIp").Statement).toEqual({ RateBasedStatement: { Limit: 10, EvaluationWindowSec: 300, AggregateKeyType: "IP", ScopeDownStatement: SIGNUP_SCOPE } });
    expect(Reflect.get(rule(rules, "AnonymousIpSignup").Statement.ManagedRuleGroupStatement as object, "ScopeDownStatement")).toEqual(SIGNUP_SCOPE);
    expect(Reflect.get(rule(rules, BOT_CONTROL_RULE).Statement.ManagedRuleGroupStatement as object, "ScopeDownStatement")).toEqual(SIGNUP_SCOPE);
    const challenge = rule(rules, "ChallengeSignup").Statement as { AndStatement: { Statements: WafStatement[] } };
    const scope = SIGNUP_SCOPE as { AndStatement: { Statements: WafStatement[] } };
    expect(challenge.AndStatement.Statements.slice(0, -1)).toEqual(scope.AndStatement.Statements);
    expect(challenge.AndStatement.Statements.at(-1)).toEqual({ ByteMatchStatement: { SearchString: "POST", FieldToMatch: { Method: {} }, PositionalConstraint: "EXACTLY", TextTransformations: [{ Priority: 0, Type: "NONE" }] } });
  });
});

describe("edge ACL (CLOUDFRONT, on the Router) [FL-114]", () => {
  const rules = edgeRules();

  it("has the six rules of ADR-0025 §4, in priority order, with their actions", () => {
    expect(rules.map((item) => [item.Priority, item.Name])).toEqual([
      [1, "AWSManagedRulesAmazonIpReputationList"],
      [2, "RateSignupPerIp"],
      [3, "AnonymousIpSignup"],
      [4, "BotControlSignup"],
      [5, "ChallengeSignup"],
      [6, "RatePerIp"],
    ]);
    expect(rule(rules, "AWSManagedRulesAmazonIpReputationList")).toMatchObject({ Statement: { ManagedRuleGroupStatement: { VendorName: "AWS", Name: "AWSManagedRulesAmazonIpReputationList" } }, OverrideAction: { None: {} } });
    expect(rule(rules, "RateSignupPerIp").Action).toEqual({ Block: {} });
    expect(rule(rules, "ChallengeSignup")).toMatchObject({ Action: { Challenge: {} }, ChallengeConfig: { ImmunityTimeProperty: { ImmunityTime: 300 } } });
    expect(rule(rules, "RatePerIp")).toMatchObject({ Statement: { RateBasedStatement: { Limit: 1000, EvaluationWindowSec: 300, AggregateKeyType: "IP" } }, Action: { Block: {} } });
    expect(rule(rules, "RatePerIp").Statement.RateBasedStatement).not.toHaveProperty("ScopeDownStatement");
  });

  it("only counts anonymous IPs: AnonymousIPList inserts cuadrilla-anon, HostingProviderIPList inserts nothing", () => {
    const group = rule(rules, "AnonymousIpSignup");
    expect(group.OverrideAction).toEqual({ None: {} });
    expect(group.Statement.ManagedRuleGroupStatement).toMatchObject({ VendorName: "AWS", Name: "AWSManagedRulesAnonymousIpList" });
    expect(Reflect.get(group.Statement.ManagedRuleGroupStatement as object, "RuleActionOverrides")).toEqual([
      { Name: "AnonymousIPList", ActionToUse: { Count: { CustomRequestHandling: { InsertHeaders: [{ Name: "cuadrilla-anon", Value: "1" }] } } } },
      { Name: "HostingProviderIPList", ActionToUse: { Count: {} } },
    ]);
    expect(ANONYMOUS_IP_HEADER).toBe("cuadrilla-anon");
    expect(ANONYMOUS_IP_HEADER_AT_ORIGIN).toBe("x-amzn-waf-cuadrilla-anon");
  });
  it("[SEC-2B-01] has targeted Bot Control on the sign-up scope, counted only: it gives the ACL its integration URL and blocks nothing", () => {
    const group = rule(rules, BOT_CONTROL_RULE);
    expect(group.OverrideAction).toEqual({ Count: {} });
    expect(group.Action).toBeUndefined();
    expect(group.Statement.ManagedRuleGroupStatement).toEqual({
      VendorName: "AWS",
      Name: "AWSManagedRulesBotControlRuleSet",
      ScopeDownStatement: SIGNUP_SCOPE,
      ManagedRuleGroupConfigs: [{ AWSManagedRulesBotControlRuleSet: { InspectionLevel: "TARGETED", EnableMachineLearning: false } }],
    });
    expect(Reflect.get(group.Statement.ManagedRuleGroupStatement as object, "RuleActionOverrides")).toBeUndefined();
    // The group runs before the Challenge, which stays the only rule that demands the token.
    expect(group.Priority).toBeLessThan(rule(rules, "ChallengeSignup").Priority);
  });

  it("[SEC-2B-01] an empty or missing integration URL stops the deploy; a real one passes unchanged", () => {
    const url = "https://abc123.us-east-1.sdk.awswaf.com/abc123/def456/";
    expect(requireIntegrationUrl(url)).toBe(url);
    expect(requireIntegrationUrl(` ${url} `)).toBe(url);
    for (const empty of [undefined, null, "", "   ", "http://abc.sdk.awswaf.com/a/b/", "abc123/def456/"]) expect(() => requireIntegrationUrl(empty), String(empty)).toThrow(/no application integration URL/);
  });
});

describe("pool ACL (REGIONAL, on the user pool)", () => {
  const rules = authRules();

  it("has IP reputation and per-IP rates on x-amz-target, all Block", () => {
    expect(rules.map((item) => [item.Priority, item.Name])).toEqual([
      [1, "AWSManagedRulesAmazonIpReputationList"],
      [2, "RateSignUp"],
      [3, "RateCodesAndRecovery"],
      [4, "RateSignIn"],
    ]);
    expect(COGNITO_RATE_RULES.map((item) => [item.name, item.limit, [...item.operations]])).toEqual([
      ["RateSignUp", 10, ["SignUp"]],
      ["RateCodesAndRecovery", 20, ["ConfirmSignUp", "ResendConfirmationCode", "ForgotPassword", "ConfirmForgotPassword"]],
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

describe("both ACLs", () => {
  it("have the fixed names of docs/architecture.md §1 and the scopes of ADR-0025 §4", () => {
    const architecture = read("docs/architecture.md");
    for (const kind of ["edge", "auth"] as const) expect(architecture).toContain(`\`${webAclName(kind)}\``);
    expect(webAclSpec("edge")).toMatchObject({ name: "aws-cds-hackathon-poc-cuadrilla-poc-edge", scope: "CLOUDFRONT", defaultAction: { allow: {} } });
    expect(webAclSpec("auth")).toMatchObject({ name: "aws-cds-hackathon-poc-cuadrilla-poc-auth", scope: "REGIONAL", defaultAction: { allow: {} } });
  });

  it("never use CAPTCHA, in any rule or override", () => {
    for (const kind of ["edge", "auth"] as const) expect(JSON.stringify(webAclSpec(kind))).not.toMatch(/captcha/i);
  });

  it("publish per-rule metrics with sampled requests and keep no full logs", () => {
    for (const kind of ["edge", "auth"] as const) {
      for (const item of webAclSpec(kind).rules) expect(item.VisibilityConfig).toEqual({ SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: `CuadrillaWaf-${kind}-${item.Name}` });
    }
    expect(wafModule).not.toMatch(/LoggingConfiguration|logDestination/);
  });

  it("are created from the spec as ruleJson, the pool's ACL associated with the user pool and the edge ACL handed to the Router", () => {
    expect(wafModule).toContain("ruleJson: JSON.stringify(spec.rules)");
    expect(wafModule).toMatch(/new aws\.wafv2\.WebAclAssociation\("AuthWebAclAssociation", \{\s+resourceArn: userPool\.arn,\s+webAclArn: authWebAcl\.arn,/);
    expect(read("infra/web.ts")).toContain("args.webAclArn = edgeWebAcl.arn;");
    expect(read("infra/web.ts")).toContain("[WEB_ENV_NAMES.wafIntegrationUrl]: wafIntegrationUrl");
    expect(wafModule).toContain("export const wafIntegrationUrl = edgeWebAcl.applicationIntegrationUrl.apply((url) => requireIntegrationUrl(url));");
    expect(wafModule).not.toMatch(/APIKey|ApiKey|captcha/i);
  });
});
