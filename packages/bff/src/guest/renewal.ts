// A new generation for a sign-up guest (ADR-0025 §2, "Recreación"): when its world expired (7 real days),
// is missing, or collided. One transaction, retried with another suffix while the id is taken:
//
//   Isps     the new operator's META (attribute_not_exists) and, where the caller may, its clock
//   Isps     the registry row moved: created in the new operator, removed from the old one (GSI1 SUB#
//            follows the row), so the next token already carries the new operator
//   Runtime  GUESTACCOUNT# moved to the new generation, only from the one read; the slot of the world
//
// The old generation is never touched again: its items expire by TTL and no query of the new operator
// sees them. Without room, the account moves all the same and waits in `CAP_FULL`.
import { ispKey } from "../connector/keys";
import type { TableClient, TransactOp } from "../connector/table-client";
import { type Generation, generationExists, openGeneration } from "../worlds/guest-lifecycle";
import { GUEST_TEMPLATE, GUEST_WORLD_START_SIM } from "../worlds/template";
import { type GuestAccount, createAccountOp, renewAccountOp } from "./account";
import { type RegistryRow, moveRowOps } from "./registry";
import { type SlotScope, planSlot } from "./slots";

export interface RenewalDeps {
  readonly client: TableClient;
  readonly now: Date;
  readonly scope: SlotScope;
  /**
   * Whether this caller may write the clock (`Runtime/CLOCK#`): the BFF does and creates it with the
   * generation; a trigger does not, and `GuestWorlds` creates it.
   */
  readonly withClock: boolean;
  readonly suffix?: () => string;
}

export interface Renewal {
  readonly generation: Generation;
  readonly status: "PROVISIONING" | "CAP_FULL";
  readonly generationNumber: number;
  readonly slotDay?: string | undefined;
}

export async function renewGeneration(deps: RenewalDeps, input: { readonly row: RegistryRow; readonly account?: GuestAccount | undefined }): Promise<Renewal> {
  const { row, account } = input;
  let decided: Pick<Renewal, "status" | "slotDay"> = { status: "CAP_FULL" };
  const generationNumber = (account?.generation ?? 0) + 1;
  const generation = await openGeneration({
    client: deps.client,
    now: deps.now,
    ...(deps.suffix === undefined ? {} : { suffix: deps.suffix }),
    ...(deps.withClock ? { clock: { pausedSimNow: GUEST_WORLD_START_SIM, template: GUEST_TEMPLATE, ownerUserId: row.userId } } : {}),
    async ops(next) {
      const slot = await planSlot(deps.client, deps.scope, deps.now);
      decided = slot.ok ? { status: "PROVISIONING", slotDay: slot.day } : { status: "CAP_FULL" };
      const moved = { ispId: next.ispId, clockId: next.clockId, generation: generationNumber, status: decided.status, slotDay: decided.slotDay };
      const accountOp: TransactOp =
        account === undefined ? createAccountOp({ userId: row.userId, guestOrigin: "SIGNUP", slotScope: deps.scope, ...moved }, deps.now) : renewAccountOp(account, moved, deps.now);
      return [...moveRowOps(row, next.ispId, deps.now), accountOp, ...(slot.ok ? slot.ops : [])];
    },
    // A trigger may read the operator rows of sign-up generations but not the clocks.
    idTaken: deps.withClock ? (next) => generationExists(deps.client, next) : async (next) => (await deps.client.get("Isps", ispKey(next.ispId))) !== undefined,
  });
  return { generation, generationNumber, ...decided };
}
