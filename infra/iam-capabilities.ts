// Least-privilege capabilities per role (docs/architecture.md §14), as plain data. No SST or Pulumi
// dependency: every infra module that creates a Function or a service role builds its `link` and its
// `sst.aws.permission` statements from the entry of that role here, and iam-capabilities.test.ts
// compares them with what the modules generate (a permission not in this file is drift). The rows of
// the sign-up, the guest worlds and the leads (infra/leads-spec.ts) and the QaDriver's fenced writes
// (infra/qa-driver-fence.ts) are merged here.
//
// Tables and buckets are data access (`read`, `append`, `write`): the `link` only hands the Lambda
// their names (sst.config.ts strips SST's `dynamodb:*` / `s3:*`; infra/storage-access.ts turns each
// level into its exact actions). Everything else is a `Grant`: actions, resources and the conditions
// that fence them. Resources are ARNs or references to a component the module resolves at deploy time:
//
//   {Media}/transcripts/*   an object prefix of a bucket     {G1} … {G4}     a guardrail
//   {Memory} {Gateway}      AgentCore of the stage            {KnowledgeBase} the manual's KB
//   {NetworkMock} …         a Lambda                          {Leads} {UserPool} the leads and the pool
//   {model:HARNESS}         agentModelArns(HARNESS_MODEL_ID, …, the app's inference profile)
//   {model:PHOTO}           agentModelArns(PHOTO_MODEL_ID, …, the profile while PHOTO_MODEL_ID is HARNESS_MODEL_ID)
//   {model:PROFILE}         the app's inference profile (ADR-0028), for bedrock:GetInferenceProfile
//   {whatsappPhone}         whatsappPhoneArn(WhatsAppPhoneNumberId); omitted while `not-connected` (P-01)
//
// `Resource: "*"` appears only where IAM offers nothing else, each with its justification and a
// condition (JUSTIFIED_WILDCARDS). No grant carries an SES receipt-rule action (the only active rule
// set of the account belongs to another app, ADR-0003) nor any WABA association or
// `PutWhatsAppBusinessAccountEventDestinations` (the operator applies the event destination).
import { BFF_LEADS_GRANT, GUEST_WORLDS_LEADING_KEYS, QA_SEAM_GRANTS, SIGNUP_CAPABILITIES, SIGNUP_ROLES, type SignupCapability } from "./leads-spec";
import { qaDriverManagedPolicies } from "./qa-driver-fence";

import { REGION, ACCOUNT_ID, APP, STAGE, APP_DOMAIN, TRANSCRIBE_PREFIX, SCHEDULE_GROUP, EMAIL_CONFIGURATION_SET, METRICS_NAMESPACE, SENDERS, foundationModelOf, agentModelArns, whatsappPhoneArn } from "./iam-arns";

export { REGION, ACCOUNT_ID, APP, STAGE, APP_DOMAIN, TRANSCRIBE_PREFIX, SCHEDULE_GROUP, EMAIL_CONFIGURATION_SET, METRICS_NAMESPACE, SENDERS, foundationModelOf, agentModelArns, whatsappPhoneArn };

const arn = {
  schedules: `arn:aws:scheduler:${REGION}:${ACCOUNT_ID}:schedule/${SCHEDULE_GROUP}/*`,
  schedulerRole: `arn:aws:iam::${ACCOUNT_ID}:role/${APP}/*SchedulerInvocation*`,
  sesIdentity: `arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${APP_DOMAIN}`,
  sesConfigurationSet: `arn:aws:ses:${REGION}:${ACCOUNT_ID}:configuration-set/${EMAIL_CONFIGURATION_SET}`,
  transcriptionJobs: `arn:aws:transcribe:${REGION}:${ACCOUNT_ID}:transcription-job/${TRANSCRIBE_PREFIX}*`,
  dlqAlarm: `arn:aws:cloudwatch:${REGION}:${ACCOUNT_ID}:alarm:${APP}-${STAGE}-InstallerEventsDlq*`,
  qaDriver: `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${APP}-${STAGE}-qa-driver`,
  waTopic: `arn:aws:sns:${REGION}:${ACCOUNT_ID}:${APP}-wa-inbound`,
} as const;

