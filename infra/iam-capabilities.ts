// Least-privilege capabilities per role (docs/architecture.md §14), as plain data. No SST or Pulumi
// dependency: every infra module that creates a Function or a service role builds its `link` and its
// `sst.aws.permission` statements from the entry of that role here, and
// infra/iam-capabilities.test.ts derives the expected statements and compares them with what the
// modules generate. A permission that is not in this file is drift, and the test fails.
//
// Tables and buckets are listed as data access (`read`, `append`, `write`). The `link` only hands the
// Lambda their names: sst.config.ts strips the `dynamodb:*` / `s3:*` SST would attach to a linked
// Dynamo or Bucket, and infra/storage-access.ts turns each access level into its exact actions.
// Everything else is a `Grant`: actions, the resources they reach and the conditions that fence them.
// Resources are ARNs or references to a component of the app that the module resolves at deploy time:
//
//   {Media}/transcripts/*   an object prefix of a bucket     {G1} {G2} {G3}  a guardrail
//   {Memory}                the AgentCore Memory of the stage {KnowledgeBase} the manual's KB
//   {Gateway}               the AgentCore Gateway             {NetworkMock} {DispatchMock} … a Lambda
//   {model:HARNESS}         agentModelArns(HARNESS_MODEL_ID)  {model:PHOTO}  agentModelArns(PHOTO_MODEL_ID)
//   {whatsappPhone}         whatsappPhoneArn(WhatsAppPhoneNumberId); the statement is omitted while
//                           the secret is `not-connected` (docs/pending.md P-01)
//
// `Resource: "*"` appears only where IAM offers nothing else, each with its justification and a
// condition (JUSTIFIED_WILDCARDS). No grant carries an SES receipt-rule action (the only active rule
// set of the account belongs to another app, ADR-0003) nor any WABA association or
// `PutWhatsAppBusinessAccountEventDestinations` (the operator applies the event destination).

export const REGION = "us-east-1";
export const ACCOUNT_ID = "776805327629";
export const APP = "aws-cds-hackathon-poc-cuadrilla";
export const STAGE = "poc";
export const APP_DOMAIN = "cuadrilla.demo.craftech.io";

/** Prefix of Transcribe jobs and of the vocabulary: short, unique in the account (docs/architecture.md §1). */
export const TRANSCRIBE_PREFIX = "cuadrilla-poc-";
export const SCHEDULE_GROUP = `${APP}-${STAGE}-schedules`;
export const EMAIL_CONFIGURATION_SET = `${APP}-email-${STAGE}`;
export const METRICS_NAMESPACE = "CuadrillaAgent";
export const SENDERS = [`actas@${APP_DOMAIN}`, `avisos@${APP_DOMAIN}`] as const;

// ---- ARN helpers ---------------------------------------------------------------------------------

/** Base foundation model of a model id (`global.anthropic.claude-opus-5` → `anthropic.claude-opus-5`). */
export function foundationModelOf(modelId: string): string {
  return modelId.replace(/^(global|us|eu|apac)\./, "");
}

/**
 * Everything `bedrock:InvokeModel` must name to call a model through a global inference profile: the
 * profile in this region, plus its foundation model region-less (global routing) and in every
 * region the profile may route to. A profile alone gives AccessDenied; nothing else is named.
 */
export function agentModelArns(modelId: string, region: string = REGION, account: string = ACCOUNT_ID): string[] {
  const foundation = foundationModelOf(modelId);
  const models = [`arn:aws:bedrock:::foundation-model/${foundation}`, `arn:aws:bedrock:*::foundation-model/${foundation}`];
  return foundation === modelId ? models : [`arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`, ...models];
}

const AWS_PHONE_NUMBER_ID = /^phone-number-id-([0-9a-f]{32})$/;

/**
 * ARN of our WhatsApp number from its AWS id (`phone-number-id-<32 hex>`, secret WhatsAppPhoneNumberId):
 * `…:phone-number-id/<32 hex>`, without the `phone-number-id-` prefix. `undefined` while the secret
 * is `not-connected`: the statement is omitted, never widened to `phone-number-id/*`.
 */
