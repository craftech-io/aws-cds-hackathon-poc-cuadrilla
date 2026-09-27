// `GuestAccountDeletion` (ADR-0025 §6, ADR-0026 "Borrado a pedido y retención"): the one way a guest of
// the own sign-up and its lead are deleted, whoever asks (the guest from the console, the operator's
// script, `LeadStream` when a confirmed lead expires, the QA seam). A direct invocation does not say who
// called, so the function checks its TARGET:
//
//   {userId}   `usr-g<ULID>` only; the account (`GUESTACCOUNT#`) and the registry row come from the
//              tables, the lead from the row's `sub`; anything else is refused
//   {email}    the lead of that address (operator, QA); its row, if any, from the lead's `sub`
//   refused    a row that is not `role GUEST` + `guestOrigin SIGNUP` + a `gst-*` user: NOT_A_SIGNUP_GUEST,
//              `DELETION_REFUSED` in the lead log, nothing deleted (supervisors, operators, `guest-NN`)
//
// Cognito is called ONLY with the stored `gst-*` users (never the email: it would stay in CloudTrail).
// Order, so a failure deletes nothing it cannot finish and a retry converges: current generation of the
// world (items, media, evidence, memory) → Cognito users → registry row, `SIGNUPSUB#`, `GUESTACCOUNT#`
// and `SIGNUPKEY#` − 1 in one transaction → the lead and its events → `LEAD_DELETED` with the
// `leadId`. Idempotent: a second call finds nothing.
import { ConnectorError } from "@cuadrilla/shared";
import { z } from "zod";
import type { Logger } from "../lib/log";
import type { CognitoUsers } from "./cognito-users";
import type { GuestAccount, GuestAccountPorts, RegistryUser } from "./guest-accounts";
import { ispOfGeneration } from "./guest-accounts";
import { hashPrefix } from "./keys";
import { EmailHash, type Lead, type LeadActor, SIGNUP_USERNAME_PATTERN, SIGNUP_USER_ID_PATTERN, emailHashOfPartition } from "./model";
import type { LeadStore } from "./store";

/** What the function accepts; `account.deleteGuest` sends only `{userId}` of its principal. */
export const DeletionRequest = z.union([
  z
    .object({
      userId: z.string().min(1).max(64),
      actor: z.enum(["GUEST", "TTL", "SYSTEM"]).default("GUEST"),
      /** Only from `LeadStream` on the expiry of a confirmed lead, whose item is already gone. */
      abuseHash: EmailHash.optional(),
    })
    .strict()
    .refine((request) => request.abuseHash === undefined || request.actor === "TTL", { message: "abuseHash comes only with an expiry", path: ["abuseHash"] }),
  z
    .object({
      email: z.string().trim().min(3).max(320),
      actor: z.enum(["OPERATOR", "SYSTEM"]).default("OPERATOR"),
    })
    .strict(),
]);
export type DeletionRequest = z.output<typeof DeletionRequest>;
export type DeletionRequestInput = z.input<typeof DeletionRequest>;

/** What the function answers (the console, the operator's script and the QA seam parse it). */
export const DeletionResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("DELETED"), leadId: z.string().optional(), deletedUsers: z.number().int().min(0) }).strict(),
  z.object({ outcome: z.literal("NOTHING_TO_DELETE") }).strict(),
  z.object({ outcome: z.literal("REFUSED"), reason: z.literal("NOT_A_SIGNUP_GUEST") }).strict(),
]);
export type DeletionResult = z.infer<typeof DeletionResult>;

/** Destroys one generation of a guest world: its items, its `guest/` media and evidence, its Memory. */
export interface GenerationDestroyer {
  destroyGeneration(account: GuestAccount): Promise<void>;
}

export interface DeletionDeps {
  readonly leads: LeadStore;
  readonly accounts: GuestAccountPorts;
  readonly cognito: Pick<CognitoUsers, "deleteUser">;
  readonly worlds: GenerationDestroyer;
  /** `leadEmailHash` with the `email-hash` subkey. */
  readonly emailHash: (email: string) => string;
  /** Real clock. */
  readonly now: () => Date;
  readonly log: Logger;
}

interface Target {
  readonly lead?: Lead | undefined;
  readonly row?: RegistryUser | undefined;
  readonly account?: GuestAccount | undefined;
}

type Resolution = { readonly kind: "TARGET"; readonly target: Target } | { readonly kind: "NOTHING" } | { readonly kind: "REFUSED" };

/** A registry row the deletion may touch: a guest of the own sign-up, with its `gst-*` user. */
export function isSignupGuestRow(row: RegistryUser): boolean {
  return row.role === "GUEST" && row.guestOrigin === "SIGNUP" && SIGNUP_USERNAME_PATTERN.test(row.cognitoUsername ?? "") && SIGNUP_USER_ID_PATTERN.test(row.userId);
}

async function byUserId(deps: DeletionDeps, userId: string): Promise<Resolution> {
  if (!SIGNUP_USER_ID_PATTERN.test(userId)) return { kind: "REFUSED" };
  const account = await deps.accounts.getGuestAccount(userId);
  const ispId = account === undefined ? undefined : ispOfGeneration(account);
  const row = ispId === undefined ? undefined : await deps.accounts.getRegistryUser(ispId, userId);
  if (row !== undefined && !isSignupGuestRow(row)) return { kind: "REFUSED" };
  if (account !== undefined && account.guestOrigin !== undefined && account.guestOrigin !== "SIGNUP") return { kind: "REFUSED" };
  const lead = row?.cognitoSub === undefined ? undefined : await deps.leads.findBySub(row.cognitoSub);
  if (account === undefined && row === undefined && lead === undefined) return { kind: "NOTHING" };
  return { kind: "TARGET", target: { lead, row, account } };
}

