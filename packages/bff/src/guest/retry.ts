// "Reintentar" of the portada (`guest.retryWorld`, docs/landing-spec.md §7.6): once a real minute per guest
// (guest/slots.ts), it does what the state of the world asks for:
//
//   CAP_FULL                          reserve a slot for the current generation → PROVISIONING
//   FAILED                            ask `GuestWorlds` again for the same generation
//   FAILED by a collision, or expired a new generation of a sign-up guest (guest/renewal.ts, with its clock)
//   PROVISIONING for a minute or more ask `GuestWorlds` again
//   no account yet (invited, rehearsal) open it and ask for the world
//   READY, or PROVISIONING just now   nothing
//   PERSON_LIMIT                      nothing: the person holds its two worlds already (ADR-0025 §3)
import { ToolError, clockIdOfIsp } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import type { TableClient } from "../connector/table-client";
import { userKey } from "../connector/keys";
import { type GuestAccount, createAccountOp, getGuestAccount, isExpiredAt, setStatus, setStatusOp } from "./account";
import type { WorldProvisioner } from "./provisioner";
import { type RegistryRow, originOf, registryRowOf } from "./registry";
import { renewGeneration } from "./renewal";
import { claimRetry, planSlot } from "./slots";
import { type GuestPrincipal, RETRY_PROVISIONING_AFTER_MS } from "./world-status";

export interface RetryPorts {
  readonly client: TableClient;
  readonly connector: Pick<Connector, "runtime">;
  readonly provisioner: WorldProvisioner;
  /** Real clock. */
  readonly now: () => Date;
  readonly suffix?: () => string;
}

export type RetryOutcome = "RENEWED" | "SLOT_TAKEN" | "STILL_FULL" | "REQUESTED" | "NOTHING_TO_DO";

/** The guest's registry row where the account says it lives (a consistent read, never the index). */
async function registryRow(ports: RetryPorts, ispId: string, userId: string): Promise<RegistryRow> {
  const item = await ports.client.get("Isps", userKey(ispId, userId));
  const row = item === undefined ? undefined : registryRowOf(item);
  if (row === undefined) throw new ToolError("NOT_FOUND", "the guest's registry row is not there", "NO_REGISTRY_ROW");
  return row;
}

async function renew(ports: RetryPorts, principal: GuestPrincipal, account: GuestAccount | undefined): Promise<RetryOutcome> {
  const row = await registryRow(ports, account?.ispId ?? principal.ispId, principal.userId);
  const renewal = await renewGeneration({ client: ports.client, now: ports.now(), scope: account?.slotScope ?? "PUBLIC", withClock: true, ...(ports.suffix === undefined ? {} : { suffix: ports.suffix }) }, { row, account });
  if (renewal.status === "PROVISIONING") await ports.provisioner.request({ userId: principal.userId, clockId: renewal.generation.clockId, origin: "SIGNUP" });
  return "RENEWED";
}

async function takeSlot(ports: RetryPorts, account: GuestAccount): Promise<RetryOutcome> {
  const now = ports.now();
  const slot = await planSlot(ports.client, account.slotScope ?? "PUBLIC", now);
  if (!slot.ok) return "STILL_FULL";
  await ports.client.transact([...slot.ops, setStatusOp(account.userId, { to: "PROVISIONING", clockId: account.clockId, from: ["CAP_FULL"], slotDay: slot.day }, now)], now.toISOString());
  await ports.provisioner.request({ userId: account.userId, clockId: account.clockId, origin: account.guestOrigin });
  return "SLOT_TAKEN";
}

async function requestAgain(ports: RetryPorts, account: GuestAccount): Promise<RetryOutcome> {
  if (!(await setStatus(ports.client, account.userId, { to: "PROVISIONING", clockId: account.clockId, from: [account.status] }, ports.now()))) return "NOTHING_TO_DO";
  await ports.provisioner.request({ userId: account.userId, clockId: account.clockId, origin: account.guestOrigin });
  return "REQUESTED";
}

/** Runs one retry of the principal's world; `CAP_REACHED` (429) when the guest already retried this minute. */
export async function retryWorld(ports: RetryPorts, principal: GuestPrincipal): Promise<RetryOutcome> {
  const now = ports.now();
  if (!(await claimRetry(ports.connector.runtime, principal.userId, now))) throw new ToolError("CAP_REACHED", "the world can be retried once a minute", "RETRY_TOO_SOON");
  const account = await getGuestAccount(ports.client, principal.userId);
  const origin = account?.guestOrigin ?? originOf({ ispId: principal.ispId });
  if (origin === undefined) throw new ToolError("FORBIDDEN", "this account has no guest world", "NOT_A_GUEST_WORLD");

  if (account === undefined) {
    if (origin === "SIGNUP") return renew(ports, principal, undefined);
    const clockId = clockIdOfIsp(principal.ispId);
    await ports.client.transact([createAccountOp({ userId: principal.userId, guestOrigin: origin, ispId: principal.ispId, clockId, generation: 1, status: "PROVISIONING" }, now)], now.toISOString());
    await ports.provisioner.request({ userId: principal.userId, clockId, origin });
    return "REQUESTED";
  }
  if (account.status === "PERSON_LIMIT") return "NOTHING_TO_DO";
  if (account.guestOrigin === "SIGNUP" && (isExpiredAt(account, now) || account.failure === "GENERATION_COLLISION")) return renew(ports, principal, account);
  switch (account.status) {
    case "CAP_FULL":
      return takeSlot(ports, account);
    case "FAILED":
      return requestAgain(ports, account);
    case "PROVISIONING":
      return now.getTime() - Date.parse(account.statusAtReal) >= RETRY_PROVISIONING_AFTER_MS ? requestAgain(ports, account) : "NOTHING_TO_DO";
    case "READY":
      return "NOTHING_TO_DO";
  }
  return "NOTHING_TO_DO";
}
