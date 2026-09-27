// The own sign-up, the guest worlds and the leads as plain data (ADR-0025, ADR-0026,
// docs/architecture.md §5 and §14): the `Leads` table, what `LeadStream` consumes and when it sweeps,
// the fixed name of `GuestAccountDeletion`, the attributes the console BFF may write on a lead, and
// the IAM rows of the seven Lambdas of the flow. No SST or Pulumi dependency: infra/leads.ts,
// infra/auth.ts, infra/guest-worlds.ts and infra/bff.ts build the resources from this file,
// infra/iam-capabilities.ts merges the rows into its table (only types go the other way, so the two
// modules never import each other's values), and infra/leads-spec.test.ts checks every value.
//
// Leads are the only real personal data of the stage and live OUTSIDE the demo: a table of their
// own that the world factory never touches (`Leads` is in no capability but LEADS_READ and
// LEADS_WRITE, and WORLDS includes neither), deletion protection on (the declared exception to the
// `remove` policy) and no point-in-time recovery, so a lead deleted on request or by TTL does not
// survive 35 days in a backup.
import type { Capability, Condition, Grant, RoleCapabilities } from "./iam-capabilities";

// Values of infra/iam-capabilities.ts, repeated because that module imports this one (the test pins them).
const APP = "aws-cds-hackathon-poc-cuadrilla";
const STAGE = "poc";
const REGION = "us-east-1";
const ACCOUNT_ID = "776805327629";
const APP_DOMAIN = "cuadrilla.demo.craftech.io";
const CONFIGURATION_SET = `${APP}-email-${STAGE}`;

// ---- Leads table -------------------------------------------------------------------------------

export const LEADS_TABLE = "Leads";

/** `LEAD#<emailHash>` · `META` / `EVT#…` and `LEADLOG#<yyyy-mm>` · `<ts>#<ulid>`; GSI1 by Cognito sub. */
export const LEADS_TABLE_SPEC = { indexes: { GSI1: { hashKey: "subKey" } }, ttl: true } as const;

/** Old and new images: `LeadStream` needs the old one on a TTL delete (the users to remove). */
export const LEADS_STREAM = "new-and-old-images";

export const LEADS_PROTECTION = { deletionProtection: true, pointInTimeRecovery: false } as const;

/** Only the `META` item of a lead ever reaches `LeadStream`. */
const LEAD_META_KEYS = { Keys: { PK: { S: [{ prefix: "LEAD#" }] }, SK: { S: ["META"] } } } as const;

/**
 * Event source filters of `LeadStream` (Lambda event filtering over the stream records): a pending
 * lead (`status` absent) that becomes `CONFIRMED`, and a lead that DynamoDB removed by TTL. A lead
 * deleted on request (`GuestAccountDeletion`) is a user delete and never matches.
 */
export const LEAD_STREAM_FILTERS = [
  { eventName: ["MODIFY"], dynamodb: { ...LEAD_META_KEYS, OldImage: { status: { S: [{ exists: false }] } }, NewImage: { status: { S: ["CONFIRMED"] } } } },
  { eventName: ["REMOVE"], userIdentity: { type: ["Service"], principalId: ["dynamodb.amazonaws.com"] }, dynamodb: LEAD_META_KEYS },
] as const;

/** Consumer of the stream: a failed batch is split and, after its retries, lands in the DLQ. */
export const LEAD_STREAM_CONSUMER = {
  timeoutSeconds: 60,
  memoryMb: 256,
  batchSize: 10,
  maximumRetryAttempts: 3,
  bisectBatchOnFunctionError: true,
  startingPosition: "LATEST",
  /** SQS's maximum: a record that could not be handled stays readable for the operator. */
  dlqRetentionSeconds: 14 * 24 * 60 * 60,
} as const;

/** Daily safety net: Cognito never deletes UNCONFIRMED users on its own (ADR-0026). 02:20 in Mexico City. */
export const LEAD_SWEEP = { schedule: "cron(20 8 * * ? *)", event: { kind: "UNCONFIRMED_SWEEP" } } as const;