async function byEmail(deps: DeletionDeps, email: string): Promise<Resolution> {
  const lead = await deps.leads.get(deps.emailHash(email));
  if (lead === undefined) return { kind: "NOTHING" };
  const bySub = lead.cognitoSub === undefined ? undefined : await deps.accounts.findRegistryUserBySub(lead.cognitoSub);
  if (bySub !== undefined && !isSignupGuestRow(bySub)) return { kind: "REFUSED" };
  const userId = bySub?.userId ?? lead.userId;
  const account = userId === undefined ? undefined : await deps.accounts.getGuestAccount(userId);
  const ispId = account === undefined ? undefined : ispOfGeneration(account);
  // The row of the current generation, also when its index entry is not there yet.
  const row = bySub ?? (ispId === undefined || userId === undefined ? undefined : await deps.accounts.getRegistryUser(ispId, userId));
  if (row !== undefined && !isSignupGuestRow(row)) return { kind: "REFUSED" };
  if (account?.guestOrigin !== undefined && account.guestOrigin !== "SIGNUP") return { kind: "REFUSED" };
  return { kind: "TARGET", target: { lead, row, account } };
}

/** Every `gst-*` user of the target: the confirmed one, the pending and the retired ones, each once. */
function usernamesOf(target: Target): string[] {
  const names = [target.row?.cognitoUsername, target.lead?.cognitoUsername, ...(target.lead?.pendingUsernames ?? []), ...(target.lead?.retiredUsernames ?? [])];
  return [...new Set(names.filter((name): name is string => name !== undefined && SIGNUP_USERNAME_PATTERN.test(name)))];
}

const MAX_REMOVAL_ATTEMPTS = 3;

async function removeAccount(deps: DeletionDeps, target: Target, abuseHashHint: string | undefined): Promise<void> {
  const sub = target.row?.cognitoSub ?? target.lead?.cognitoSub;
  const abuseHash = target.lead?.abuseHash ?? abuseHashHint;
  for (let attempt = 0; attempt < MAX_REMOVAL_ATTEMPTS; attempt += 1) {
    const account = target.account === undefined ? undefined : await deps.accounts.getGuestAccount(target.account.userId);
    // An account over the person's limit never counted (guest/confirmation.ts): nothing to give back.
    const counted = account !== undefined && account.status !== "PERSON_LIMIT";
    const current = !counted || abuseHash === undefined ? undefined : await deps.accounts.getConfirmedAccounts(abuseHash);
    try {
      await deps.accounts.removeAccount(
        {
          user: target.row,
          sub,
          accountUserId: account?.userId,
          signupKey: abuseHash === undefined || current === undefined ? undefined : { abuseHash, current },
        },
        deps.now(),
      );
      return;
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT") || attempt === MAX_REMOVAL_ATTEMPTS - 1) throw error;
    }
  }
}

async function refuse(deps: DeletionDeps, actor: LeadActor): Promise<DeletionResult> {
  await deps.leads.log({ kind: "DELETION_REFUSED", actor, reason: "NOT_A_SIGNUP_GUEST" }, deps.now());
  deps.log.warn("lead.deletion.refused", { reason: "NOT_A_SIGNUP_GUEST", metric: "DeletionRefused", value: 1, actor });
  return { outcome: "REFUSED", reason: "NOT_A_SIGNUP_GUEST" };
}

/** Deletes a guest of the own sign-up and its lead, after checking the target. */
export async function deleteGuestAccount(deps: DeletionDeps, raw: DeletionRequestInput): Promise<DeletionResult> {
  const request = DeletionRequest.parse(raw);
  const actor: LeadActor = request.actor;
  const resolution = "userId" in request ? await byUserId(deps, request.userId) : await byEmail(deps, request.email);
  if (resolution.kind === "REFUSED") return refuse(deps, actor);
  if (resolution.kind === "NOTHING") return { outcome: "NOTHING_TO_DELETE" };

  const { target } = resolution;
  const usernames = usernamesOf(target);
  if (target.account !== undefined) await deps.worlds.destroyGeneration(target.account);
  for (const username of usernames) await deps.cognito.deleteUser(username);
  await removeAccount(deps, target, "abuseHash" in request ? request.abuseHash : undefined);
  const lead = target.lead === undefined ? undefined : await deps.leads.deleteLead(emailHashOfPartition(target.lead.PK));

  const leadId = lead?.leadId ?? target.lead?.leadId;
  await deps.leads.log({ kind: "LEAD_DELETED", actor, leadId }, deps.now());
  deps.log.info("lead.deletion.done", {
    actor,
    leadId,
    deletedUsers: usernames.length,
    ...(target.lead === undefined ? {} : { emailHashPrefix: hashPrefix(emailHashOfPartition(target.lead.PK)) }),
  });
  return leadId === undefined ? { outcome: "DELETED", deletedUsers: usernames.length } : { outcome: "DELETED", leadId, deletedUsers: usernames.length };
}