// ---- Types ---------------------------------------------------------------------------------------

export type TableName = "Isps" | "People" | "WorkOrders" | "Cases" | "Conversations" | "AuditLog" | "Reference" | "Runtime" | "CuadrillaMetrics" | "Network" | "Dispatch";

export type BucketName = "Media" | "Evidence" | "Manual" | "Seed";
/** `read`: get and query; `append`: PutItem only (append-only logs); `write`: read plus every item write. */
export type Access = "read" | "append" | "write";

export interface Condition {
  readonly test: "StringEquals" | "StringLike" | "StringEqualsIfExists" | "ForAllValues:StringLike" | "ForAllValues:StringEquals" | "ArnLike";
  readonly variable: string;
  readonly values: readonly string[];
}

export interface Grant {
  readonly sid?: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly conditions?: readonly Condition[];
}

export type CapabilityName = "TIMERS" | "SEND_EMAIL" | "SEND_WHATSAPP" | "PIPELINE" | "MOCK_NETWORK" | "MOCK_DISPATCH" | "TRANSCRIBE" | "MEMORY_ADMIN" | "WORLDS" | "WORLD_DATA" | SignupCapability;

export interface Capability {
  readonly grants: readonly Grant[];
  /** Other capabilities this one includes. */
  readonly includes?: readonly CapabilityName[];
  readonly tables?: Readonly<Partial<Record<TableName, Access>>>;
  readonly buckets?: Readonly<Partial<Record<BucketName, Access>>>;
}

const invokeMock = (mock: "NetworkMock" | "DispatchMock"): Grant[] => [
  { actions: ["lambda:InvokeFunctionUrl"], resources: [`{${mock}}`], conditions: [{ test: "StringEquals", variable: "lambda:FunctionUrlAuthType", values: ["AWS_IAM"] }] },
  { actions: ["lambda:InvokeFunction"], resources: [`{${mock}}`] },
];

const APP_TABLES = ["Isps", "People", "WorkOrders", "Cases", "Conversations", "AuditLog", "Runtime", "CuadrillaMetrics"] as const;
const allAt = <T extends string>(names: readonly T[], access: Access): Partial<Record<T, Access>> => Object.fromEntries(names.map((name) => [name, access])) as Partial<Record<T, Access>>;

