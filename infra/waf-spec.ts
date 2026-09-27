// The two web ACLs of the app as plain data (ADR-0025 §4, docs/architecture.md §1 and §10): the rules
// in the shape of the AWS WAF API (`CreateWebACL`), so infra/waf.ts hands them over as `ruleJson`
// unchanged, infra/waf-spec.test.ts checks them without an AWS account, and the QaDriver's
// `waf.probe` (SC-20/10) compares what `GetWebACL` returns with the same values.
//
//   <app>-<stage>-edge   CLOUDFRONT, us-east-1, on the Router's distribution (`webAclId`)
//     1 AWSManagedRulesAmazonIpReputationList   everything        Block (the group's own actions)
//     2 RateSignupPerIp                         sign-up scope     Block over 10 per IP in 300 s
//     3 AnonymousIpSignup                       sign-up scope     Count: AnonymousIPList inserts
//                                                                  `cuadrilla-anon: 1`, HostingProviderIPList
//                                                                  only counts (corporate VPNs, remote desktops)
//     4 BotControlSignup                        sign-up scope     Count (the whole group): Bot Control at the
//                                                                  TARGETED level, machine learning off. It is
//                                                                  there for the ACL's integration URL: AWS WAF
//                                                                  issues `ApplicationIntegrationURL` (the host
//                                                                  of `challenge.js`) only to an ACL that uses
//                                                                  ACFP, ATP or targeted Bot Control. It only
//                                                                  labels; rule 5 is what demands the token.
//     5 ChallengeSignup                         sign-up scope, POST   Challenge (token immune 300 s)
//     6 RatePerIp                               everything        Block over 1,000 per IP in 300 s
//   <app>-<stage>-auth   REGIONAL, on the Cognito user pool
//     1 AWSManagedRulesAmazonIpReputationList
//     2-4 per-IP rates on `x-amz-target`: SignUp 10, ConfirmSignUp + ResendConfirmationCode +
//       ForgotPassword + ConfirmForgotPassword 20, InitiateAuth + RespondToAuthChallenge 100 (per 300 s);
//       all Block.
//   No rule of the pool's ACL reads the body's user name: Cognito never hands usernames, passwords,
//   emails or phone numbers to AWS WAF (Cognito developer guide, "Things to know about AWS WAF web ACLs
//   and Amazon Cognito"), so a `JsonBody` `/Username` match never sees a value. The `gst-*` user of
//   `SignUp` is enforced by the pre sign-up trigger's ticket (ADR-0025 §3); what an email as the user
//   name of `ConfirmSignUp` or `ResendConfirmationCode` can tell is a declared residual risk, bounded by
//   rule 3 of this ACL and Cognito's own per-user limits (ADR-0025, "Riesgos residuales" (6)).
//
// The sign-up scope is ONE value shared by rules 2 to 4: the URI starts with `/api/` AND its path or
// its query string CONTAINS `signup.`, every comparison after URL_DECODE and LOWERCASE. "Starts with
// /api/signup." is not enough: a tRPC batch (`/api/x,signup.start?batch=1`) or an encoded path
// (`/api/%73ignup.start`) does not start that way and tRPC still runs it. The second layer is the
// app's edge (routers/edge.ts): anything naming a `signup.` procedure outside `POST /api/signup.start`
// without `batch` gets 400.
//
// No rule uses CAPTCHA (a CAPTCHA on the sign-up fetch answers 405 with HTML the page cannot show,
// and the anonymous IP list would lock out prospects behind corporate VPNs). No logging
// configuration: per-rule CloudWatch metrics and sampled requests only, since full logs would keep IPs.
// Header insertion inside a Count override of a managed group is supported by the aws provider
// 7.33.0 (`ruleActionOverrides[].actionToUse.count.customRequestHandling`) and by the API used here.
//
// Cost (ADR-0025 §4): two ACLs (USD 5 each), 10 rules (USD 1 each), the Bot Control subscription
// (USD 10; its per-request fee only on the sign-up scope), requests and Challenge responses at demo
// volume: about USD 30 a month.

const APP = "aws-cds-hackathon-poc-cuadrilla";
const STAGE = "poc";

/** Header the anonymous-IP rule inserts; AWS WAF hands it to the origin with the `x-amzn-waf-` prefix. */
export const ANONYMOUS_IP_HEADER = "cuadrilla-anon";
export const ANONYMOUS_IP_HEADER_AT_ORIGIN = `x-amzn-waf-${ANONYMOUS_IP_HEADER}`;

/** Seconds a solved challenge keeps a token valid for the sign-up. */
export const CHALLENGE_IMMUNITY_SECONDS = 300;
/** Evaluation window of every rate rule. */
export const RATE_WINDOW_SECONDS = 300;

export const WEB_ACL_SCOPES = { edge: "CLOUDFRONT", auth: "REGIONAL" } as const;
export type WebAclKind = keyof typeof WEB_ACL_SCOPES;

