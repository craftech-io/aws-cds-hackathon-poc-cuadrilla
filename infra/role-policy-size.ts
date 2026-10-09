// IAM's size limits on the policies of a role (docs/architecture.md §14), as pure functions over the
// capability table. No SST or Pulumi dependency: infra/role-policy-size.test.ts checks every role.
//
// SST puts every statement of a Function (its `permissions` and the includes of its links) into ONE
// inline policy of its role (.sst/platform/src/components/aws/function.ts `inlinePolicies`). IAM caps
// all inline policies of a role at 10,240 characters and each customer-managed policy at 6,144, both
// counted without whitespace; over either, the deploy fails with `LimitExceeded` and nothing after the
// role ships. So each placeholder resolves here to the LONGEST ARN its component can get:
//
//   tables     SST's physical name `<app>-<stage>-<Name>Table-<8>` (naming.ts physicalName, max 255)
//   functions  64 characters (Lambda's maximum)       queues   80 (SQS's maximum, `.fifo` included)
//   buckets    63 characters (S3's maximum)           models   the app's profile plus every model ARN
//   SES        SEND_EMAIL with MAX_DEMO_RECIPIENTS mailboxes of the longest plausible length
//
// and a role's statements are serialized the way aws.iam.getPolicyDocument writes them (arrays kept,
// one condition block per test). Grants a role keeps in customer-managed policies (`managed` of its
// row, infra/iam-capabilities.ts) are counted per policy, not inline.

import { HARNESS_MODEL_ID, PHOTO_MODEL_ID } from "./agentcore-spec";
import { ACCOUNT_ID, APP, LAMBDA_CAPABILITIES, REGION, SERVICE_ROLES, STAGE, agentModelArns, expectedGrants, isManagedGrant, managedPolicies, whatsappPhoneArn, CAPABILITIES, type Grant, type LambdaName, type RoleName } from "./iam-capabilities";
import { MAX_DEMO_RECIPIENTS, sendEmailGrant } from "./messaging-email-spec";
import { dataAccessGrants } from "./storage-access";
import { parseStorageRef } from "./storage-keys";

/** IAM: all inline policies of one role, whitespace excluded. */
export const INLINE_POLICY_MAX_CHARS = 10_240;
/** IAM: one customer-managed policy, whitespace excluded. */
export const MANAGED_POLICY_MAX_CHARS = 6_144;

const LAMBDA_NAME_MAX = 64;
const SQS_NAME_MAX = 80;
const S3_BUCKET_MAX = 63;
/** A demo recipient as long as a real mailbox plausibly gets (local part, `@`, domain). */
const DEMO_RECIPIENT_LENGTH = 64;

const arnOf = (service: string, resource: string): string => `arn:aws:${service}:${REGION}:${ACCOUNT_ID}:${resource}`;
const filler = (length: number): string => "x".repeat(length);

/** SST's physical name: `<app>-<stage>-<logical>-<8 random>`, cut the way naming.ts `prefixName` cuts it. */
export function sstPhysicalName(max: number, logical: string, app: string = APP, stage: string = STAGE): string {
  const room = max - 9;
  const name = logical.replace(/[^a-zA-Z0-9]/g, "");
  const main =
    name.length + 1 >= room ? name.slice(0, room) : name.length + stage.length + 2 >= room ? `${stage.slice(0, room - name.length - 1)}-${name}` : `${app.slice(0, room - stage.length - name.length - 2)}-${stage}-${name}`;
  return `${main}-${filler(8)}`;
}

const appProfileArn = arnOf("bedrock", `application-inference-profile/${filler(12)}`);
const tableArn = (name: string): string => arnOf("dynamodb", `table/${sstPhysicalName(255, `${name}Table`)}`);

/** Placeholders that are not storage, as the longest ARNs they resolve to at deploy time. */
const OTHER_REFS: Readonly<Record<string, readonly string[]>> = {
  "{Leads}": [tableArn("Leads")],
  "{Network}": [tableArn("Network")],
  "{Dispatch}": [tableArn("Dispatch")],
  "{G1}": [arnOf("bedrock", `guardrail/${filler(12)}`)],
  "{G2}": [arnOf("bedrock", `guardrail/${filler(12)}`)],
  "{G3}": [arnOf("bedrock", `guardrail/${filler(12)}`)],
  "{Memory}": [arnOf("bedrock-agentcore", `memory/${filler(59)}`)],
  "{Harness}": [arnOf("bedrock-agentcore", `runtime/${filler(100)}`)],
  "{Gateway}": [arnOf("bedrock-agentcore", `gateway/${filler(100)}`)],
  "{KnowledgeBase}": [arnOf("bedrock", `knowledge-base/${filler(10)}`)],
  "{model:HARNESS}": agentModelArns(HARNESS_MODEL_ID, REGION, ACCOUNT_ID, appProfileArn),
  "{model:PHOTO}": PHOTO_MODEL_ID === HARNESS_MODEL_ID ? agentModelArns(PHOTO_MODEL_ID, REGION, ACCOUNT_ID, appProfileArn) : agentModelArns(PHOTO_MODEL_ID),
  "{model:PROFILE}": [appProfileArn],
  "{whatsappPhone}": [whatsappPhoneArn(`phone-number-id-${filler(32).replace(/x/g, "0")}`) ?? ""],
  "{UserPool}": [arnOf("cognito-idp", `userpool/${REGION}_${filler(9)}`)],
  "{Auth}": [arnOf("cognito-idp", `userpool/${REGION}_${filler(9)}`)],
  "{EdgeWebAcl}": [arnOf("wafv2", `global/webacl/${filler(LAMBDA_NAME_MAX)}/${filler(36)}`)],
  "{AuthWebAcl}": [arnOf("wafv2", `regional/webacl/${filler(LAMBDA_NAME_MAX)}/${filler(36)}`)],
  "{Feeds}": [arnOf("events", `event-bus/${sstPhysicalName(256, "Feeds")}`)],
};