export const CAPABILITIES: Readonly<Record<CapabilityName, Capability>> = {
  TIMERS: {
    grants: [
      { actions: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule"], resources: [arn.schedules] },
      { actions: ["iam:PassRole"], resources: [arn.schedulerRole], conditions: [{ test: "StringEquals", variable: "iam:PassedToService", values: ["scheduler.amazonaws.com"] }] },
    ],
  },
  SEND_EMAIL: {
    grants: [
      {
        actions: ["ses:SendEmail"],
        resources: [arn.sesIdentity, arn.sesConfigurationSet],
        conditions: [
          { test: "StringEquals", variable: "ses:FromAddress", values: SENDERS },
          // Plus the demoRecipients of SeedOverrides, read at deploy time by infra/messaging-email.ts.
          { test: "ForAllValues:StringLike", variable: "ses:Recipients", values: ["*@simulator.amazonses.com"] },
        ],
      },
    ],
  },
  SEND_WHATSAPP: {
    grants: [
      { actions: ["social-messaging:SendWhatsAppMessage", "social-messaging:PostWhatsAppMessageMedia"], resources: ["{whatsappPhone}"] },
      // PostWhatsAppMessageMedia reads the object with the caller's own credentials.
      { actions: ["s3:GetObject"], resources: ["{Evidence}/certificates/*", "{Evidence}/photos/*"] },
    ],
  },
  PIPELINE: {
    grants: [{ actions: ["bedrock:ApplyGuardrail"], resources: ["{G2}", "{G3}"] }],
    includes: ["SEND_EMAIL", "SEND_WHATSAPP", "TIMERS"],
    // What every send writes: the message and outbox (Conversations), caps and PENDING# (Runtime), the policy audit.
    tables: { Conversations: "write", Runtime: "write", AuditLog: "write", Isps: "read" },
  },
  MOCK_NETWORK: { grants: invokeMock("NetworkMock") },
  MOCK_DISPATCH: { grants: invokeMock("DispatchMock") },
  TRANSCRIBE: {
    grants: [
      {
        sid: "NoResourceLevelTranscription",
        actions: ["transcribe:StartTranscriptionJob"],
        resources: ["*"],
        conditions: [
          { test: "StringEquals", variable: "transcribe:OutputBucketName", values: ["{Media.name}"] },
          { test: "StringLike", variable: "transcribe:OutputKey", values: ["transcripts/*"] },
        ],
      },
      { sid: "TranscriptionJobsOfThisApp", actions: ["transcribe:GetTranscriptionJob", "transcribe:DeleteTranscriptionJob"], resources: [arn.transcriptionJobs] },
      // StartTranscriptionJob with `Tags` (infra/media.ts `jobTags`) also authorizes TagResource on the job.
      { sid: "TagTranscriptionJobsOfThisApp", actions: ["transcribe:TagResource"], resources: [arn.transcriptionJobs], conditions: [{ test: "StringEquals", variable: "aws:RequestTag/Project", values: [APP] }, { test: "ForAllValues:StringEquals", variable: "aws:TagKeys", values: ["Project"] }] },
      { actions: ["s3:GetObject", "s3:DeleteObject"], resources: ["{Media}/wa/*", "{Media}/sim/*", "{Media}/guest/*/sim/*"] },
      { actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], resources: ["{Media}/transcripts/*"] },
    ],
  },
  MEMORY_ADMIN: {
    grants: [
      {
        // ListSessions: the purge also reaches the sessions it cannot compute (worlds/memory-admin.ts).
        actions: ["bedrock-agentcore:ListSessions", "bedrock-agentcore:ListEvents", "bedrock-agentcore:DeleteEvent", "bedrock-agentcore:ListMemoryRecords", "bedrock-agentcore:DeleteMemoryRecord", "bedrock-agentcore:RetrieveMemoryRecords"],
        resources: ["{Memory}"],
      },
    ],
  },
  WORLDS: {
    grants: [
      { actions: ["s3:GetObject"], resources: ["{Seed}/*"] },
      { actions: ["s3:PutObject"], resources: ["{Media}/sim/*"] },
    ],
    includes: ["TIMERS", "MEMORY_ADMIN"],
    tables: { Reference: "read", Network: "write", Dispatch: "write" }, // the mocks', fenced by WORLDS_LEADING_KEYS
  },
  // Unfenced writes of every app table: never the QaDriver's (infra/qa-driver-fence.ts fences its writes by key).
  WORLD_DATA: { grants: [], tables: allAt(APP_TABLES, "write") },
  // LEADS_READ, LEADS_WRITE, SEND_LEAD_NOTIFY: `Leads` is never part of WORLDS (ADR-0026).
  ...SIGNUP_CAPABILITIES,
};

/** `dynamodb:LeadingKeys` of `Network` and `Dispatch` per role that holds `WORLDS` (docs/architecture.md §14). */
export const WORLDS_LEADING_KEYS = {
  Bff: ["ONU#GLOBAL#isp-demo#*", "ONU#GUEST#isp-guest-*", "DWO#isp-demo#*", "DWO#isp-guest-*"],
  WorldJanitor: ["ONU#GUEST#isp-guest-*", "DWO#isp-guest-*"],
  QaDriver: ["ONU#qa-*", "ONU#eval-*", "ONU#GUEST#isp-guest-test#*", "DWO#isp-qa-*", "DWO#isp-eval-*", "DWO#isp-guest-test#*"],
  GuestWorlds: GUEST_WORLDS_LEADING_KEYS,
  GuestAccountDeletion: GUEST_WORLDS_LEADING_KEYS,
} as const;

export type WorldsRole = keyof typeof WORLDS_LEADING_KEYS;

// ---- Roles --------------------------------------------------------------------------------------