/** Fixed names (docs/architecture.md §1): the CI role fences `wafv2` by this prefix. */
export function webAclName(kind: WebAclKind, app: string = APP, stage: string = STAGE): string {
  return `${app}-${stage}-${kind}`;
}

// ---- Statements in the AWS WAF API shape -------------------------------------------------------------

export interface TextTransformation {
  readonly Priority: number;
  readonly Type: "URL_DECODE" | "LOWERCASE" | "NONE";
}

type FieldToMatch =
  | { readonly UriPath: Record<string, never> }
  | { readonly QueryString: Record<string, never> }
  | { readonly Method: Record<string, never> }
  | { readonly SingleHeader: { readonly Name: string } };

export interface ByteMatchStatement {
  readonly ByteMatchStatement: {
    readonly SearchString: string;
    readonly FieldToMatch: FieldToMatch;
    readonly PositionalConstraint: "STARTS_WITH" | "CONTAINS" | "EXACTLY";
    readonly TextTransformations: readonly TextTransformation[];
  };
}

export type WafStatement =
  | ByteMatchStatement
  | { readonly AndStatement: { readonly Statements: readonly WafStatement[] } }
  | { readonly OrStatement: { readonly Statements: readonly WafStatement[] } }
  | { readonly NotStatement: { readonly Statement: WafStatement } };

/** Every comparison of the sign-up scope sees the decoded, lowercased value. */
export const DECODE_AND_LOWERCASE: readonly TextTransformation[] = [
  { Priority: 0, Type: "URL_DECODE" },
  { Priority: 1, Type: "LOWERCASE" },
];

const LOWERCASE_ONLY: readonly TextTransformation[] = [{ Priority: 0, Type: "LOWERCASE" }];

function byteMatch(position: ByteMatchStatement["ByteMatchStatement"]["PositionalConstraint"], search: string, field: FieldToMatch, transformations: readonly TextTransformation[]): ByteMatchStatement {
  return { ByteMatchStatement: { SearchString: search, FieldToMatch: field, PositionalConstraint: position, TextTransformations: transformations } };
}

/** The sign-up scope of rules 2 to 4 of the edge ACL. */
export const SIGNUP_SCOPE_STATEMENTS: readonly WafStatement[] = [
  byteMatch("STARTS_WITH", "/api/", { UriPath: {} }, DECODE_AND_LOWERCASE),
  {
    OrStatement: {
      Statements: [byteMatch("CONTAINS", "signup.", { UriPath: {} }, DECODE_AND_LOWERCASE), byteMatch("CONTAINS", "signup.", { QueryString: {} }, DECODE_AND_LOWERCASE)],
    },
  },
];

export const SIGNUP_SCOPE: WafStatement = { AndStatement: { Statements: SIGNUP_SCOPE_STATEMENTS } };

const POST_ONLY = byteMatch("EXACTLY", "POST", { Method: {} }, [{ Priority: 0, Type: "NONE" }]);

// ---- Rules ---------------------------------------------------------------------------------------

export interface VisibilityConfig {
  readonly SampledRequestsEnabled: true;
  readonly CloudWatchMetricsEnabled: true;
  readonly MetricName: string;
}

/** Per-rule CloudWatch metrics (`AWS/WAFV2`, dimension Rule = `CuadrillaWaf-<acl>-<rule>`) and sampled requests. */
export function visibility(kind: WebAclKind, rule?: string): VisibilityConfig {
  return { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: `CuadrillaWaf-${kind}${rule === undefined ? "" : `-${rule}`}` };
}

type RuleAction = { readonly Block: Record<string, never> } | { readonly Challenge: Record<string, never> };
type OverrideAction = { readonly None: Record<string, never> } | { readonly Count: Record<string, never> };

export interface WafRule {
  readonly Name: string;
  readonly Priority: number;
  readonly Statement: Record<string, unknown>;
  readonly Action?: RuleAction;
  readonly OverrideAction?: OverrideAction;
  readonly ChallengeConfig?: { readonly ImmunityTimeProperty: { readonly ImmunityTime: number } };
  readonly VisibilityConfig: VisibilityConfig;
}

const BLOCK: RuleAction = { Block: {} };

function ipReputation(kind: WebAclKind): WafRule {
  const name = "AWSManagedRulesAmazonIpReputationList";
  return { Name: name, Priority: 1, Statement: { ManagedRuleGroupStatement: { VendorName: "AWS", Name: name } }, OverrideAction: { None: {} }, VisibilityConfig: visibility(kind, name) };
}

function rateRule(kind: WebAclKind, name: string, priority: number, limit: number, scopeDown?: WafStatement): WafRule {
  const statement = { Limit: limit, EvaluationWindowSec: RATE_WINDOW_SECONDS, AggregateKeyType: "IP", ...(scopeDown === undefined ? {} : { ScopeDownStatement: scopeDown }) };
  return { Name: name, Priority: priority, Statement: { RateBasedStatement: statement }, Action: BLOCK, VisibilityConfig: visibility(kind, name) };
}