const QUEUES = new Set(["{InstallerEvents}", "{InstallerEventsDlq}", "{LeadStreamDlq}"]);

/** The longest ARNs (or name) one grant resource stands for; an unknown placeholder throws. */
export function worstCaseResource(resource: string): readonly string[] {
  if (resource === "*" || resource.startsWith("arn:")) return [resource];
  const leads = /^\{(Leads|Network|Dispatch)\}\/(.+)$/.exec(resource);
  if (leads) return [`${tableArn(leads[1] ?? "")}/${leads[2] ?? ""}`];
  const storage = parseStorageRef(resource);
  if (storage?.kind === "table") return [storage.indexes ? `${tableArn(storage.name)}/index/*` : tableArn(storage.name)];
  if (storage?.kind === "bucket-name") return [filler(S3_BUCKET_MAX)];
  if (storage?.kind === "bucket") return [`arn:aws:s3:::${filler(S3_BUCKET_MAX)}${storage.objects === undefined ? "" : `/${storage.objects}`}`];
  const other = OTHER_REFS[resource];
  if (other !== undefined) return other;
  if (QUEUES.has(resource)) return [arnOf("sqs", filler(SQS_NAME_MAX))];
  if (/^\{[A-Z][A-Za-z0-9]*\}$/.test(resource)) return [arnOf("lambda", `function:${filler(LAMBDA_NAME_MAX)}`)];
  throw new Error(`infra/role-policy-size.ts has no worst-case ARN for "${resource}"; add it.`);
}

const resolveValue = (value: string): readonly string[] => (/^\{[^}]+\}/.test(value) ? worstCaseResource(value) : [value]);

const SEND_EMAIL_GRANT = CAPABILITIES.SEND_EMAIL.grants[0];
const WORST_SEND_EMAIL = sendEmailGrant(Array.from({ length: MAX_DEMO_RECIPIENTS }, (_, index) => `${filler(DEMO_RECIPIENT_LENGTH - 12)}${String(index).padStart(2, "0")}@d.example`));

/** One statement as aws.iam.getPolicyDocument renders it, every placeholder at its longest. */
function statementJson(grant: Grant): Record<string, unknown> {
  const source = grant === SEND_EMAIL_GRANT ? WORST_SEND_EMAIL : grant;
  const conditions: Record<string, Record<string, string[]>> = {};
  for (const condition of source.conditions ?? []) conditions[condition.test] = { ...conditions[condition.test], [condition.variable]: condition.values.flatMap(resolveValue) };
  return {
    Effect: "Allow",
    Action: [...source.actions],
    Resource: source.resources.flatMap(worstCaseResource),
    ...(source.conditions === undefined ? {} : { Condition: conditions }),
  };
}

/** Characters IAM counts for a policy document of these grants (whitespace excluded). */
export function policyChars(grants: readonly Grant[]): number {
  return JSON.stringify({ Version: "2012-10-17", Statement: grants.map(statementJson) }).replace(/\s/g, "").length;
}

/** Every statement SST puts in the role's one inline policy: data access, mocks and every grant not kept in a managed policy. */
export function inlineGrants(role: RoleName): Grant[] {
  const data = role in LAMBDA_CAPABILITIES ? dataAccessGrants(role as LambdaName) : { storage: [], mocks: [] };
  return [...data.storage, ...data.mocks, ...expectedGrants(role).filter((grant) => !isManagedGrant(grant))];
}

export interface RolePolicySizes {
  readonly inline: number;
  readonly managed: Readonly<Record<string, number>>;
}

export function rolePolicySizes(role: RoleName): RolePolicySizes {
  const managed = Object.fromEntries(Object.entries(managedPolicies(role)).map(([name, grants]) => [name, policyChars(grants)]));
  return { inline: policyChars(inlineGrants(role)), managed };
}

export const POLICY_ROLES = [...Object.keys(LAMBDA_CAPABILITIES), ...Object.keys(SERVICE_ROLES)] as RoleName[];
