// Leads of the own sign-up (ADR-0026, docs/architecture.md §5 and §14): the `Leads` table, `LeadStream`
// (notice to Craftech, pending users out, expiry, daily sweep) with its dead letters, and
// `GuestAccountDeletion`. Every value lives in infra/leads-spec.ts (checked by infra/leads-spec.test.ts);
// this module turns it into resources and resolves the placeholders of the flow's IAM rows
// (`signupPermissions`, also used by infra/auth.ts, infra/guest-worlds.ts and infra/bff.ts).
//
//   Leads                   PK/SK strings, GSI1 `subKey` (sparse), TTL `expiresAt`, stream NEW_AND_OLD_IMAGES,
//                           deletion protection ON and point-in-time recovery OFF: the declared exception to
//                           the `remove` policy. To remove the stage the operator turns protection off first,
//                           with explicit confirmation.
//   LeadStream              the stream with the two filters of LEAD_STREAM_FILTERS (a pending lead turning
//                           CONFIRMED, a lead removed by TTL), batches split on error, 3 retries, then
//                           LeadStreamDlq (fixed name, no alarm: a failed record is an `error` log line of
//                           LeadStream, ADR-0028, infra/logs-only.test.ts). A daily EventBridge rule
//                           (LEAD_SWEEP) invokes it with `{kind: "UNCONFIRMED_SWEEP"}`.
//   GuestAccountDeletion    fixed name `<app>-<stage>-guest-account-deletion`: the operator invokes it by
//                           name (`npm run leads:delete`), the BFF (`account.deleteGuest`) and LeadStream
//                           through their links. It checks its target in code (ADR-0025 §6); IAM only
//                           limits who may call it.
//   LeadNotifyChannel       `Resource.LeadNotifyChannel.{identityDomain, configurationSetName, sender}` and
//                           SEND_LEAD_NOTIFY: `ses:SendEmail` from `leads@` to `*@craftech.io` only. The
//                           mailboxes come from the `LeadConfig` secret, never from the code.
//
// The pool's ARN (Cognito actions of LeadStream and the deletion) comes from infra/auth.ts, which
// imports this module for the table: it is read late, once auth.ts has been evaluated.
//
// Verify:
//   aws --profile craftech-demos dynamodb describe-table --table-name <Leads>
//     → DeletionProtectionEnabled true · StreamSpecification NEW_AND_OLD_IMAGES · GSI1 subKey
//   aws --profile craftech-demos dynamodb describe-continuous-backups --table-name <Leads>   → PointInTimeRecoveryStatus DISABLED
//   aws --profile craftech-demos lambda list-event-source-mappings --function-name <LeadStream>   → FilterCriteria (2) · DestinationConfig.OnFailure
//   aws --profile craftech-demos lambda get-function --function-name aws-cds-hackathon-poc-cuadrilla-poc-guest-account-deletion

import { CAPABILITIES, expectedGrants, type Grant, type LambdaName } from "./iam-capabilities";
import { lateLinks, links } from "./late-links";
import {
  GUEST_ACCOUNT_DELETION_BUDGET,
  LEADS_PROTECTION,
  LEADS_STREAM,
  LEADS_TABLE,
  LEADS_TABLE_SPEC,
  LEAD_NOTIFY_LINK,
  LEAD_NOTIFY_SENDER,
  LEAD_STREAM_CONSUMER,
  LEAD_STREAM_FILTERS,
  LEAD_SWEEP,
  SIGNUP_CAPABILITIES,
  SIGNUP_HANDLERS,
  guestAccountDeletionName,
  leadStreamDlqName,
} from "./leads-spec";
import { CONFIGURATION_SET_NAME, EMAIL_DOMAIN } from "./messaging-email-spec";
import { mockLinks, mockPermissions } from "./mocks";
import { LeadConfig, SessionTokenKey } from "./secrets";
import { storageLinks, storagePermissions, storageResource, tables } from "./storage";
import { PRIMARY_KEY, TTL_ATTRIBUTE, parseStorageRef, storageFor, tableFields, type StorageTable } from "./storage-keys";
import { WorldTemplates } from "./world-templates";

// ---- Placeholders of the flow's grants ----------------------------------------------------------------

export type Statement = sst.aws.FunctionPermissionArgs;
/** Placeholders resolved by the caller (`{UserPool}`, `{LeadStreamDlq}`…). */
export type Refs = Readonly<Record<string, () => $util.Input<string>>>;