/** Fixed name of the dead letters of `LeadStream`, inside the `sqs:<app>-*` fence of the CI role. */
export function leadStreamDlqName(app: string = APP, stage: string = STAGE): string {
  return `${app}-${stage}-LeadStreamDlq`;
}

/** Fixed name of the account deletion (docs/architecture.md §1): the operator invokes it by name. */
export function guestAccountDeletionName(app: string = APP, stage: string = STAGE): string {
  return `${app}-${stage}-guest-account-deletion`;
}

// ---- What the console BFF may write on a lead ----------------------------------------------------

/**
 * `dynamodb:Attributes` of the BFF on `Leads` (docs/architecture.md §14): the form, the attribution,
 * the consents, what `signup.start` stamps on a new lead, its keys and the control attributes of the
 * connector. The attributes only a trigger, `LeadStream` or the deletion write are never here.
 * DynamoDB counts every attribute a request names, conditions included, so the pending check of the
 * code is a condition on `version` after reading the lead, never on `status`.
 */
export const BFF_LEAD_ATTRIBUTES = [
  "PK",
  "SK",
  "entity",
  "version",
  "createdAt",
  "updatedAt",
  "kind",
  "actor",
  "leadId",
  "email",
  "name",
  "company",
  "jobTitle",
  "locale",
  "originPoc",
  "origin",
  "utm",
  "referrerOrigin",
  "consents",
  "consentHistory",
  "abuseHash",
  "pendingUsernames",
  "pending",
  "retiredUsernames",
  "signupStartedAt",
  "expiresAt",
] as const;

/** Written by the confirmation, the sign-in, `LeadStream` or the deletion; never by the BFF. */
export const SERVER_LEAD_ATTRIBUTES = ["status", "confirmedAt", "lastLoginAt", "cognitoSub", "cognitoUsername", "userId", "notifiedAt", "notifyOutcome", "subKey"] as const;

/** A write may hand back only the attributes it touched (AWS guidance for `dynamodb:Attributes`). */
export const BFF_LEAD_RETURN_VALUES = ["NONE", "UPDATED_OLD", "UPDATED_NEW"] as const;

// ---- Lead notification ---------------------------------------------------------------------------

/** `"Cuadrilla · Leads" <leads@…>`: the only sender of `LeadStream`. */
export const LEAD_NOTIFY_SENDER = `leads@${APP_DOMAIN}`;
/** Every recipient of the notice is a Craftech mailbox; the code checks the exact domain too. */
export const LEAD_NOTIFY_RECIPIENTS = "*@craftech.io";
/** What `LeadStream` reads with `readLinked("LeadNotifyChannel", …)`; SEND_LEAD_NOTIFY rides on the link. */
export const LEAD_NOTIFY_LINK = "LeadNotifyChannel";

// ---- Lambdas of the flow -------------------------------------------------------------------------

/** Entries of the Lambdas of the flow; each file belongs to the WP that writes it (docs/build-plan.md). */
export const SIGNUP_HANDLERS = {
  AuthPreSignUp: "packages/bff/src/auth-triggers/pre-sign-up.handler", // WP-57
  AuthCustomMessage: "packages/bff/src/auth-triggers/custom-message.handler", // WP-57
  AuthPostConfirmation: "packages/bff/src/auth-triggers/post-confirmation.handler", // WP-58
  AuthPostAuthentication: "packages/bff/src/auth-triggers/post-authentication.handler", // WP-58
  GuestWorlds: "packages/bff/src/handlers/guest-worlds.handler", // WP-58
  LeadStream: "packages/bff/src/handlers/lead-stream.handler", // WP-59
  GuestAccountDeletion: "packages/bff/src/handlers/guest-account-deletion.handler", // WP-59
} as const;

export type SignupFunction = keyof typeof SIGNUP_HANDLERS;