export function whatsappPhoneArn(awsPhoneNumberId: string, region: string = REGION, account: string = ACCOUNT_ID): string | undefined {
  if (awsPhoneNumberId === "not-connected") return undefined;
  const hex = AWS_PHONE_NUMBER_ID.exec(awsPhoneNumberId)?.[1];
  if (!hex) throw new Error("WhatsAppPhoneNumberId must be `not-connected` or `phone-number-id-<32 hex>` (the AWS id, never the Meta id).");
  return `arn:aws:social-messaging:${region}:${account}:phone-number-id/${hex}`;
}

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
  readonly test: "StringEquals" | "StringLike" | "ForAllValues:StringLike" | "ForAllValues:StringEquals" | "ArnLike";
  readonly variable: string;
  readonly values: readonly string[];
}

export interface Grant {
  readonly sid?: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  readonly conditions?: readonly Condition[];
}

export type CapabilityName = "TIMERS" | "SEND_EMAIL" | "SEND_WHATSAPP" | "PIPELINE" | "MOCK_NETWORK" | "MOCK_DISPATCH" | "TRANSCRIBE" | "MEMORY_ADMIN" | "WORLDS";

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
const writeAll = <T extends string>(names: readonly T[]): Partial<Record<T, Access>> => Object.fromEntries(names.map((name) => [name, "write"])) as Partial<Record<T, Access>>;

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
      { actions: ["s3:GetObject"], resources: ["{Media}/wa/*", "{Media}/sim/*"] },
      { actions: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], resources: ["{Media}/transcripts/*"] },
    ],
  },
  MEMORY_ADMIN: {
    grants: [
      {
        actions: [
          "bedrock-agentcore:ListEvents",
          "bedrock-agentcore:DeleteEvent",
          "bedrock-agentcore:ListMemoryRecords",
          "bedrock-agentcore:DeleteMemoryRecord",
          "bedrock-agentcore:RetrieveMemoryRecords",
        ],
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
    tables: { ...writeAll(APP_TABLES), Reference: "read", Network: "write", Dispatch: "write" },
  },
};

/** `dynamodb:LeadingKeys` of `Network` and `Dispatch` per role that holds `WORLDS` (docs/architecture.md §14). */
export const WORLDS_LEADING_KEYS = {
  Bff: ["ONU#GLOBAL#isp-demo#*", "ONU#JUDGE#isp-judge-*", "DWO#isp-demo#*", "DWO#isp-judge-*"],
  WorldJanitor: ["ONU#JUDGE#isp-judge-*", "DWO#isp-judge-*"],
  QaDriver: ["ONU#qa-*", "ONU#eval-*", "ONU#JUDGE#isp-judge-test#*", "DWO#isp-qa-*", "DWO#isp-eval-*", "DWO#isp-judge-test#*"],
} as const;

export type WorldsRole = keyof typeof WORLDS_LEADING_KEYS;

// ---- Roles --------------------------------------------------------------------------------------

export interface RoleCapabilities {
  readonly capabilities: readonly CapabilityName[];
  readonly tables?: Readonly<Partial<Record<TableName, Access>>>;
  readonly buckets?: Readonly<Partial<Record<BucketName, Access>>>;
  /** Grants beyond the capabilities and the linked data. */
  readonly grants?: readonly Grant[];
}

const g = (actions: readonly string[], resources: readonly string[], conditions?: readonly Condition[]): Grant => (conditions ? { actions, resources, conditions } : { actions, resources });
const sqsSend = (queue = "{InstallerEvents}"): Grant => g(["sqs:SendMessage"], [queue]);
const guardrailG1 = g(["bedrock:ApplyGuardrail"], ["{G1}"]);
const invokeModels = (model: "HARNESS" | "PHOTO", actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]): Grant => g(actions, [`{model:${model}}`]);
const metrics = g(["cloudwatch:PutMetricData"], ["*"], [{ test: "StringEquals", variable: "cloudwatch:namespace", values: [METRICS_NAMESPACE] }]);

