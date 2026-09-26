// What the guest's portada (`/app/home`, docs/landing-spec.md §7.6) shows about its world: one of the four
// states, and for a ready world a summary of what was seeded. `guest.world` answers this, and the
// `QaDriver` asserts it (`SC-20/3`). A sign-up guest also sees when its world expires and may delete its
// account; an invited or rehearsal guest sees neither.
//
//   PROVISIONING   the world is being built (a stale one may be asked for again)
//   READY          operator, installers, supervisors and orders of the simulated day, the simulated time
//   FAILED         the build failed, or a sign-up world ran out its 7 days while the session lived on
//   CAP_FULL       no room under the cap of active sign-up worlds
import { z } from "zod";
import { type GuestOrigin, GuestOrigin as GuestOriginSchema, GuestWorldStatus, IsoInstant, ToolError, clockIdOfIsp, guestOriginOfIsp } from "@cuadrilla/shared";
import type { Principal } from "../auth/principal";
import type { Connector } from "../connector/ports";
import type { TableClient } from "../connector/table-client";
import { isSignupGuest } from "../routers/account";
import { type GuestAccount, getGuestAccount, isExpiredAt } from "./account";

/** A world still `PROVISIONING` this long after its request may be asked for again from the portada. */
export const RETRY_PROVISIONING_AFTER_MS = 60_000;

export const WorldSummary = z.object({
  operatorName: z.string(),
  installers: z.array(z.string()),
  supervisors: z.int().min(0),
  workOrders: z.int().min(0),
  simNow: IsoInstant,
});
export type WorldSummary = z.infer<typeof WorldSummary>;

export const GuestWorldView = z.object({
  status: GuestWorldStatus,
  origin: GuestOriginSchema,
  /** Only a guest of the own sign-up deletes its account from the portada (`account.deleteGuest`). */
  canDeleteAccount: z.boolean(),
  canRetry: z.boolean(),
  /** The session names an older generation: the console refreshes its tokens to reach the current one. */
  refreshSession: z.boolean(),
  createdAtReal: IsoInstant.optional(),
  /** Sign-up only: when the world is recreated at the next sign-in. */
  expiresAtReal: IsoInstant.optional(),
  summary: WorldSummary.optional(),
});
export type GuestWorldView = z.infer<typeof GuestWorldView>;

export interface WorldStatusPorts {
  readonly client: TableClient;
  readonly connector: Pick<Connector, "isps" | "people" | "workOrders" | "runtime">;
  /** Real clock. */
  readonly now: () => Date;
}

export type GuestPrincipal = Pick<Principal, "role" | "isGuest" | "ispId" | "userId" | "clockId">;

// America/Mexico_City keeps -06:00 all year: the simulated day of an instant is its date at that offset.
const WORLD_OFFSET_MS = -6 * 3_600_000;

function simInstant(clock: { readonly mode: string; readonly pausedSimNow: string; readonly offsetMs: number }, now: Date): string {
  return clock.mode === "PAUSED" ? clock.pausedSimNow : new Date(now.getTime() + clock.offsetMs).toISOString();
}

const simDateOf = (simNow: string): string => new Date(Date.parse(simNow) + WORLD_OFFSET_MS).toISOString().slice(0, 10);

/** What a ready world holds; `undefined` while its clock is not there yet. */
export async function summaryOf(ports: WorldStatusPorts, ispId: string): Promise<WorldSummary | undefined> {
  const clock = await ports.connector.runtime.getClock(clockIdOfIsp(ispId));
  if (clock === undefined) return undefined;
  const simNow = simInstant(clock, ports.now());
  const [isp, installers, supervisors, orders] = await Promise.all([
    ports.connector.isps.getIsp(ispId),
    ports.connector.people.listPeople(ispId, "INSTALLER"),
    ports.connector.people.listPeople(ispId, "SUPERVISOR"),
    ports.connector.workOrders.listIspDay(ispId, simDateOf(simNow)),
  ]);
  return {
    operatorName: isp?.displayName ?? "",
    installers: installers.map((person) => `${person.firstName} ${person.lastName}`),
    supervisors: supervisors.length,
    workOrders: orders.length,
    simNow,
  };
}

function originOf(account: GuestAccount | undefined, principal: GuestPrincipal): GuestOrigin {
  const origin = account?.guestOrigin ?? guestOriginOfIsp(principal.ispId);
  if (origin === undefined) throw new ToolError("FORBIDDEN", "this account has no guest world", "NOT_A_GUEST_WORLD");
  return origin;
}

const retryable = (account: GuestAccount, now: Date): boolean =>
  account.status === "FAILED" || account.status === "CAP_FULL" || (account.status === "PROVISIONING" && now.getTime() - Date.parse(account.statusAtReal) >= RETRY_PROVISIONING_AFTER_MS);

/** The portada's view of the principal's world. */
export async function worldStatusOf(ports: WorldStatusPorts, principal: GuestPrincipal): Promise<GuestWorldView> {
  const now = ports.now();
  const account = await getGuestAccount(ports.client, principal.userId);
  const origin = originOf(account, principal);
  const base = { origin, canDeleteAccount: origin === "SIGNUP" && isSignupGuest(principal) };
  if (account === undefined) {
    // An invited world built before its account row existed is ready; otherwise it is on its way.
    const summary = origin === "SIGNUP" ? undefined : await summaryOf(ports, principal.ispId);
    return summary === undefined ? { ...base, status: "PROVISIONING", canRetry: true, refreshSession: false } : { ...base, status: "READY", canRetry: false, refreshSession: false, summary };
  }
  const dates = { createdAtReal: account.createdAtReal, ...(account.guestOrigin === "SIGNUP" && account.expiresAtReal !== undefined ? { expiresAtReal: account.expiresAtReal } : {}) };
  const refreshSession = account.clockId !== principal.clockId;
  if (isExpiredAt(account, now)) return { ...base, ...dates, status: "FAILED", canRetry: true, refreshSession };
  const summary = account.status === "READY" ? await summaryOf(ports, account.ispId) : undefined;
  return { ...base, ...dates, status: account.status, canRetry: retryable(account, now), refreshSession, ...(summary === undefined ? {} : { summary }) };
}