export interface RoleCapabilities {
  readonly capabilities: readonly CapabilityName[];
  readonly tables?: Readonly<Partial<Record<TableName, Access>>>;
  readonly buckets?: Readonly<Partial<Record<BucketName, Access>>>;
  /** Grants beyond the capabilities and the linked data. */
  readonly grants?: readonly Grant[];
  /** Grants kept out of the role's one inline policy, in customer-managed policies by logical name (infra/role-policy-size.ts). */
  readonly managed?: Readonly<Record<string, readonly Grant[]>>;
}

const g = (actions: readonly string[], resources: readonly string[], conditions?: readonly Condition[]): Grant => (conditions ? { actions, resources, conditions } : { actions, resources });
const sqsSend = (queue = "{InstallerEvents}"): Grant => g(["sqs:SendMessage"], [queue]);
const guardrailG1 = g(["bedrock:ApplyGuardrail"], ["{G1}"]);
const invokeModels = (model: "HARNESS" | "PHOTO", actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]): Grant => g(actions, [`{model:${model}}`]);
/** AgentCore and Bedrock resolve the app's inference profile before they call through it (ADR-0028). */
const readModelProfile: Grant = { sid: "ModelProfileRead", ...g(["bedrock:GetInferenceProfile"], ["{model:PROFILE}"]) };
/** The historical certificates' PDFs a world factory renders (worlds/certificates.ts), of every world. */
const WORLD_CERTIFICATES = g(["s3:PutObject"], ["{Evidence}/certificates/*", "{Evidence}/guest/*/certificates/*"]);
/** The seeded evidence of the `checklist` preset (worlds/presets-checklist.ts): the seed's photo copied to its key. */
const WORLD_EVIDENCE_PHOTOS = g(["s3:PutObject"], ["{Evidence}/photos/*", "{Evidence}/guest/*/photos/*"]);
const metrics = g(["cloudwatch:PutMetricData"], ["*"], [{ test: "StringEquals", variable: "cloudwatch:namespace", values: [METRICS_NAMESPACE] }]);