export const LAMBDA_CAPABILITIES = {
  InstallerWorker: {
    capabilities: ["PIPELINE", "TRANSCRIBE", "MOCK_NETWORK"],
    tables: { WorkOrders: "write", People: "write", Cases: "write", Conversations: "write", Runtime: "write", AuditLog: "write", Isps: "read", Reference: "read", CuadrillaMetrics: "write" },
    grants: [g(["bedrock-agentcore:InvokeHarness"], ["{Harness}"]), guardrailG1, sqsSend(), g(["sqs:ChangeMessageVisibility"], ["{InstallerEvents}"])],
  },
  ToolOrders: {
    capabilities: ["MOCK_NETWORK"],
    tables: { WorkOrders: "write", People: "read", Isps: "read", Cases: "read", Runtime: "write", AuditLog: "write" },
  },
  ToolKnowledge: {
    capabilities: [],
    tables: { Reference: "read", Runtime: "write", AuditLog: "write" },
    grants: [g(["bedrock:Retrieve"], ["{KnowledgeBase}"])],
  },
  ToolEvidence: {
    capabilities: ["MOCK_NETWORK", "PIPELINE"],
    tables: { WorkOrders: "write", Reference: "read", Runtime: "write", AuditLog: "write" },
    buckets: { Media: "read" },
    // `Converse` is authorized by bedrock:InvokeModel; PIPELINE only for the VERDICT_REACTION kind (FL-103).
    grants: [invokeModels("PHOTO", ["bedrock:InvokeModel"]), g(["s3:PutObject"], ["{Evidence}/photos/*"])],
  },
  ToolMessaging: {
    capabilities: ["PIPELINE"],
    tables: { WorkOrders: "write", People: "write", Cases: "write", Conversations: "write", Runtime: "write", AuditLog: "write", Reference: "read" },
  },
  ToolCases: {
    capabilities: ["PIPELINE", "MOCK_NETWORK"],
    tables: { WorkOrders: "write", Cases: "write", People: "write", Isps: "read", Conversations: "write", Runtime: "write", AuditLog: "write" },
    grants: [g(["lambda:InvokeFunction"], ["{CertificateWriter}"])],
  },
  CertificateWriter: {
    capabilities: [],
    tables: { WorkOrders: "write", People: "read", Isps: "read" },
    grants: [g(["s3:GetObject"], ["{Evidence}/photos/*"]), g(["s3:PutObject"], ["{Evidence}/certificates/*"]), g(["bedrock:ApplyGuardrail"], ["{G3}"])],
  },
  InboundWhatsApp: {
    capabilities: ["SEND_WHATSAPP"],
    tables: { People: "write", Runtime: "write", Conversations: "write", WorkOrders: "write", Cases: "write", AuditLog: "write", Isps: "read" },
    buckets: { Media: "write" },
    grants: [g(["social-messaging:GetWhatsAppMessageMedia"], ["{whatsappPhone}"]), sqsSend(), metrics],
  },
  ChannelEvents: { capabilities: [], tables: { Conversations: "write", WorkOrders: "write", Runtime: "write" }, grants: [sqsSend()] },
  FeedEvents: { capabilities: [], tables: { WorkOrders: "write", Runtime: "write", AuditLog: "write" }, grants: [sqsSend()] },
  ScheduleDispatch: { capabilities: [], tables: { WorkOrders: "read", Cases: "read" }, grants: [sqsSend()] },
  Bff: {
    capabilities: ["MOCK_NETWORK", "MOCK_DISPATCH", "WORLDS"],
    tables: { ...writeAll(APP_TABLES), Reference: "read" },
    buckets: { Evidence: "read", Media: "write" },
    grants: [
      g(["s3:GetObject"], ["{Seed}/brand/*"]),
      sqsSend(),
      g(["lambda:InvokeFunction"], ["{InboundWhatsApp}", "{WorldJanitor}"]),
    ],
  },
  CostGuard: {
    capabilities: [],
    tables: { AuditLog: "write" },
    grants: [g(["dynamodb:PutItem"], ["{Runtime}"], [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: ["KILL#*"] }])],
  },
  WorldJanitor: { capabilities: ["WORLDS"] },
  PolicyAudit: {
    capabilities: [],
    tables: { Conversations: "read", AuditLog: "write", WorkOrders: "read", Cases: "read", People: "read", Isps: "read", Reference: "read" },
    grants: [g(["s3:GetObject"], ["{Evidence}/certificates/*"])],
  },
  // Cognito pre token generation: the user row by GSI1 `SUB#<sub>` and one audit row per ignored attribute.
  AuthPreToken: { capabilities: [], tables: { Isps: "read", AuditLog: "append" } },
  NetworkMock: { capabilities: [], tables: { Network: "write" } },
  DispatchMock: { capabilities: [], tables: { Dispatch: "write" }, grants: [g(["events:PutEvents"], ["{Feeds}"])] },
  QaDriver: {
    capabilities: ["MOCK_NETWORK", "MOCK_DISPATCH", "WORLDS"],
    tables: { ...writeAll(APP_TABLES), Reference: "read" },
    buckets: { Evidence: "read", Media: "write" },
    grants: [
      g(["cognito-idp:DescribeUserPoolClient"], ["{Auth}"]),
      g(["s3:GetObject"], ["{Seed}/brand/*"]),
      sqsSend(),
      g(["lambda:InvokeFunction"], ["{InboundWhatsApp}", "{WorldJanitor}", "{PolicyAudit}", "{ToolOrders}", "{ToolKnowledge}", "{ToolEvidence}", "{ToolMessaging}", "{ToolCases}"]),
      g(["sns:Publish"], [arn.waTopic]),
      guardrailG1,
      g(["sqs:ReceiveMessage", "sqs:DeleteMessage"], ["{InstallerEventsDlq}"]),
      g(["cloudwatch:DescribeAlarmHistory"], [arn.dlqAlarm]),
      g(["s3:DeleteObject"], ["{Media}/qa/*", "{Media}/eval/*", "{Evidence}/qa/*", "{Evidence}/eval/*"]),
      g(["scheduler:DeleteSchedule"], [`arn:aws:scheduler:${REGION}:${ACCOUNT_ID}:schedule/${SCHEDULE_GROUP}/tm-q-*`, `arn:aws:scheduler:${REGION}:${ACCOUNT_ID}:schedule/${SCHEDULE_GROUP}/tm-e-*`]),
      g(["dynamodb:PutItem", "dynamodb:DeleteItem"], ["{Runtime}"], [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: ["KILL#AGENT#qa-*"] }]),
    ],
  },
} as const satisfies Record<string, RoleCapabilities>;

