// A real phone in a guest's world, bound by a one-use code (docs/architecture-integrations.md §4.4.1,
// FL-101). The console shows "ALTA G07-4F2K" (30 minutes, one use, bound to a person of the world);
// sending it from a real phone proves the number belongs to whoever sends it, and binds that phone to
// the person for 48 hours (`Runtime/PHONELEASE#<phoneHash>`, created with `attribute_not_exists`: a
// phone lives in one world at a time). A phone registered in the live world is refused. Resetting the
// world (and the janitor) releases its leases; so does "BAJA" from the bound phone.
import { randomInt } from "node:crypto";
import { ConnectorError, ispIdOfClock, ispKindOfClock, parseClockId } from "@cuadrilla/shared";
import type { AuditPort, PeoplePort, WorldRuntimePort } from "../../connector/ports";
import type { JoinCode, PhoneLease } from "../../domain/runtime-world";
import { RUNTIME_TTL_SECONDS } from "../../domain/runtime";
import type { Person } from "../../domain/people";

/** Letters and digits that cannot be read as one another (no 0/O, 1/I/L). */
export const JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const JOIN_CODE_SUFFIX_LENGTH = 4;
export const LEASE_HOURS = RUNTIME_TTL_SECONDS.phoneLease / 3600;

/** The world's prefix of a code: `G07` for `GUEST#isp-guest-07`, `GTST` for the rehearsal world, `QA` in scenarios. */
export function joinCodePrefix(clockId: string): string {
  const world = parseClockId(clockId);
  if (world?.kind === "GUEST") {
    const suffix = world.ispId.slice("isp-guest-".length);
    return suffix === "test" ? "GTST" : `G${suffix}`;
  }
  if (world?.kind === "QA") return "QA";
  throw new RangeError("join codes exist only for guest and QA worlds");
}

export function newJoinCode(clockId: string, random: (max: number) => number = randomInt): string {
  const suffix = Array.from({ length: JOIN_CODE_SUFFIX_LENGTH }, () => JOIN_CODE_ALPHABET[random(JOIN_CODE_ALPHABET.length)] ?? "2").join("");
  return `${joinCodePrefix(clockId)}-${suffix}`;
}

export interface LeaseDeps {
  readonly worlds: Pick<WorldRuntimePort, "createJoinCode" | "bindPhoneLease" | "getPhoneLease" | "getLiveWorld" | "deletePhoneLease" | "listPhoneLeases">;
  readonly people: Pick<PeoplePort, "getPerson" | "findByPhone">;
  readonly audit: Pick<AuditPort, "append">;
  readonly random?: (max: number) => number;
}

export interface IssueJoinCodeInput {
  readonly clockId: string;
  /** A person of the world (Rogelio or a supervisor). */
  readonly personId: string;
  /** The console user who asked for it. */
  readonly userId: string;
}

/** `simulator.joinCode` (with the live transport in the stage): a fresh one-use code for a person of the world. */
export async function issueJoinCode(input: IssueJoinCodeInput, deps: LeaseDeps): Promise<JoinCode> {
  const kind = ispKindOfClock(input.clockId);
  if (kind !== "GUEST" && kind !== "QA") throw new ConnectorError("VALIDATION", "join codes exist only for guest and QA worlds");
  const person = await deps.people.getPerson(input.personId);
  if (person === undefined || person.clockId !== input.clockId || !person.active || (person.role !== "INSTALLER" && person.role !== "SUPERVISOR")) {
    throw new ConnectorError("NOT_FOUND", "no such person in this world");
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deps.worlds.createJoinCode({ code: newJoinCode(input.clockId, deps.random), clockId: input.clockId, personId: input.personId, userId: input.userId });
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT") || attempt >= 4) throw error;
    }
  }
}

export type BindOutcome =
  | { readonly ok: true; readonly lease: PhoneLease; readonly person: Person }
  | { readonly ok: false; readonly reason: "CODE_INVALID" | "LEASE_CONFLICT" };

export interface BindLeaseInput {
  /** Normalized code from "ALTA <código>" (copy/keywords.ts). */
  readonly code: string;
  readonly phoneHash: string;
}

async function denyConflict(deps: LeaseDeps, clockId: string | undefined, detail: string): Promise<BindOutcome> {
  if (clockId !== undefined) {
    await deps.audit.append({ ispId: ispIdOfClock(clockId), clockId, decision: "DENY", action: "PHONE_LEASE", actor: "CHANNEL", reason: "LEASE_CONFLICT", detail: { conflict: detail } });
  }
  return { ok: false, reason: "LEASE_CONFLICT" };
}

/** `bind_phone_lease`: "ALTA <código>" from a real phone. */
export async function bindPhoneLease(input: BindLeaseInput, deps: LeaseDeps): Promise<BindOutcome> {
  const liveWorld = await deps.worlds.getLiveWorld();
  if (liveWorld !== undefined && (await deps.people.findByPhone(liveWorld.clockId, input.phoneHash)) !== undefined) {
    return denyConflict(deps, liveWorld.clockId, "LIVE_WORLD_PHONE");
  }
  const existing = await deps.worlds.getPhoneLease(input.phoneHash);
  if (existing !== undefined) return denyConflict(deps, existing.clockId, "PHONE_ALREADY_BOUND");
  let lease: PhoneLease;
  try {
    lease = await deps.worlds.bindPhoneLease(input.code, input.phoneHash);
  } catch (error) {
    if (!(error instanceof ConnectorError)) throw error;
    if (error.code === "NOT_FOUND" || /join code/.test(error.message)) return { ok: false, reason: "CODE_INVALID" };
    if (error.code === "CONFLICT") return denyConflict(deps, undefined, "PHONE_ALREADY_BOUND");
    throw error;
  }
  const person = await deps.people.getPerson(lease.personId);
  if (person === undefined) throw new ConnectorError("NOT_FOUND", "the person of the join code no longer exists");
  await deps.audit.append({
    ispId: ispIdOfClock(lease.clockId),
    clockId: lease.clockId,
    decision: "ACTION",
    action: "PHONE_LEASE_CREATED",
    actor: "CHANNEL",
    refs: { personId: lease.personId },
    detail: { hours: LEASE_HOURS },
  });
  return { ok: true, lease, person };
}

/** Releases one phone ("BAJA" from a bound phone). */
export async function releasePhoneLease(lease: PhoneLease, reason: "OPT_OUT" | "WORLD_RESET", deps: Pick<LeaseDeps, "worlds" | "audit">): Promise<void> {
  await deps.worlds.deletePhoneLease(lease.phoneHash);
  await deps.audit.append({
    ispId: ispIdOfClock(lease.clockId),
    clockId: lease.clockId,
    decision: "ACTION",
    action: "PHONE_LEASE_EXPIRED",
    actor: "CHANNEL",
    reason,
    refs: { personId: lease.personId },
  });
}

/** "Reiniciar demo" and the janitor: every lease bound to the world goes. */
export async function releaseWorldLeases(clockId: string, deps: Pick<LeaseDeps, "worlds" | "audit">): Promise<number> {
  const leases = await deps.worlds.listPhoneLeases(clockId);
  for (const lease of leases) await releasePhoneLease(lease, "WORLD_RESET", deps);
  return leases.length;
}