export const LAMBDA_CAPABILITIES = {
  InstallerWorker: {
    capabilities: ["PIPELINE", "TRANSCRIBE", "MOCK_NETWORK"],
    tables: { WorkOrders: "write", People: "write", Cases: "write", Conversations: "write", Runtime: "write", AuditLog: "write", Isps: "read", Reference: "read", CuadrillaMetrics: "write" },
    // CertificateWriter: close_installation of a "Cerrar instalación" tap (BUTTON_ACTION) runs in process here.
    grants: [g(["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"], ["{Harness}"]), guardrailG1, sqsSend(), g(["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"], ["{InstallerEvents}"]), g(["lambda:InvokeFunction"], ["{CertificateWriter}"])],
  },
  ToolOrders: {
    capabilities: ["MOCK_NETWORK", "PIPELINE"],
    tables: { WorkOrders: "write", People: "write", Isps: "read", Cases: "write", Runtime: "write", AuditLog: "write", Reference: "read" },
  },
  ToolKnowledge: {
    capabilities: [],
    // WorkOrders, People, Cases and Isps: the wrapper's LAM-SCOPE (session day, a caller's subject).
    tables: { Reference: "read", Runtime: "write", AuditLog: "write", WorkOrders: "read", People: "read", Cases: "read", Isps: "read" },
    grants: [g(["bedrock:Retrieve"], ["{KnowledgeBase}"])],
  },
  ToolEvidence: {
    capabilities: ["MOCK_NETWORK", "PIPELINE"],
    tables: { WorkOrders: "write", Reference: "read", Runtime: "write", AuditLog: "write", People: "write", Cases: "write", Isps: "read" },
    buckets: { Media: "read" },
    // `Converse` is authorized by bedrock:InvokeModel; PIPELINE for the VERDICT_REACTION (FL-103) and the case's ladder.
    grants: [invokeModels("PHOTO", ["bedrock:InvokeModel"]), readModelProfile, g(["s3:PutObject"], ["{Evidence}/photos/*", "{Evidence}/guest/*/photos/*"])],
  },
  ToolMessaging: {
    capabilities: ["PIPELINE"],
    tables: { WorkOrders: "write", People: "write", Cases: "write", Conversations: "write", Runtime: "write", AuditLog: "write", Reference: "read", Isps: "read" },
  },
  ToolCases: {
    capabilities: ["PIPELINE", "MOCK_NETWORK"],
    tables: { WorkOrders: "write", Cases: "write", People: "write", Isps: "read", Conversations: "write", Runtime: "write", AuditLog: "write", Reference: "read" },
    grants: [g(["lambda:InvokeFunction"], ["{CertificateWriter}"])],
  },
  CertificateWriter: {
    capabilities: [],
    tables: { WorkOrders: "write", People: "read", Isps: "read" },
    grants: [g(["s3:GetObject"], ["{Evidence}/photos/*", "{Evidence}/guest/*/photos/*"]), g(["s3:PutObject"], ["{Evidence}/certificates/*", "{Evidence}/guest/*/certificates/*"]), g(["bedrock:ApplyGuardrail"], ["{G3}"])],
  },
  // PIPELINE: its fixed replies and the window fallback go through the outbound pipeline (Reference: the templates).
  InboundWhatsApp: {
    capabilities: ["PIPELINE"],
    tables: { People: "write", Runtime: "write", Conversations: "write", WorkOrders: "write", Cases: "write", AuditLog: "write", Isps: "read", Reference: "read" },
    buckets: { Media: "write" },
    grants: [g(["social-messaging:GetWhatsAppMessageMedia"], ["{whatsappPhone}"]), sqsSend(), metrics],
  },
  ChannelEvents: { capabilities: [], tables: { Conversations: "write", WorkOrders: "write", Runtime: "write" }, grants: [sqsSend()] },
  FeedEvents: { capabilities: [], tables: { WorkOrders: "write", Runtime: "write", AuditLog: "write" }, grants: [sqsSend()] },
  ScheduleDispatch: { capabilities: [], tables: { WorkOrders: "read", Cases: "read", People: "read", Runtime: "write" }, grants: [sqsSend()] },
  // Leads: only `signup.start`'s writes, fenced by key and attributes; retryWorld and deleteGuest invoke.
  // Manual: `manual.section`. Evidence photos: the seeded evidence of a scene (worlds/presets-checklist.ts);
  // the historical certificates' PDFs and the Memory purge go to WorldJanitor (worlds/stage.ts).
  Bff: {
    capabilities: ["MOCK_NETWORK", "MOCK_DISPATCH", "WORLDS"],
    tables: { ...allAt(APP_TABLES, "write"), Reference: "read" },
    buckets: { Evidence: "read", Media: "write", Manual: "read" },
    grants: [g(["s3:GetObject"], ["{Seed}/brand/*"]), WORLD_EVIDENCE_PHOTOS, sqsSend(), g(["lambda:InvokeFunction"], ["{InboundWhatsApp}", "{WorldJanitor}", "{GuestWorlds}", "{GuestAccountDeletion}"]), BFF_LEADS_GRANT],
  },
  CostGuard: {
    capabilities: [],
    tables: { AuditLog: "write" },
    grants: [g(["dynamodb:PutItem"], ["{Runtime}"], [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: ["KILL#*"] }])],
  },
  // The historical certificates of the guest worlds it resets at night and of every world the Bff reloads
  // (`RENDER_CERTIFICATES`: guest and demo).
  WorldJanitor: { capabilities: ["WORLDS", "WORLD_DATA"], grants: [WORLD_CERTIFICATES] },
  // Runtime: the phone leases of messages sent by the live transport (policy/records.ts).
  PolicyAudit: {
    capabilities: [],
    tables: { Conversations: "read", AuditLog: "write", WorkOrders: "read", Cases: "read", People: "read", Isps: "read", Reference: "read", Runtime: "read" },
    grants: [g(["s3:GetObject"], ["{Evidence}/certificates/*", "{Evidence}/guest/*/certificates/*"])],
  },
  // Cognito pre token generation: the user row by GSI1 `SUB#<sub>` and one audit row per ignored attribute.
  AuthPreToken: { capabilities: [], tables: { Isps: "read", AuditLog: "append" } },
  NetworkMock: { capabilities: [], tables: { Network: "write" } },
  DispatchMock: { capabilities: [], tables: { Dispatch: "write" }, grants: [g(["events:PutEvents"], ["{Feeds}"])] },
  QaDriver: {
    capabilities: ["MOCK_NETWORK", "MOCK_DISPATCH", "WORLDS", "LEADS_READ"],
    // Reads every app table; writes only by key and objects only by prefix (infra/qa-driver-fence.ts).
    tables: { ...allAt(APP_TABLES, "read"), Reference: "read" },
    grants: [
      g(["cognito-idp:DescribeUserPoolClient"], ["{Auth}"]),
      ...QA_SEAM_GRANTS,
      g(["s3:GetObject"], ["{Seed}/brand/*"]),
      sqsSend(),
      // `{Bff}`: the QA seam's `signup.start` (routers/qa-seam.ts); the lead and the run's counters are the Bff's writes.
      g(["lambda:InvokeFunction"], ["{InboundWhatsApp}", "{WorldJanitor}", "{PolicyAudit}", "{Bff}", "{ToolOrders}", "{ToolKnowledge}", "{ToolEvidence}", "{ToolMessaging}", "{ToolCases}"]),
      g(["sns:Publish"], [arn.waTopic]),
      guardrailG1,
      g(["sqs:ReceiveMessage", "sqs:DeleteMessage"], ["{InstallerEventsDlq}"]),
      g(["cloudwatch:DescribeAlarmHistory"], [arn.dlqAlarm]),
      g(["scheduler:DeleteSchedule"], [`arn:aws:scheduler:${REGION}:${ACCOUNT_ID}:schedule/${SCHEDULE_GROUP}/tm-q-*`, `arn:aws:scheduler:${REGION}:${ACCOUNT_ID}:schedule/${SCHEDULE_GROUP}/tm-e-*`]),
    ],
    // Its fenced writes: too big for the inline policy (IAM's 10,240 characters), so two managed policies.
    managed: qaDriverManagedPolicies(),
  },
  ...SIGNUP_ROLES,
} as const satisfies Record<string, RoleCapabilities>;