export type LambdaName = keyof typeof LAMBDA_CAPABILITIES;

/** Execution roles of AgentCore (infra/agentcore-iam.ts), with the same shape as a Lambda's. */
export const SERVICE_ROLES = {
  Harness: {
    capabilities: [],
    grants: [
      invokeModels("HARNESS"),
      guardrailG1,
      g(["bedrock-agentcore:InvokeGateway"], ["{Gateway}"]),
      g(["bedrock-agentcore:CreateEvent", "bedrock-agentcore:GetEvent", "bedrock-agentcore:ListEvents", "bedrock-agentcore:RetrieveMemoryRecords"], ["{Memory}"]),
    ],
  },
  // Runs the extraction model of the three Memory strategies with override (sid of the scaffolding).
  Memory: { capabilities: [], grants: [{ sid: "ExtractionModel", ...invokeModels("HARNESS") }] },
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

function roleEntry(role: RoleName): RoleCapabilities {
  return role in LAMBDA_CAPABILITIES ? LAMBDA_CAPABILITIES[role as LambdaName] : SERVICE_ROLES[role as ServiceRoleName];
}

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

/** Every grant a role must receive through `sst.aws.permission` (data access goes by `link`). */
export function expectedGrants(role: RoleName): Grant[] {
  const entry = roleEntry(role);
  return [...(entry.grants ?? []), ...resolveCapabilities(entry.capabilities).flatMap((name) => CAPABILITIES[name].grants)];
}

export function expectedActions(role: RoleName): string[] {
  return [...new Set(expectedGrants(role).flatMap((grant) => grant.actions))].sort();
}

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
  return {
    extra: [...actual].filter((action) => !expected.has(action)).sort(),
    missing: [...expected].filter((action) => !actual.has(action)).sort(),
  };
}

export const IAM_ARNS = arn;
