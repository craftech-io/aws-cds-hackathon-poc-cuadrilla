// What the post confirmation trigger does (ADR-0025 §1, FL-105, FL-122): a confirmed email of the own
// sign-up becomes a `GUEST` with a world. It acts ONLY when the three conditions hold:
//
//   1. `PostConfirmation_ConfirmSignUp` of a user `gst-<ULID>`
//   2. a PENDING lead for the event's email whose `pendingUsernames` lists that user
//   3. no registry for the `sub` (GSI1 `SUB#<sub>`, and `SIGNUPSUB#<sub>` with attribute_not_exists in
//      the transaction itself: a condition cannot reach a GSI)
//
// Then one transaction opens the first generation (`META` of `isp-guest-s…`), the registry row
// (`role GUEST`, `guestOrigin SIGNUP`, `cognitoUsername`), `SIGNUPSUB#`, `GUESTACCOUNT#`, one more
// confirmed account of the person and, when there is room, the slot; after it, the lead becomes
// `CONFIRMED` (`LeadStore`) and `GuestWorlds` is asked for the world. Without room the account and the
// lead are created all the same and the world waits in `CAP_FULL`.
//
// Anything else is a no-op that leaves `SIGNUP_CONFIRM_IGNORED` in the lead log (the reason and the
// `sub`, never the email): an invited `guest-NN`, a `SUPERVISOR` or an `OPS` finishing the change of
// their first password never gets a second row nor a world. A retry of our own confirmation (Cognito
// retries a trigger that timed out) finds its own `SIGNUPSUB#` and only finishes what is missing.
import type { TableClient } from "../connector/table-client";
import type { Logger } from "../lib/log";
import { hashPrefix } from "../leads/keys";
import { type Lead, SIGNUP_USERNAME_PATTERN, isPending } from "../leads/model";
import type { LeadStore } from "../leads/store";
import { openGeneration } from "../worlds/guest-lifecycle";
import { type GuestAccount, createAccountOp, getGuestAccount } from "./account";
import type { WorldProvisioner } from "./provisioner";
import { confirmedAccountOp, getSignupSub, rowsBySub, signupRowOp, signupSubOp, signupUserIdOf } from "./registry";
import { type SlotScope, planSlot } from "./slots";

export const CONFIRM_SIGNUP = "PostConfirmation_ConfirmSignUp";

export type IgnoredReason = "NOT_CONFIRM_SIGNUP" | "NOT_SIGNUP_USER" | "NO_PENDING_LEAD" | "SUB_REGISTERED";

export interface ConfirmationEvent {
  readonly triggerSource: string;
  readonly userName: string;
  readonly sub: string;
  readonly email: string | undefined;
}

export type ConfirmationOutcome =
  | { readonly kind: "IGNORED"; readonly reason: IgnoredReason }
  | { readonly kind: "CONFIRMED" | "RESUMED"; readonly userId: string; readonly clockId: string; readonly status: GuestAccount["status"] };

export interface ConfirmationDeps {
  readonly client: TableClient;
  readonly leads: LeadStore;
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

const pendingFor = (lead: Lead | undefined, username: string): lead is Lead => lead !== undefined && isPending(lead) && lead.pendingUsernames.includes(username);

/** The lead's side, after the registry exists: `CONFIRMED`, once. */
async function confirmLead(deps: ConfirmationDeps, event: ConfirmationEvent, emailHash: string, userId: string, at: Date): Promise<void> {
  const result = await deps.leads.confirm({ emailHash, username: event.userName, sub: event.sub, userId, at });
  if (result.outcome !== "CONFIRMED") deps.log.warn("signup.confirm.lead_not_pending", { userId, emailHashPrefix: hashPrefix(emailHash) });
}

async function provision(deps: ConfirmationDeps, account: Pick<GuestAccount, "userId" | "clockId" | "status">): Promise<void> {
  if (account.status === "PROVISIONING") await deps.provisioner.request({ userId: account.userId, clockId: account.clockId, origin: "SIGNUP" });
}

/** A retry of a confirmation this trigger already registered: finish the lead and the request of the world. */
async function resume(deps: ConfirmationDeps, event: ConfirmationEvent, emailHash: string, userId: string, at: Date): Promise<ConfirmationOutcome> {
  const account = await getGuestAccount(deps.client, userId);
  if (account === undefined) return ignore(deps, "SUB_REGISTERED", event.sub);
  if (pendingFor(await deps.leads.get(emailHash), event.userName)) await confirmLead(deps, event, emailHash, userId, at);
  await provision(deps, account);
  return { kind: "RESUMED", userId, clockId: account.clockId, status: account.status };
}

export async function confirmSignup(deps: ConfirmationDeps, event: ConfirmationEvent): Promise<ConfirmationOutcome> {
  if (event.triggerSource !== CONFIRM_SIGNUP) return ignore(deps, "NOT_CONFIRM_SIGNUP", event.sub);
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

  const scope: SlotScope = lead.origin === "QA" ? "QA" : "PUBLIC";
  const decided: { status: GuestAccount["status"] } = { status: "CAP_FULL" };
  const generation = await openGeneration({
    client: deps.client,
    now: at,
    ...(deps.suffix === undefined ? {} : { suffix: deps.suffix }),
    async ops(next) {
      const slot = await planSlot(deps.client, scope, at);
      decided.status = slot.ok ? "PROVISIONING" : "CAP_FULL";
      return [
        signupRowOp(deps.client, { ispId: next.ispId, userId, sub: event.sub, username: event.userName }, at),
        signupSubOp({ sub: event.sub, userId, username: event.userName }, at),
        createAccountOp({ userId, guestOrigin: "SIGNUP", ispId: next.ispId, clockId: next.clockId, generation: 1, status: decided.status, slotDay: slot.ok ? slot.day : undefined, slotScope: scope }, at),
        confirmedAccountOp(lead.abuseHash, at),
        ...(slot.ok ? slot.ops : []),
      ];
    },
    // The trigger reads no operator row: its own rows absent means the generation's id (or the slot) was taken.
    idTaken: async () => (await getSignupSub(deps.client, event.sub)) === undefined && (await getGuestAccount(deps.client, userId)) === undefined,
  });

  const { status } = decided;
  await confirmLead(deps, event, emailHash, userId, at);
  await provision(deps, { userId, clockId: generation.clockId, status });
  deps.log.info("signup.confirm.done", { userId, ispId: generation.ispId, status, metric: status === "CAP_FULL" ? "GuestWorldCapFull" : "SignupConfirmed", value: 1 });
  return { kind: "CONFIRMED", userId, clockId: generation.clockId, status };
}