export type LambdaName = keyof typeof LAMBDA_CAPABILITIES;

/**
 * What the Harness does on its Memory. The Strands session manager under it lists and appends the
 * conversation's events and, after a guardrail blocks a model input, replaces the stored user message
 * with the redacted one: a new event, then `DeleteEvent` on the old one (without it the turn fails with
 * "Failed to update message: could not delete old event").
 */
export const HARNESS_MEMORY_ACTIONS = ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:GetEvent", "bedrock-agentcore:ListEvents", "bedrock-agentcore:DeleteEvent", "bedrock-agentcore:RetrieveMemoryRecords"] as const;

/** Execution roles of AgentCore (infra/agentcore-iam.ts), with the same shape as a Lambda's. */
export const SERVICE_ROLES = {
  Harness: {
    capabilities: [],
    grants: [
      invokeModels("HARNESS"),
      readModelProfile,
      g(["bedrock:ApplyGuardrail"], ["{G4}"]),
      g(["bedrock-agentcore:InvokeGateway"], ["{Gateway}"]),
      g(HARNESS_MEMORY_ACTIONS, ["{Memory}"]),
    ],
  },
  // Runs the extraction model of the three Memory strategies with override (sid of the scaffolding).
  Memory: { capabilities: [], grants: [{ sid: "ExtractionModel", ...invokeModels("HARNESS") }, readModelProfile] },
  Gateway: { capabilities: [], grants: [g(["lambda:InvokeFunction"], ["{ToolOrders}", "{ToolKnowledge}", "{ToolEvidence}", "{ToolMessaging}", "{ToolCases}"])] },
  SchedulerInvocation: { capabilities: [], grants: [g(["lambda:InvokeFunction"], ["{ScheduleDispatch}"])] },
} as const satisfies Record<string, RoleCapabilities>;

