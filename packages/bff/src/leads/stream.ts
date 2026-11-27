// What `LeadStream` does with each record and with its daily schedule (ADR-0026, docs/architecture-
// integrations.md §9.3):
//
//   pending → CONFIRMED   the other pending and retired users out of Cognito (they could never confirm:
//                         the email is already the alias of the confirmed account), then `pendingUsernames`
//                         emptied; no notice yet (ADR-0029)
//   phone verified        the notice to Craftech (leads/notify.ts, at most once), with the verified phone:
//                         an account that never verifies its phone never reaches Craftech
//   pending lead by TTL   each pending and retired user out of Cognito, `LEAD_EXPIRED`
//   confirmed lead by TTL `GuestAccountDeletion` with the `userId` of the old image (user, row,
//                         `GUESTACCOUNT#` and current world, not only the user), `LEAD_EXPIRED`
//   daily sweep           every `gst-*` user still `UNCONFIRMED` 7 days after its creation (Cognito never
//                         deletes them on its own), `UnconfirmedUsersSwept`
//
// Cognito is called only with `gst-*` usernames, never with an email; a user already gone is fine.
// A failure throws: the batch is retried by the mapping and, after its retries, dead-lettered.
import type { CognitoUsers } from "./cognito-users";
import type { DeletionRequestInput } from "./deletion";
import { hashPrefix } from "./keys";
import { type Lead, SIGNUP_USERNAME_PATTERN, emailHashOfPartition } from "./model";
import { type NotifyDeps, type NotifyResult, notifyConfirmedLead } from "./notify";
import { classifyRecord } from "./stream-records";

/** Users that never confirmed are swept after this long (the pending lead's own lifetime). */
export const UNCONFIRMED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface LeadStreamDeps extends NotifyDeps {
  readonly cognito: CognitoUsers;
  /** Asynchronous invocation of `GuestAccountDeletion`. */
  readonly invokeDeletion: (request: DeletionRequestInput) => Promise<void>;
}

async function deleteUsers(deps: LeadStreamDeps, usernames: readonly string[]): Promise<number> {
  let deleted = 0;
  for (const username of usernames) {
    if (!SIGNUP_USERNAME_PATTERN.test(username)) continue;
    if ((await deps.cognito.deleteUser(username)) === "DELETED") deleted += 1;
  }
  return deleted;
}

/** Every `gst-*` user of the lead but the confirmed one: the pending ones and those later starts retired. */
function otherUsers(lead: Lead): string[] {
  return [...new Set([...lead.pendingUsernames, ...(lead.retiredUsernames ?? [])])].filter((username) => username !== lead.cognitoUsername);
}

async function onConfirmed(deps: LeadStreamDeps, lead: Lead): Promise<void> {
  const emailHash = emailHashOfPartition(lead.PK);
  const deleted = await deleteUsers(deps, otherUsers(lead));
  await deps.store.setPendingUsernames(emailHash, [], deps.now());
  deps.log.info("lead.confirmed.handled", { leadId: lead.leadId, emailHashPrefix: hashPrefix(emailHash), pendingUsersDeleted: deleted });
}

async function onPhoneVerified(deps: LeadStreamDeps, lead: Lead): Promise<NotifyResult> {
  const emailHash = emailHashOfPartition(lead.PK);
  const result = await notifyConfirmedLead(deps, emailHash);
  deps.log.info("lead.phone_verified.handled", { leadId: lead.leadId, emailHashPrefix: hashPrefix(emailHash), notice: result });
  return result;
}

async function onExpired(deps: LeadStreamDeps, lead: Lead): Promise<void> {
  const deleted = await deleteUsers(deps, otherUsers(lead));
  if (lead.status === "CONFIRMED" && lead.userId !== undefined) {
    await deps.invokeDeletion({ userId: lead.userId, actor: "TTL", abuseHash: lead.abuseHash });
  }
  await deps.store.log({ kind: "LEAD_EXPIRED", actor: "TTL", leadId: lead.leadId, reason: lead.status === "CONFIRMED" ? "CONFIRMED_INACTIVE" : "NEVER_CONFIRMED" }, deps.now());
  deps.log.info("lead.expired.handled", { leadId: lead.leadId, confirmed: lead.status === "CONFIRMED", pendingUsersDeleted: deleted });
}

export interface StreamSummary {
  readonly confirmed: number;
  readonly verified: number;
  readonly expired: number;
  readonly ignored: number;
}

/** Every record of one batch, in order. */
export async function handleLeadRecords(deps: LeadStreamDeps, records: readonly unknown[]): Promise<StreamSummary> {
  let confirmed = 0;
  let verified = 0;
  let expired = 0;
  let ignored = 0;
  for (const record of records) {
    const change = classifyRecord(record);
    if (change.kind === "CONFIRMED") {
      await onConfirmed(deps, change.lead);
      confirmed += 1;
    } else if (change.kind === "PHONE_VERIFIED") {
      await onPhoneVerified(deps, change.lead);
      verified += 1;
    } else if (change.kind === "EXPIRED") {
      await onExpired(deps, change.lead);
      expired += 1;
    } else {
      ignored += 1;
    }
  }
  return { confirmed, verified, expired, ignored };
}

/** The daily safety net: `gst-*` users still unconfirmed a week after their creation. */
export async function sweepUnconfirmed(deps: Pick<LeadStreamDeps, "cognito" | "now" | "log">): Promise<number> {
  const cutoff = deps.now().getTime() - UNCONFIRMED_MAX_AGE_MS;
  const users = await deps.cognito.listUnconfirmed();
  let swept = 0;
  for (const user of users) {
    if (!SIGNUP_USERNAME_PATTERN.test(user.username) || user.createdAt.getTime() > cutoff) continue;
    if ((await deps.cognito.deleteUser(user.username)) === "DELETED") swept += 1;
  }
  deps.log.info("lead.sweep.done", { metric: "UnconfirmedUsersSwept", value: swept, listed: users.length });
  return swept;
}