/** Invocations every caller gets with the link of the invoked Function (SST grants InvokeFunction on it). */
export const LINKED_FUNCTIONS = ["{GuestWorlds}", "{GuestAccountDeletion}", "{InboundWhatsApp}", "{WorldJanitor}"] as const;

export const Leads = new sst.aws.Dynamo(LEADS_TABLE, {
  fields: tableFields(LEADS_TABLE_SPEC),
  primaryIndex: PRIMARY_KEY,
  globalIndexes: LEADS_TABLE_SPEC.indexes,
  ttl: TTL_ATTRIBUTE,
  stream: LEADS_STREAM,
  deletionProtection: LEADS_PROTECTION.deletionProtection,
  transform: {
    table: (args) => {
      args.serverSideEncryption = { enabled: true };
      args.pointInTimeRecovery = { enabled: LEADS_PROTECTION.pointInTimeRecovery };
    },
  },
});

/** An ARN of a grant, a storage placeholder of infra/storage.ts, the `Leads` table or a caller's reference. */
export function resolveResource(resource: string, refs: Refs = {}): $util.Input<string> {
  if (resource.startsWith("arn:")) return resource;
  const storage = storageResource(resource);
  if (storage !== undefined) return storage;
  if (resource === "{Leads}") return Leads.arn;
  const suffix = /^\{Leads\}\/(index|stream)\/\*$/.exec(resource)?.[1];
  if (suffix !== undefined) return $interpolate`${Leads.arn}/${suffix}/*`;
  const ref = refs[resource];
  if (ref !== undefined) return ref();
  throw new Error(`"${resource}" has no resolver in infra/leads.ts; pass it in the refs of signupPermissions.`);
}

/** One iam-capabilities.ts grant as a permission statement, every placeholder resolved. */
export function grantStatement(grant: Grant, refs: Refs = {}): Statement {
  const statement: Statement = { actions: [...grant.actions], resources: grant.resources.map((resource) => resolveResource(resource, refs)) };
  if (grant.conditions) statement.conditions = grant.conditions.map((condition) => ({ test: condition.test, variable: condition.variable, values: [...condition.values] }));
  return statement;
}

/**
 * The grants of a role that are not data access of infra/storage.ts, not a Function invocation (the
 * link carries it) and not carried by a capability Linkable (`carried`), with every placeholder resolved.
 */
export function signupPermissions(fn: LambdaName, refs: Refs = {}, carried: readonly Grant[] = []): Statement[] {
  const skip = new Set(carried);
  return expectedGrants(fn)
    .filter((grant) => !skip.has(grant) && !grant.resources.every((resource) => (LINKED_FUNCTIONS as readonly string[]).includes(resource)))
    .map((grant) => grantStatement(grant, refs));
}

/**
 * Tables of infra/storage.ts a role reaches only through fenced grants (`{Runtime}` with
 * `dynamodb:LeadingKeys`, `{Isps}` of guest generations): linked by name, so the code finds them.
 */
export function grantTableLinks(fn: LambdaName): sst.aws.Dynamo[] {
  const linked = new Set<string>(storageFor(fn).tables);
  const names = new Set<StorageTable>();
  for (const grant of expectedGrants(fn)) {
    for (const resource of grant.resources) {
      const ref = parseStorageRef(resource);
      if (ref?.kind === "table" && !linked.has(ref.name)) names.add(ref.name);
    }
  }
  return [...names].sort().map((name) => tables[name]);
}

// ---- Cognito pool, read late ---------------------------------------------------------------------------

const userPoolArn = $util.output(
  import("./auth").then((module) => {
    const pool: unknown = Reflect.get(module, "userPool");
    if (!(pool instanceof sst.aws.CognitoUserPool)) throw new Error("infra/auth.ts exports no userPool CognitoUserPool, which LeadStream and GuestAccountDeletion act on.");
    return pool.arn;
  }),
);
const poolRefs: Refs = { "{UserPool}": () => userPoolArn };
/** `Resource.Auth.userPoolId` for the Cognito calls of LeadStream and the deletion (no grant rides on it). */
const authLink = () => lateLinks("leads", "auth", () => import("./auth"), ["Auth"]);

// ---- Notice to Craftech ------------------------------------------------------------------------------

