// `Runtime/GUESTACCOUNT#<userId>`: a guest's current world (ADR-0025 §2, docs/architecture.md §5). One
// row per guest account, whatever its origin, with no TTL: it outlives the generations of a sign-up
// guest and is deleted with the account (`GuestAccountDeletion`, which reads `clockId` and
// `guestOrigin`). The portada reads it (`guest.world`); the triggers, `GuestWorlds` and
// `guest.retryWorld` move it:
//
//   PROVISIONING ──GuestWorlds──▶ READY
//        │   └────────────────▶ FAILED ──retry──▶ PROVISIONING
//   CAP_FULL (no room under the cap of active sign-up worlds) ──retry with room──▶ PROVISIONING
//
// A sign-up guest gets a new generation (another operator, another clock) when its world expires
// (`expiresAtReal`, 7 real days from its creation) or when a retry finds it expired or collided.
import { z } from "zod";
import { ClockId, ConnectorError, ConsoleUserId, GuestOrigin, GuestWorldStatus, IsoInstant, IspId } from "@cuadrilla/shared";
import { guestAccountKey } from "../leads/guest-accounts";
import type { Item, TableClient, TransactOp, WriteCondition } from "../connector/table-client";
import { type SlotScope, SlotScopeSchema } from "./slots";

export const GUEST_ACCOUNT_ENTITY = "GuestAccount";

/** Real days a sign-up generation lives before the next sign-in recreates it (ADR-0025 §2). */
export const SIGNUP_WORLD_LIFE_DAYS = 7;
const DAY_MS = 86_400_000;

/** Why a world is `FAILED`: a collision needs a new generation, anything else a new attempt at the same one. */
export const WorldFailure = z.enum(["BUILD_FAILED", "GENERATION_COLLISION", "TEMPLATE_INVALID"]);
export type WorldFailure = z.infer<typeof WorldFailure>;

export const GuestAccount = z.looseObject({
  PK: z.string().startsWith("GUESTACCOUNT#"),
  SK: z.literal("META"),
  entity: z.literal(GUEST_ACCOUNT_ENTITY),
  userId: ConsoleUserId,
  guestOrigin: GuestOrigin,
  ispId: IspId,
  clockId: ClockId,
  /** 1 for the first world of the account, one more per recreation. */
  generation: z.int().min(1),
  status: GuestWorldStatus,
  /** Real instant the current generation was opened. */
  createdAtReal: IsoInstant,
  /** Sign-up only: when the current generation stops being the guest's world (7 real days). */
  expiresAtReal: IsoInstant.optional(),
  statusAtReal: IsoInstant,
  failure: WorldFailure.optional(),
  /** The real day (`yymmdd`) whose slot the generation holds; absent while `CAP_FULL`. */
  slotDay: z.string().regex(/^\d{6}$/).optional(),
  /** Whose counters the slots of this account take: the public ones, or the QA seam's (guest/slots.ts). */
  slotScope: SlotScopeSchema.optional(),
  version: z.int().min(1),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
});
export type GuestAccount = z.infer<typeof GuestAccount>;

export interface NewGuestAccount {
  readonly userId: string;
  readonly guestOrigin: GuestOrigin;
  readonly ispId: string;
  readonly clockId: string;
  readonly generation: number;
  readonly status: GuestWorldStatus;
  readonly slotDay?: string | undefined;
  readonly slotScope?: SlotScope | undefined;
}

export function signupWorldExpiry(createdAtReal: Date): Date {
  return new Date(createdAtReal.getTime() + SIGNUP_WORLD_LIFE_DAYS * DAY_MS);
}

