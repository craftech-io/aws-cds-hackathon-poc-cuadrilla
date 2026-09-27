// What the post authentication trigger does on each sign-in (not on each refresh), by the registry row
// of the `sub` (ADR-0025 §1-§2, FL-108, FL-111, FL-122):
//
//   GUEST · SIGNUP           `lastLoginAt` of the lead and 24 more months of it (`LeadStore.recordLogin`);
//                            a new generation when the current one expired or is missing
//   GUEST · INVITED | TEST   its world, from the same factory and without TTL, when it has none yet;
//                            never a lead
//   SUPERVISOR, OPS          nothing at all: no write, no invocation
//   no row, `gst-*` user     the confirmation its post confirmation trigger could not finish (Cognito had
//                            already confirmed the user and never undoes it): guest/confirmation.ts with
//                            `resumeFromSignIn`, which acts only for a pending lead that lists the user
//   GUEST · SIGNUP whose lead is still pending (the trigger failed after its transaction): the lead
//                            is confirmed the same way
//
// A sign-in is never refused for any of this: a failure is logged, and the portada offers "Reintentar"
// (`guest.retryWorld`), which does the same from the console.
import { clockIdOfIsp } from "@cuadrilla/shared";
import type { TableClient } from "../connector/table-client";
import type { Logger } from "../lib/log";
import type { LeadStore } from "../leads/store";
import { SIGNUP_USERNAME_PATTERN } from "../leads/model";
import { type GuestAccount, createAccountOp, getGuestAccount, isExpiredAt, setStatus } from "./account";
import { type ConfirmationDeps, type ConfirmationOutcome, confirmSignup } from "./confirmation";
import type { WorldProvisioner } from "./provisioner";
import { type RegistryRow, originOf, rowsBySub } from "./registry";
import { renewGeneration } from "./renewal";
import type { SlotScope } from "./slots";

export const SIGN_IN = "PostAuthentication_Authentication";

/** A world still `PROVISIONING` this long after its request is asked for again. */
export const STALE_PROVISIONING_MS = 2 * 60_000;

export type SignInOutcome =
  | { readonly kind: "NONE"; readonly why: "NOT_A_SIGN_IN" | "NO_ROW" | "NOT_A_GUEST" }
  | { readonly kind: "CONFIRMATION"; readonly outcome: ConfirmationOutcome }
  | { readonly kind: "KEPT"; readonly userId: string }
  | { readonly kind: "RENEWED"; readonly userId: string; readonly clockId: string; readonly status: GuestAccount["status"] }
  | { readonly kind: "PROVISIONING"; readonly userId: string; readonly clockId: string };

export interface SignInDeps {
  readonly client: TableClient;
  readonly leads: Pick<LeadStore, "recordLogin" | "get" | "confirm" | "log">;
  /** `leadEmailHash` with the `email-hash` subkey (the confirmation it may have to finish). */
  readonly emailHash: ConfirmationDeps["emailHash"];
  readonly provisioner: WorldProvisioner;
  /** Real clock. */
  readonly now: () => Date;
  readonly suffix?: () => string;
  readonly log: Logger;
}

const isStale = (account: GuestAccount, now: Date): boolean => account.status === "PROVISIONING" && now.getTime() - Date.parse(account.statusAtReal) >= STALE_PROVISIONING_MS;

export interface SignInEvent {
  readonly triggerSource: string;
  readonly sub: string;
  /** The Cognito user name and the verified email: only a `gst-*` user's matter, to finish its confirmation. */
  readonly userName?: string | undefined;
  readonly email?: string | undefined;
}

/** The confirmation of a sign-up user, finished from its sign-in (a pending lead that lists it, or nothing). */
function finishConfirmation(deps: SignInDeps, event: SignInEvent): Promise<ConfirmationOutcome> {
  return confirmSignup(deps, { triggerSource: event.triggerSource, userName: event.userName ?? "", sub: event.sub, email: event.email, resumeFromSignIn: true });
}

const isSignupUser = (event: SignInEvent): boolean => SIGNUP_USERNAME_PATTERN.test(event.userName ?? "") && event.email !== undefined;

async function signupSignIn(deps: SignInDeps, row: RegistryRow, event: SignInEvent, now: Date): Promise<SignInOutcome> {
  let lead = await deps.leads.recordLogin(event.sub, now);
  // No confirmed lead for the sub: the trigger opened the account but never confirmed the lead.
  if (lead === undefined && isSignupUser(event) && row.cognitoUsername === event.userName) {
    await finishConfirmation(deps, event);
    lead = await deps.leads.recordLogin(event.sub, now);
  }
  const account = await getGuestAccount(deps.client, row.userId);
  // A current generation stays, even when the index still shows the row of a previous one (it lags);
  // an account over the person's limit never gets a world, whatever its age.
  if (account !== undefined && (!isExpiredAt(account, now) || account.status === "PERSON_LIMIT")) return { kind: "KEPT", userId: row.userId };
  const scope: SlotScope = account?.slotScope ?? (lead?.origin === "QA" ? "QA" : "PUBLIC");
  const renewal = await renewGeneration({ client: deps.client, now, scope, withClock: false, ...(deps.suffix === undefined ? {} : { suffix: deps.suffix }) }, { row, account });
  if (renewal.status === "PROVISIONING") await deps.provisioner.request({ userId: row.userId, clockId: renewal.generation.clockId, origin: "SIGNUP" });
  deps.log.info("guest.world.renewed", { userId: row.userId, ispId: renewal.generation.ispId, status: renewal.status, generation: renewal.generationNumber, metric: "GuestWorldRenewed", value: 1 });
  return { kind: "RENEWED", userId: row.userId, clockId: renewal.generation.clockId, status: renewal.status };
}

async function invitedSignIn(deps: SignInDeps, row: RegistryRow, origin: "INVITED" | "TEST", now: Date): Promise<SignInOutcome> {
  const clockId = clockIdOfIsp(row.ispId);
  const account = await getGuestAccount(deps.client, row.userId);
  if (account !== undefined && account.clockId === clockId && (account.status === "READY" || (account.status === "PROVISIONING" && !isStale(account, now)))) {
    return { kind: "KEPT", userId: row.userId };
  }
  if (account === undefined) {
    const op = createAccountOp({ userId: row.userId, guestOrigin: origin, ispId: row.ispId, clockId, generation: 1, status: "PROVISIONING" }, now);
    await deps.client.transact([op], now.toISOString());
  } else if (!(await setStatus(deps.client, row.userId, { to: "PROVISIONING", clockId: account.clockId }, now))) {
    return { kind: "KEPT", userId: row.userId };
  }
  await deps.provisioner.request({ userId: row.userId, clockId, origin });
  return { kind: "PROVISIONING", userId: row.userId, clockId };
}

export async function onSignIn(deps: SignInDeps, event: SignInEvent): Promise<SignInOutcome> {
  if (event.triggerSource !== SIGN_IN || event.sub === "") return { kind: "NONE", why: "NOT_A_SIGN_IN" };
  const rows = await rowsBySub(deps.client, event.sub);
  const [row] = rows;
  if (row === undefined && isSignupUser(event)) return { kind: "CONFIRMATION", outcome: await finishConfirmation(deps, event) };
  if (row === undefined || rows.length > 1) return { kind: "NONE", why: "NO_ROW" };
  const origin = originOf(row);
  if (row.role !== "GUEST" || origin === undefined) return { kind: "NONE", why: "NOT_A_GUEST" };
  const now = deps.now();
  return origin === "SIGNUP" ? signupSignIn(deps, row, event, now) : invitedSignIn(deps, row, origin, now);
}