/**
 * The managed group that gives the edge ACL its integration URL. ACFP, ATP and targeted Bot Control are
 * the only ones that do: ATP inspects sign-ins, not the sign-up, and ACFP reads the password and address
 * fields of the creation request, which never pass through the Bff (the password goes to Cognito).
 */
export const BOT_CONTROL_RULE = "BotControlSignup";

/** Rules of the edge ACL, in priority order. */
export function edgeRules(): WafRule[] {
  return [
    ipReputation("edge"),
    rateRule("edge", "RateSignupPerIp", 2, 10, SIGNUP_SCOPE),
    {
      Name: "AnonymousIpSignup",
      Priority: 3,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: "AWS",
          Name: "AWSManagedRulesAnonymousIpList",
          ScopeDownStatement: SIGNUP_SCOPE,
          RuleActionOverrides: [
            { Name: "AnonymousIPList", ActionToUse: { Count: { CustomRequestHandling: { InsertHeaders: [{ Name: ANONYMOUS_IP_HEADER, Value: "1" }] } } } },
            { Name: "HostingProviderIPList", ActionToUse: { Count: {} } },
          ],
        },
      },
      OverrideAction: { None: {} },
      VisibilityConfig: visibility("edge", "AnonymousIpSignup"),
    },
    {
      Name: BOT_CONTROL_RULE,
      Priority: 4,
      Statement: {
        ManagedRuleGroupStatement: {
          VendorName: "AWS",
          Name: "AWSManagedRulesBotControlRuleSet",
          ScopeDownStatement: SIGNUP_SCOPE,
          ManagedRuleGroupConfigs: [{ AWSManagedRulesBotControlRuleSet: { InspectionLevel: "TARGETED", EnableMachineLearning: false } }],
        },
      },
      OverrideAction: { Count: {} },
      VisibilityConfig: visibility("edge", BOT_CONTROL_RULE),
    },
    {
      Name: "ChallengeSignup",
      Priority: 5,
      Statement: { AndStatement: { Statements: [...SIGNUP_SCOPE_STATEMENTS, POST_ONLY] } },
      Action: { Challenge: {} },
      ChallengeConfig: { ImmunityTimeProperty: { ImmunityTime: CHALLENGE_IMMUNITY_SECONDS } },
      VisibilityConfig: visibility("edge", "ChallengeSignup"),
    },
    rateRule("edge", "RatePerIp", 6, 1000),
  ];
}

/** The Cognito operations each rate rule of the pool's ACL counts, with its limit per IP. */
export const COGNITO_RATE_RULES = [
  { name: "RateSignUp", limit: 10, operations: ["SignUp"] },
  { name: "RateCodesAndRecovery", limit: 20, operations: ["ConfirmSignUp", "ResendConfirmationCode", "ForgotPassword", "ConfirmForgotPassword"] },
  { name: "RateSignIn", limit: 100, operations: ["InitiateAuth", "RespondToAuthChallenge"] },
] as const;

/** `x-amz-target` of a Cognito operation, as the rule compares it (lowercased). */
export function cognitoTarget(operation: string): string {
  return `AWSCognitoIdentityProviderService.${operation}`.toLowerCase();
}

function targetScope(operations: readonly string[]): WafStatement {
  const matches = operations.map((operation) => byteMatch("EXACTLY", cognitoTarget(operation), { SingleHeader: { Name: "x-amz-target" } }, LOWERCASE_ONLY));
  const [only] = matches;
  return matches.length === 1 && only !== undefined ? only : { OrStatement: { Statements: matches } };
}

/** Rules of the pool's ACL, in priority order. */
export function authRules(): WafRule[] {
  return [ipReputation("auth"), ...COGNITO_RATE_RULES.map((rule, index) => rateRule("auth", rule.name, index + 2, rule.limit, targetScope(rule.operations)))];
}

/**
 * The edge ACL's integration URL, or the deploy stops: an ACL that challenges the sign-up without one
 * leaves every browser without a token (ADR-0025 §4). Only an `https` URL passes.
 */
export function requireIntegrationUrl(url: string | undefined | null): string {
  const value = (url ?? "").trim();
  if (!/^https:\/\/[^\s/]+\/\S*$/.test(value)) {
    throw new Error(`The edge web ACL ${webAclName("edge")} has no application integration URL: the sign-up's Challenge could never be solved. It needs targeted Bot Control (rule ${BOT_CONTROL_RULE}).`);
  }
  return value;
}

/** Everything `aws.wafv2.WebAcl` takes for one ACL; `ruleJson` is the API's `Rules`. */
export function webAclSpec(kind: WebAclKind) {
  return {
    name: webAclName(kind),
    scope: WEB_ACL_SCOPES[kind],
    description: kind === "edge" ? "Router of the console: IP reputation, per-IP rates, bot labels and the sign-up challenge." : "Cognito user pool: IP reputation and per-IP rates by operation.",
    defaultAction: { allow: {} },
    rules: kind === "edge" ? edgeRules() : authRules(),
    visibilityConfig: { sampledRequestsEnabled: true, cloudwatchMetricsEnabled: true, metricName: visibility(kind).MetricName },
  };
}
