// What the post confirmation trigger does (ADR-0025 §1, FL-105, FL-122): a confirmed email of the own
// sign-up becomes a `GUEST` with a world. It acts ONLY when the three conditions hold:
//
//   1. `PostConfirmation_ConfirmSignUp` of a user `gst-<ULID>`
//   2. a PENDING lead for the event's email that lists that user, pending or retired (`mayConfirm`)
//   3. no registry for the `sub` (GSI1 `SUB#<sub>`, and `SIGNUPSUB#<sub>` with attribute_not_exists in
//      the transaction itself: a condition cannot reach a GSI)
//
// Then one transaction opens the first generation (`META` of `isp-guest-s…`), the registry row
// (`role GUEST`, `guestOrigin SIGNUP`, `cognitoUsername`), `SIGNUPSUB#`, `GUESTACCOUNT#`, one more
// confirmed account of the person and, when there is room, the slot; after it, the lead becomes
// `CONFIRMED` (`LeadStore`) and `GuestWorlds` is asked for the world. Without room the account and the
// lead are created all the same and the world waits in `CAP_FULL`. A person who already holds the two
// confirmed accounts of ADR-0025 §3 (another address that reduces to the same `abuseHash`) keeps the
// Cognito user and the lead, but the account opens in `PERSON_LIMIT`: no slot, no world, no count.
//
// Anything else is a no-op that leaves `SIGNUP_CONFIRM_IGNORED` in the lead log (the reason and the
// `sub`, never the email): an invited `guest-NN`, a `SUPERVISOR` or an `OPS` finishing the change of
// their first password never gets a second row nor a world. A retry of our own confirmation (Cognito
// retries a trigger that timed out) finds its own `SIGNUPSUB#` and only finishes what is missing.
//
// Cognito never undoes a confirmation whose trigger failed, so the next sign-in finishes it
// (`resumeFromSignIn`, guest/sign-in.ts): the same path, without the trigger source check, and asking
// for the world again only when its request is stale (the portada's "Reintentar" covers a fresh one).
import type { TableClient } from "../connector/table-client";
import type { Logger } from "../lib/log";
import { hashPrefix } from "../leads/keys";
import { type Lead, SIGNUP_USERNAME_PATTERN, mayConfirm } from "../leads/model";
import type { LeadStore } from "../leads/store";
import { SIGNUP_LIMITS, confirmedAccountsOf } from "../signup/limits";
import { openGeneration } from "../worlds/guest-lifecycle";
import { type GuestAccount, createAccountOp, getGuestAccount } from "./account";
import type { WorldProvisioner } from "./provisioner";
import { confirmedAccountOp, getSignupSub, rowsBySub, signupRowOp, signupSubOp, signupUserIdOf } from "./registry";
import { type SlotScope, planSlot, slotScopeOf } from "./slots";

export const CONFIRM_SIGNUP = "PostConfirmation_ConfirmSignUp";

/** A world still `PROVISIONING` this long after its request is asked for again by a resumed confirmation. */
export const RESUME_PROVISIONING_AFTER_MS = 2 * 60_000;

export type IgnoredReason = "NOT_CONFIRM_SIGNUP" | "NOT_SIGNUP_USER" | "NO_PENDING_LEAD" | "SUB_REGISTERED";

export interface ConfirmationEvent {
  readonly triggerSource: string;
  readonly userName: string;
  readonly sub: string;
  readonly email: string | undefined;
  /** The sign-in of a user Cognito confirmed while this path failed: no trigger source to check. */
  readonly resumeFromSignIn?: boolean;
}

export type ConfirmationOutcome =
  | { readonly kind: "IGNORED"; readonly reason: IgnoredReason }
  | { readonly kind: "CONFIRMED" | "RESUMED"; readonly userId: string; readonly clockId: string; readonly status: GuestAccount["status"] };

export interface ConfirmationDeps {
  readonly client: TableClient;
  readonly leads: Pick<LeadStore, "get" | "confirm" | "log">;
  /** `leadEmailHash` with the `email-hash` subkey. */
  readonly emailHash: (email: string) => string;
  readonly provisioner: WorldProvisioner;
  /** Real clock. */
  readonly now: () => Date;
  readonly suffix?: () => string;
  readonly log: Logger;
}

async function ignore(deps: ConfirmationDeps, reason: IgnoredReason, sub: string): Promise<ConfirmationOutcome> {
  await deps.leads.log({ kind: "SIGNUP_CONFIRM_IGNORED", actor: "SYSTEM", reason, ...(sub === "" ? {} : { sub }) }, deps.now());
  deps.log.info("signup.confirm.ignored", { reason, metric: "SignupConfirmIgnored", value: 1 });
  return { kind: "IGNORED", reason };
}

const pendingFor = (lead: Lead | undefined, username: string): lead is Lead => lead !== undefined && mayConfirm(lead, username);

/** The lead's side, after the registry exists: `CONFIRMED`, once. */
async function confirmLead(deps: ConfirmationDeps, event: ConfirmationEvent, emailHash: string, userId: string, at: Date): Promise<void> {
  const result = await deps.leads.confirm({ emailHash, username: event.userName, sub: event.sub, userId, at });
  if (result.outcome !== "CONFIRMED") deps.log.warn("signup.confirm.lead_not_pending", { userId, emailHashPrefix: hashPrefix(emailHash) });
}