export type ServiceRoleName = keyof typeof SERVICE_ROLES;
export type RoleName = LambdaName | ServiceRoleName;

/** The only actions granted on `Resource: "*"`, each with the condition variables that must fence it. */
export const JUSTIFIED_WILDCARDS: Readonly<Record<string, readonly string[]>> = {
  // No resource type in the Service Authorization Reference: fenced by the output bucket and key.
  "transcribe:StartTranscriptionJob": ["transcribe:OutputBucketName", "transcribe:OutputKey"],
  // Metrics have no ARN: fenced by the namespace of the app.
  "cloudwatch:PutMetricData": ["cloudwatch:namespace"],
};

/** SQS actions of the QaDriver that only the DLQ may receive (`dlq.find`, `dlq.delete`). */
export const QA_DRIVER_DLQ_ONLY_ACTIONS = ["sqs:ReceiveMessage", "sqs:DeleteMessage"] as const;

const roleEntry = (role: RoleName): RoleCapabilities => (role in LAMBDA_CAPABILITIES ? LAMBDA_CAPABILITIES[role as LambdaName] : SERVICE_ROLES[role as ServiceRoleName]);

/** Every capability a role holds, with the ones they include, without duplicates. */
export function resolveCapabilities(names: readonly CapabilityName[]): CapabilityName[] {
  const seen = new Set<CapabilityName>();
  const visit = (name: CapabilityName): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const included of CAPABILITIES[name].includes ?? []) visit(included);
  };
  for (const name of names) visit(name);
  return [...seen].sort();
}

/** Every grant a role must receive, inline or managed (data access goes by `link`). */
export function expectedGrants(role: RoleName): Grant[] {
  const entry = roleEntry(role);
  return [...(entry.grants ?? []), ...Object.values(entry.managed ?? {}).flat(), ...resolveCapabilities(entry.capabilities).flatMap((name) => CAPABILITIES[name].grants)];
}

/** The customer-managed policies of a role, by logical name: their grants never go inline. */
export function managedPolicies(role: RoleName): Readonly<Record<string, readonly Grant[]>> {
  return roleEntry(role).managed ?? {};
}

const MANAGED_GRANTS = new Set<Grant>([...Object.values(LAMBDA_CAPABILITIES), ...Object.values(SERVICE_ROLES)].flatMap((entry: RoleCapabilities) => Object.values(entry.managed ?? {}).flat()));

export const isManagedGrant = (grant: Grant): boolean => MANAGED_GRANTS.has(grant);

export const expectedActions = (role: RoleName): string[] => [...new Set(expectedGrants(role).flatMap((grant) => grant.actions))].sort();

/**
 * Tables (or buckets) a role reaches, capabilities included. `write` wins; `read` and `append` of the
 * same resource from two sources is an error, never silently widened (declare it `write`).
 */
export function expectedData<K extends "tables" | "buckets">(role: RoleName, kind: K): NonNullable<RoleCapabilities[K]> {
  const entry = roleEntry(role);
  const merged: Record<string, Access> = {};
  for (const data of [entry[kind], ...resolveCapabilities(entry.capabilities).map((name) => CAPABILITIES[name][kind])]) {
    for (const [name, access] of Object.entries(data ?? {}) as Array<[string, Access]>) {
      const current = merged[name];
      if (current !== undefined && current !== access && current !== "write" && access !== "write") throw new Error(`${role}: ${name} is both ${current} and ${access}; declare it write.`);
      if (current !== "write") merged[name] = access;
    }
  }
  return merged as NonNullable<RoleCapabilities[K]>;
}

export const expectedTables = (role: RoleName): Partial<Record<TableName, Access>> => expectedData(role, "tables");

/** Actions a module generated that the capabilities do not allow, and allowed ones it did not generate. */
export function actionDrift(role: RoleName, generated: readonly string[]): { extra: string[]; missing: string[] } {
  const expected = new Set(expectedActions(role));
  const actual = new Set(generated);
  return { extra: [...actual].filter((action) => !expected.has(action)).sort(), missing: [...expected].filter((action) => !actual.has(action)).sort() };
}

export const IAM_ARNS = arn;