export function accountItem(input: NewGuestAccount, now: Date): Item {
  const at = now.toISOString();
  const item = {
    ...guestAccountKey(input.userId),
    entity: GUEST_ACCOUNT_ENTITY,
    userId: input.userId,
    guestOrigin: input.guestOrigin,
    ispId: input.ispId,
    clockId: input.clockId,
    generation: input.generation,
    status: input.status,
    createdAtReal: at,
    ...(input.guestOrigin === "SIGNUP" ? { expiresAtReal: signupWorldExpiry(now).toISOString() } : {}),
    statusAtReal: at,
    ...(input.slotDay === undefined ? {} : { slotDay: input.slotDay }),
    ...(input.slotScope === undefined ? {} : { slotScope: input.slotScope }),
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
  return GuestAccount.parse(item) as Item;
}

/** Creates the account row in a transaction (never over an existing one). */
export function createAccountOp(input: NewGuestAccount, now: Date): TransactOp {
  return { op: "put", table: "Runtime", item: accountItem(input, now), condition: { ifNotExists: true } };
}

/**
 * Moves the account to a new generation, only from the one the caller read (`clockId`), keeping its
 * `createdAt`: the transaction of a recreation carries it with the new registry row.
 */
export function renewAccountOp(current: GuestAccount, next: Omit<NewGuestAccount, "userId" | "guestOrigin" | "slotScope">, now: Date): TransactOp {
  const at = now.toISOString();
  const patch = {
    ispId: next.ispId,
    clockId: next.clockId,
    generation: next.generation,
    status: next.status,
    createdAtReal: at,
    expiresAtReal: current.guestOrigin === "SIGNUP" ? signupWorldExpiry(now).toISOString() : null,
    statusAtReal: at,
    failure: null,
    slotDay: next.slotDay ?? null,
  };
  return { op: "update", table: "Runtime", key: guestAccountKey(current.userId), patch, condition: { equals: { clockId: current.clockId } } };
}

export async function getGuestAccount(client: TableClient, userId: string): Promise<GuestAccount | undefined> {
  const item = await client.get("Runtime", guestAccountKey(userId));
  if (item === undefined) return undefined;
  const parsed = GuestAccount.safeParse(item);
  if (!parsed.success) throw new ConnectorError("VALIDATION", "the guest account row does not match its shape", "Runtime", { cause: parsed.error });
  return parsed.data;
}

export interface StatusChange {
  readonly to: GuestWorldStatus;
  /** The generation the caller acts on: a change for an older one is a CONFLICT. */
  readonly clockId: string;
  /** Only from these states (a stale `GuestWorlds` never turns a new state back). */
  readonly from?: readonly GuestWorldStatus[];
  readonly failure?: WorldFailure;
  readonly slotDay?: string;
}

function statusCondition(change: StatusChange): WriteCondition {
  return change.from === undefined ? { equals: { clockId: change.clockId } } : { equals: { clockId: change.clockId }, oneOf: { status: change.from } };
}

export function statusPatch(change: StatusChange, now: Date): Record<string, unknown> {
  return {
    status: change.to,
    statusAtReal: now.toISOString(),
    failure: change.to === "FAILED" ? (change.failure ?? "BUILD_FAILED") : null,
    ...(change.slotDay === undefined ? {} : { slotDay: change.slotDay }),
  };
}

export function setStatusOp(userId: string, change: StatusChange, now: Date): TransactOp {
  return { op: "update", table: "Runtime", key: guestAccountKey(userId), patch: statusPatch(change, now), condition: statusCondition(change) };
}

/** `false` when the account moved on (another generation, another state) since the caller read it. */
export async function setStatus(client: TableClient, userId: string, change: StatusChange, now: Date): Promise<boolean> {
  try {
    await client.update("Runtime", guestAccountKey(userId), statusPatch(change, now), now.toISOString(), statusCondition(change));
    return true;
  } catch (error) {
    if (error instanceof ConnectorError && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) return false;
    throw error;
  }
}

/** Whether a sign-up generation has run out its 7 real days. */
export function isExpiredAt(account: Pick<GuestAccount, "expiresAtReal">, now: Date): boolean {
  return account.expiresAtReal !== undefined && Date.parse(account.expiresAtReal) <= now.getTime();
}