/** `Resource.LeadNotifyChannel.*` and SEND_LEAD_NOTIFY, nothing more. */
export const LeadNotifyChannel = new sst.Linkable(LEAD_NOTIFY_LINK, {
  properties: { identityDomain: EMAIL_DOMAIN, configurationSetName: CONFIGURATION_SET_NAME, sender: LEAD_NOTIFY_SENDER },
  include: SIGNUP_CAPABILITIES.SEND_LEAD_NOTIFY.grants.map((grant) => sst.aws.permission(grantStatement(grant))),
});

// ---- Account deletion ----------------------------------------------------------------------------------

/**
 * What a role holding WORLDS links and adds besides its own grants (the world factory and the deletion
 * of a generation): the mocks' tables fenced to guest worlds (infra/mocks.ts) and the stage's Memory
 * (MEMORY_ADMIN rides on its Linkable, taken late from infra/agentcore.ts). TIMERS goes as statements.
 */
export function worldsAccess(fn: "GuestWorlds" | "GuestAccountDeletion") {
  return {
    links: links(lateLinks("leads", "agentcore", () => import("./agentcore"), ["Memory"], "optional"), mockLinks(fn)),
    permissions: [...storagePermissions(fn), ...mockPermissions(fn)],
    carried: CAPABILITIES.MEMORY_ADMIN.grants,
  };
}

const deletionWorlds = worldsAccess("GuestAccountDeletion");

export const guestAccountDeletion = new sst.aws.Function("GuestAccountDeletion", {
  name: guestAccountDeletionName($app.name, $app.stage),
  description: "Deletes a guest of the own sign-up: Cognito user, lead, registry row and current world.",
  handler: SIGNUP_HANDLERS.GuestAccountDeletion,
  link: links([...storageLinks("GuestAccountDeletion"), Leads, SessionTokenKey, WorldTemplates], deletionWorlds.links, authLink()),
  permissions: [...deletionWorlds.permissions, ...signupPermissions("GuestAccountDeletion", poolRefs, deletionWorlds.carried)],
  timeout: `${GUEST_ACCOUNT_DELETION_BUDGET.timeoutSeconds} seconds`,
  memory: `${GUEST_ACCOUNT_DELETION_BUDGET.memoryMb} MB`,
});

// ---- LeadStream ----------------------------------------------------------------------------------------

export const leadStreamDlq = new sst.aws.Queue("LeadStreamDlq", {
  transform: {
    queue: {
      name: leadStreamDlqName($app.name, $app.stage),
      messageRetentionSeconds: LEAD_STREAM_CONSUMER.dlqRetentionSeconds,
      sqsManagedSseEnabled: true,
    },
  },
});

export const leadStream = new sst.aws.Function("LeadStream", {
  description: "Leads stream: notice to Craftech, pending users out, expiry, and the daily sweep of UNCONFIRMED users.",
  handler: SIGNUP_HANDLERS.LeadStream,
  link: links([Leads, LeadNotifyChannel, LeadConfig, guestAccountDeletion], authLink()),
  permissions: signupPermissions("LeadStream", { ...poolRefs, "{LeadStreamDlq}": () => leadStreamDlq.arn }, SIGNUP_CAPABILITIES.SEND_LEAD_NOTIFY.grants),
  timeout: `${LEAD_STREAM_CONSUMER.timeoutSeconds} seconds`,
  memory: `${LEAD_STREAM_CONSUMER.memoryMb} MB`,
});

export const leadStreamMapping = new aws.lambda.EventSourceMapping("LeadStreamMapping", {
  eventSourceArn: Leads.nodes.table.streamArn,
  functionName: leadStream.arn,
  startingPosition: LEAD_STREAM_CONSUMER.startingPosition,
  batchSize: LEAD_STREAM_CONSUMER.batchSize,
  maximumRetryAttempts: LEAD_STREAM_CONSUMER.maximumRetryAttempts,
  bisectBatchOnFunctionError: LEAD_STREAM_CONSUMER.bisectBatchOnFunctionError,
  destinationConfig: { onFailure: { destinationArn: leadStreamDlq.arn } },
  filterCriteria: { filters: LEAD_STREAM_FILTERS.map((filter) => ({ pattern: JSON.stringify(filter) })) },
});

export const leadSweep = new sst.aws.Cron("LeadSweep", {
  function: leadStream.arn,
  schedule: LEAD_SWEEP.schedule,
  event: { ...LEAD_SWEEP.event },
});