/** Cognito waits 5 s for a trigger; each one works within a 4 s deadline (ADR-0025 §1). */
export const TRIGGER_BUDGET = { timeoutSeconds: 5, memoryMb: 256 } as const;
/** The minimal world factory writes a few hundred items; READY within 60 s. */
export const GUEST_WORLDS_BUDGET = { timeoutSeconds: 120, memoryMb: 1024 } as const;
/** Destroys a generation (its items, `guest/` objects and memory) besides the account. */
export const GUEST_ACCOUNT_DELETION_BUDGET = { timeoutSeconds: 120, memoryMb: 512 } as const;

// ---- IAM rows (docs/architecture.md §14) -----------------------------------------------------------

const READ_ITEMS = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"] as const;
/** Same lists as infra/storage-access.ts `TABLE_ACTIONS` (read and write); the test pins them. */
export const LEADS_TABLE_ACTIONS = {
  read: READ_ITEMS,
  write: [...READ_ITEMS, "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
} as const;

/** The actions a stream consumer polls with, on the stream of `Leads` only. */
export const LEADS_STREAM_ACTIONS = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:ListStreams"] as const;

const LEADS = ["{Leads}", "{Leads}/index/*"] as const;
const g = (actions: readonly string[], resources: readonly string[], conditions?: readonly Condition[]): Grant => (conditions ? { actions, resources, conditions } : { actions, resources });
const leadingKeys = (values: readonly string[]): Condition => ({ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values });
const runtime = (actions: readonly string[], keys: readonly string[]): Grant => g(actions, ["{Runtime}"], [leadingKeys(keys)]);
const KEY_READS = ["dynamodb:GetItem", "dynamodb:BatchGetItem"] as const;
const KEY_WRITES = [...KEY_READS, "dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:UpdateItem"] as const;
const GUEST_GENERATIONS = ["ISP#isp-guest-s*"] as const;
const invokeGuestWorlds = g(["lambda:InvokeFunction"], ["{GuestWorlds}"]);
const queryIspsBySub = g(["dynamodb:Query"], ["{Isps}/index/*"]);

export const SIGNUP_CAPABILITIES = {
  LEADS_READ: { grants: [g(LEADS_TABLE_ACTIONS.read, LEADS)] },
  LEADS_WRITE: { grants: [g(LEADS_TABLE_ACTIONS.write, LEADS)] },
  SEND_LEAD_NOTIFY: {
    grants: [
      g(
        ["ses:SendEmail"],
        [`arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${APP_DOMAIN}`, `arn:aws:ses:${REGION}:${ACCOUNT_ID}:configuration-set/${CONFIGURATION_SET}`],
        [
          { test: "StringEquals", variable: "ses:FromAddress", values: [LEAD_NOTIFY_SENDER] },
          { test: "ForAllValues:StringLike", variable: "ses:Recipients", values: [LEAD_NOTIFY_RECIPIENTS] },
        ],
      ),
    ],
  },
} as const satisfies Record<string, Capability>;

export type SignupCapability = keyof typeof SIGNUP_CAPABILITIES;

/**
 * The Lambdas of the flow. Every `Runtime` access is fenced by the keys of its row; every Cognito
 * action is on the stage's pool (`{UserPool}`) and only where the row names it; the triggers call
 * no Cognito API at all. The Lambdas they invoke come with the link of that Function.
 */
export const SIGNUP_ROLES = {
  // Reads the lead (EMAIL_TAKEN), spends a use of the ticket and reads the cut, the daily cap and the
  // person's confirmed accounts without incrementing anything. Reads go through the shared kill switch
  // reader (GetItem or BatchGetItem).
  AuthPreSignUp: {
    capabilities: ["LEADS_READ"],
    grants: [runtime(["dynamodb:UpdateItem"], ["SIGNUPTICKET#*"]), runtime(KEY_READS, ["SIGNUP#*", "SIGNUPKEY#*", "KILL#*"])],
  },
  // Only the cut of the sign-up: no table, no secret (the auth emails carry the neutral brand).
  AuthCustomMessage: { capabilities: [], grants: [runtime(KEY_READS, ["KILL#*"])] },
  // Lead PENDING → CONFIRMED, the guest's row in a generation of its own, the slot and the uniqueness of the sub.
  AuthPostConfirmation: {
    capabilities: ["LEADS_WRITE"],
    grants: [
      queryIspsBySub,
      g(["dynamodb:PutItem"], ["{Isps}"], [leadingKeys(GUEST_GENERATIONS)]),
      runtime(KEY_WRITES, ["GUESTACCOUNT#*", "GUESTWORLDS#*", "SIGNUPOK#*", "SIGNUPKEY#*", "SIGNUPSUB#*"]),
      invokeGuestWorlds,
    ],
  },
  // `lastLoginAt` and the retention of the lead; a new generation (old row out, new row in) when it
  // expired; and the confirmation of a `gst-*` user whose post confirmation failed after Cognito had
  // confirmed it (the same rows as AuthPostConfirmation: SIGNUPSUB#, SIGNUPKEY#).
  AuthPostAuthentication: {
    capabilities: ["LEADS_WRITE"],
    grants: [
      queryIspsBySub,
      g(["dynamodb:GetItem", "dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], ["{Isps}"], [leadingKeys(GUEST_GENERATIONS)]),
      runtime(KEY_WRITES, ["GUESTACCOUNT#*", "GUESTWORLDS#*", "SIGNUPOK#*", "SIGNUPKEY#*", "SIGNUPSUB#*"]),
      invokeGuestWorlds,
    ],
  },
  // The world factory, fenced to guest operators in the mocks' tables (WORLDS_LEADING_KEYS).
  GuestWorlds: { capabilities: ["WORLDS"] },
  // Notifies Craftech, deletes the pending users of a confirmed or expired lead, sweeps UNCONFIRMED
  // users daily and hands an expired confirmed lead to the deletion.
  LeadStream: {
    capabilities: ["LEADS_WRITE", "SEND_LEAD_NOTIFY"],
    grants: [
      g(LEADS_STREAM_ACTIONS, ["{Leads}/stream/*"]),
      g(["cognito-idp:AdminDeleteUser", "cognito-idp:ListUsers"], ["{UserPool}"]),
      g(["lambda:InvokeFunction"], ["{GuestAccountDeletion}"]),
      g(["sqs:SendMessage"], ["{LeadStreamDlq}"]),
    ],
  },
  // Works with the `gst-*` user stored in the row or the lead, never a listing (no ListUsers).
  GuestAccountDeletion: {
    capabilities: ["LEADS_WRITE", "WORLDS"],
    grants: [
      g(["cognito-idp:AdminGetUser", "cognito-idp:AdminDeleteUser"], ["{UserPool}"]),
      g(["s3:ListBucket"], ["{Media}", "{Evidence}"], [{ test: "StringLike", variable: "s3:prefix", values: ["guest/*"] }]),
      g(["s3:DeleteObject"], ["{Media}/guest/*", "{Evidence}/guest/*"]),
    ],
  },
} as const satisfies Record<SignupFunction, RoleCapabilities>;

/** The BFF on `Leads` (`signup.start`): its lead keys and the form's attributes only. */
export const BFF_LEADS_GRANT: Grant = g(
  ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
  ["{Leads}"],
  [
    leadingKeys(["LEAD#*"]),
    { test: "ForAllValues:StringEquals", variable: "dynamodb:Attributes", values: BFF_LEAD_ATTRIBUTES },
    { test: "StringEqualsIfExists", variable: "dynamodb:ReturnValues", values: BFF_LEAD_RETURN_VALUES },
  ],
);

/** `dynamodb:LeadingKeys` of the mocks' tables for the flow's roles that hold WORLDS: guest worlds only. */
export const GUEST_WORLDS_LEADING_KEYS = ["ONU#GUEST#isp-guest-*", "DWO#isp-guest-*"] as const;
