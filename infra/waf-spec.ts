// AWS WAF of the app as plain data (ADR-0025 §4, ADR-0030, docs/architecture.md §1 and §10).
//
//   demos-borde          CLOUDFRONT, the account's shared edge ACL, on the Router's distribution
//                        (`webAclArn`, infra/web.ts). Created and kept by craftech/demos in the labs
//                        repository, never by this app: infra/web.ts only looks it up by name on every
//                        deploy. Its rules, in order (SHARED_EDGE_RULES): a manual block list, AWS's IP
//                        reputation list, AWS's anonymous IP list in count mode (labels only), sign-up or
//                        password recovery from a hosting provider blocked, 20 requests per IP every 5
//                        minutes on `signup.`/`password.`, 30 on the SMS code's paths (`phone.` here) and
//                        5000 on `/api/`. No logging configuration on this app's side; the shared ACL's
//                        logs belong to craftech/demos.
//   <app>-<stage>-auth   REGIONAL, on the Cognito user pool: this app's own ACL, unchanged.
//     1 AWSManagedRulesAmazonIpReputationList
//     2-5 per-IP rates on `x-amz-target`: SignUp 10, ResendConfirmationCode + ForgotPassword (the two
//       that make Cognito send a code to an inbox) 10, the minimum AWS WAF takes for a rate rule,
//       ConfirmSignUp + ConfirmForgotPassword 20, InitiateAuth + RespondToAuthChallenge 100 (per 300 s);
//       all Block. Spread over many IPs, the codes are also capped per real day for the whole stage by
//       the custom message trigger (`AUTHMAIL#GLOBAL#<day>`, packages/bff/src/auth-triggers/custom-message.ts).
//   No rule of the pool's ACL reads the body's user name: Cognito never hands usernames, passwords,
//   emails or phone numbers to AWS WAF (Cognito developer guide, "Things to know about AWS WAF web ACLs
//   and Amazon Cognito"), so a `JsonBody` `/Username` match never sees a value. The `gst-*` user of
//   `SignUp` is enforced by the pre sign-up trigger's ticket (ADR-0025 §3).
//
// What the app's own edge ACL had and the shared one has not (ADR-0030): the silent Challenge of the
// sign-up and the targeted Bot Control that gave it its integration URL, the `cuadrilla-anon` header
// for anonymous IPs (the Bff's stricter sign-up limit, routers/edge.ts, waits for a shared rule that
// inserts it), 10 sign-ups per IP every 5 minutes (now 20) and 1,000 requests per IP every 5 minutes
// (now 5,000). The app's edge (routers/edge.ts: a `signup.` procedure outside `POST /api/signup.start`
// without `batch` gets 400) and its own limits (signup/limits.ts, phone/limits.ts, ADR-0019) do not
// depend on any of them.
//
// No rule uses CAPTCHA. Per-rule CloudWatch metrics and sampled requests only on the pool's ACL.

const APP = "aws-cds-hackathon-poc-cuadrilla";
const STAGE = "poc";

/**
 * Header an anonymous-IP rule would insert (the Bff's stricter sign-up limit reads it at the origin with
 * AWS WAF's `x-amzn-waf-` prefix). The shared edge ACL does not insert it today (ADR-0030).
 */
export const ANONYMOUS_IP_HEADER = "cuadrilla-anon";
export const ANONYMOUS_IP_HEADER_AT_ORIGIN = `x-amzn-waf-${ANONYMOUS_IP_HEADER}`;

/** The account's shared edge ACL: looked up by name on every deploy (infra/web.ts), never created here. */
export const SHARED_EDGE_WEB_ACL = "demos-borde";