async function provision(deps: ConfirmationDeps, account: Pick<GuestAccount, "userId" | "clockId" | "status">): Promise<void> {
  if (account.status === "PROVISIONING") await deps.provisioner.request({ userId: account.userId, clockId: account.clockId, origin: "SIGNUP" });
}

const isStale = (account: Pick<GuestAccount, "status" | "statusAtReal">, at: Date): boolean =>
  account.status === "PROVISIONING" && at.getTime() - Date.parse(account.statusAtReal) >= RESUME_PROVISIONING_AFTER_MS;

/** A retry of a confirmation already registered: finish the lead and the request of the world. */
async function resume(deps: ConfirmationDeps, event: ConfirmationEvent, emailHash: string, userId: string, at: Date): Promise<ConfirmationOutcome> {
  const account = await getGuestAccount(deps.client, userId);
  if (account === undefined) return ignore(deps, "SUB_REGISTERED", event.sub);
  if (pendingFor(await deps.leads.get(emailHash), event.userName)) await confirmLead(deps, event, emailHash, userId, at);
  // A sign-in right after a good confirmation lands here too (the index lags): never a second request.
  if (event.resumeFromSignIn !== true || isStale(account, at)) await provision(deps, account);
  return { kind: "RESUMED", userId, clockId: account.clockId, status: account.status };
}

type Decided = { readonly status: GuestAccount["status"]; readonly slotDay?: string | undefined };

export async function confirmSignup(deps: ConfirmationDeps, event: ConfirmationEvent): Promise<ConfirmationOutcome> {
  if (event.resumeFromSignIn !== true && event.triggerSource !== CONFIRM_SIGNUP) return ignore(deps, "NOT_CONFIRM_SIGNUP", event.sub);
  if (!SIGNUP_USERNAME_PATTERN.test(event.userName) || event.sub === "") return ignore(deps, "NOT_SIGNUP_USER", event.sub);
  if (event.email === undefined) return ignore(deps, "NO_PENDING_LEAD", event.sub);
  const at = deps.now();
  const userId = signupUserIdOf(event.userName);
  const emailHash = deps.emailHash(event.email);

  const own = await getSignupSub(deps.client, event.sub);
  if (own !== undefined) return own.userId === userId && own.username === event.userName ? resume(deps, event, emailHash, userId, at) : ignore(deps, "SUB_REGISTERED", event.sub);
  const lead = await deps.leads.get(emailHash);
  if (!pendingFor(lead, event.userName)) return ignore(deps, "NO_PENDING_LEAD", event.sub);
  if ((await rowsBySub(deps.client, event.sub)).length > 0) return ignore(deps, "SUB_REGISTERED", event.sub);

  const scope: SlotScope = slotScopeOf(lead);
  let decided: Decided = { status: "CAP_FULL" };
  const generation = await openGeneration({
    client: deps.client,
    now: at,
    ...(deps.suffix === undefined ? {} : { suffix: deps.suffix }),
    async ops(next) {
      const rows = [signupRowOp(deps.client, { ispId: next.ispId, userId, sub: event.sub, username: event.userName }, at), signupSubOp({ sub: event.sub, userId, username: event.userName }, at)];
      // Read on every attempt: a CONFLICT of the increment's ceiling (a race) comes back here and reads 2.
      if ((await confirmedAccountsOf(deps.client, lead.abuseHash)) >= SIGNUP_LIMITS.confirmedAccountsPerPerson) {
        decided = { status: "PERSON_LIMIT" };
        return [...rows, createAccountOp({ userId, guestOrigin: "SIGNUP", ispId: next.ispId, clockId: next.clockId, generation: 1, status: "PERSON_LIMIT", slotScope: scope }, at)];
      }
      const slot = await planSlot(deps.client, scope, at);
      decided = slot.ok ? { status: "PROVISIONING", slotDay: slot.day } : { status: "CAP_FULL" };
      return [
        ...rows,
        createAccountOp({ userId, guestOrigin: "SIGNUP", ispId: next.ispId, clockId: next.clockId, generation: 1, status: decided.status, slotDay: decided.slotDay, slotScope: scope }, at),
        confirmedAccountOp(lead.abuseHash, at),
        ...(slot.ok ? slot.ops : []),
      ];
    },
    // The trigger reads no operator row: its own rows absent means the generation's id, the slot or the
    // person's ceiling was taken, and the next attempt reads them again.
    idTaken: async () => (await getSignupSub(deps.client, event.sub)) === undefined && (await getGuestAccount(deps.client, userId)) === undefined,
  });

  const { status } = decided;
  await confirmLead(deps, event, emailHash, userId, at);
  await provision(deps, { userId, clockId: generation.clockId, status });
  const metric = status === "CAP_FULL" ? "GuestWorldCapFull" : status === "PERSON_LIMIT" ? "SignupPersonLimit" : "SignupConfirmed";
  deps.log.info("signup.confirm.done", { userId, ispId: generation.ispId, status, resumed: event.resumeFromSignIn === true, metric, value: 1 });
  return { kind: "CONFIRMED", userId, clockId: generation.clockId, status };
}