/** Rules of `demos-borde` as craftech/demos declares them (labs, craftech/demos/infra/borde.ts), for the docs and the checks. */
export const SHARED_EDGE_RULES = [
  { name: "BlockList", what: "manual block list (IP sets demos-bloqueados-v4/-v6)" },
  { name: "IpReputation", what: "AWSManagedRulesAmazonIpReputationList" },
  { name: "AnonymousIp", what: "AWSManagedRulesAnonymousIpList, count only (labels)" },
  { name: "HostingSignup", what: "sign-up or password recovery from a hosting provider: Block" },
  { name: "SignupRate", what: "20 per IP every 5 minutes on signup. and password." },
  { name: "SmsCodeRate", what: "30 per IP every 5 minutes on telefono., phone., cuenta.enviarCodigo, cuenta.verificarCodigo" },
  { name: "ApiRate", what: "5000 per IP every 5 minutes on /api/" },
] as const;

/** This app's SMS code procedures: all under `phone.`, one of the paths of the shared SmsCodeRate rule. */
export const SMS_CODE_PROCEDURES = ["phone.status", "phone.sendCode", "phone.verifyCode", "phone.carrySession", "phone.endSession"] as const;
export const SHARED_SMS_CODE_PATH = "phone.";
/** Evaluation window of every rate rule. */
export const RATE_WINDOW_SECONDS = 300;

export const WEB_ACL_SCOPES = { auth: "REGIONAL" } as const;
export type WebAclKind = keyof typeof WEB_ACL_SCOPES;

/** Fixed names (docs/architecture.md §1): the CI role fences `wafv2` by this prefix. */
export function webAclName(kind: WebAclKind, app: string = APP, stage: string = STAGE): string {
  return `${app}-${stage}-${kind}`;
}

// ---- Statements in the AWS WAF API shape -------------------------------------------------------------

export interface TextTransformation {
  readonly Priority: number;
  readonly Type: "LOWERCASE";
}

type FieldToMatch = { readonly SingleHeader: { readonly Name: string } };

export interface ByteMatchStatement {
  readonly ByteMatchStatement: {
    readonly SearchString: string;
    readonly FieldToMatch: FieldToMatch;
    readonly PositionalConstraint: "EXACTLY";
    readonly TextTransformations: readonly TextTransformation[];
  };
}

export type WafStatement = ByteMatchStatement | { readonly OrStatement: { readonly Statements: readonly WafStatement[] } };

const LOWERCASE_ONLY: readonly TextTransformation[] = [{ Priority: 0, Type: "LOWERCASE" }];

function byteMatch(position: ByteMatchStatement["ByteMatchStatement"]["PositionalConstraint"], search: string, field: FieldToMatch, transformations: readonly TextTransformation[]): ByteMatchStatement {
  return { ByteMatchStatement: { SearchString: search, FieldToMatch: field, PositionalConstraint: position, TextTransformations: transformations } };
}

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

type RuleAction = { readonly Block: Record<string, never> };
type OverrideAction = { readonly None: Record<string, never> } | { readonly Count: Record<string, never> };

export interface WafRule {
  readonly Name: string;
  readonly Priority: number;
  readonly Statement: Record<string, unknown>;
  readonly Action?: RuleAction;
  readonly OverrideAction?: OverrideAction;
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

/** The Cognito operations each rate rule of the pool's ACL counts, with its limit per IP. */
export const COGNITO_RATE_RULES = [
  { name: "RateSignUp", limit: 10, operations: ["SignUp"] },
  { name: "RateCodeEmails", limit: 10, operations: ["ResendConfirmationCode", "ForgotPassword"] },
  { name: "RateCodeChecks", limit: 20, operations: ["ConfirmSignUp", "ConfirmForgotPassword"] },
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

/** Everything `aws.wafv2.WebAcl` takes for one ACL; `ruleJson` is the API's `Rules`. */
export function webAclSpec(kind: WebAclKind) {
  return {
    name: webAclName(kind),
    scope: WEB_ACL_SCOPES[kind],
    description: "Cognito user pool: IP reputation and per-IP rates by operation.",
    defaultAction: { allow: {} },
    rules: authRules(),
    visibilityConfig: { sampledRequestsEnabled: true, cloudwatchMetricsEnabled: true, metricName: visibility(kind).MetricName },
  };
}
