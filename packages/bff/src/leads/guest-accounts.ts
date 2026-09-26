// What the deletion reads and removes of a guest's account outside `Leads` (ADR-0025 §2 and §6,
// docs/architecture.md §5), over the connector's storage primitive (`TableClient`: DynamoDB in a
// Lambda, a map in the tests):
//
//   Isps     ISP#<ispId> · USER#<userId>     the registry row (`role`, `guestOrigin`, `cognitoUsername`,
//                                            `cognitoSub`; GSI1 `cognitoSubKey = SUB#<sub>`)
//   Runtime  GUESTACCOUNT#<userId> · META    the current generation (`clockId`, `guestOrigin`)
//   Runtime  SIGNUPSUB#<sub> · META          uniqueness of the registry per `sub`
//   Runtime  SIGNUPKEY#<abuseHash> · META    `confirmedAccounts` of one person (≤ 2)
//
// The removal is one transaction: the row, `SIGNUPSUB#`, `GUESTACCOUNT#` (only while it exists) and the
// decrement of `SIGNUPKEY#` conditioned on the value read, so a retried deletion never subtracts twice.
import { IspId } from "@cuadrilla/shared";
import { cognitoSubKey, userKey } from "../connector/keys";
import type { Item, TableClient, TransactOp } from "../connector/table-client";

const META = "META";
export const guestAccountKey = (userId: string) => ({ PK: `GUESTACCOUNT#${userId}`, SK: META });
export const signupSubKey = (sub: string) => ({ PK: `SIGNUPSUB#${sub}`, SK: META });
export const signupKeyKey = (abuseHash: string) => ({ PK: `SIGNUPKEY#${abuseHash}`, SK: META });
export const CONFIRMED_ACCOUNTS = "confirmedAccounts";

export interface RegistryUser {
  readonly ispId: string;
  readonly userId: string;
  readonly role: string;
  readonly guestOrigin?: string | undefined;
  readonly cognitoUsername?: string | undefined;
  readonly cognitoSub?: string | undefined;
}

export interface GuestAccount {
  readonly userId: string;
  readonly clockId: string;
  readonly guestOrigin?: string | undefined;
}

export interface AccountRemoval {
  readonly user?: Pick<RegistryUser, "ispId" | "userId"> | undefined;
  readonly sub?: string | undefined;
  /** The `GUESTACCOUNT#` to delete (the anchor of the decrement). */
  readonly accountUserId?: string | undefined;
  /** Subtract one confirmed account of this person, from the value read. */
  readonly signupKey?: { readonly abuseHash: string; readonly current: number } | undefined;
}

export interface GuestAccountPorts {
  getGuestAccount(userId: string): Promise<GuestAccount | undefined>;
  getRegistryUser(ispId: string, userId: string): Promise<RegistryUser | undefined>;
  /** The single registry row of a `sub`; `undefined` when none or more than one. */
  findRegistryUserBySub(sub: string): Promise<RegistryUser | undefined>;
  getConfirmedAccounts(abuseHash: string): Promise<number | undefined>;
  /** All or nothing; `CONFLICT` when the state changed since it was read. */
  removeAccount(removal: AccountRemoval, at: Date): Promise<void>;
}

const text = (item: Item, name: string): string | undefined => {
  const value = item[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

function registryUserOf(item: Item): RegistryUser | undefined {
  const ispId = text(item, "ispId");
  const userId = text(item, "userId");
  const role = text(item, "role");
  if (ispId === undefined || userId === undefined || role === undefined) return undefined;
  return { ispId, userId, role, guestOrigin: text(item, "guestOrigin"), cognitoUsername: text(item, "cognitoUsername"), cognitoSub: text(item, "cognitoSub") };
}

export function createGuestAccountPorts(client: TableClient): GuestAccountPorts {
  return {
    async getGuestAccount(userId) {
      const item = await client.get("Runtime", guestAccountKey(userId));
      const clockId = item === undefined ? undefined : text(item, "clockId");
      return item === undefined || clockId === undefined ? undefined : { userId, clockId, guestOrigin: text(item, "guestOrigin") };
    },

    async getRegistryUser(ispId, userId) {
      const item = await client.get("Isps", userKey(ispId, userId));
      return item === undefined ? undefined : registryUserOf(item);
    },

    async findRegistryUserBySub(sub) {
      if (sub === "") return undefined;
      const rows = await client.query("Isps", { index: "GSI1", hashValue: cognitoSubKey(sub), limit: 2 });
      const users = rows.map(registryUserOf).filter((user): user is RegistryUser => user !== undefined);
      return users.length === 1 ? users[0] : undefined;
    },

    async getConfirmedAccounts(abuseHash) {
      const item = await client.get("Runtime", signupKeyKey(abuseHash));
      const value = item?.[CONFIRMED_ACCOUNTS];
      return typeof value === "number" ? value : undefined;
    },

    async removeAccount(removal, at) {
      const ops: TransactOp[] = [];
      if (removal.user !== undefined) ops.push({ op: "delete", table: "Isps", key: userKey(removal.user.ispId, removal.user.userId) });
      if (removal.sub !== undefined) ops.push({ op: "delete", table: "Runtime", key: signupSubKey(removal.sub) });
      if (removal.accountUserId !== undefined) {
        ops.push({ op: "delete", table: "Runtime", key: guestAccountKey(removal.accountUserId), condition: { ifExists: true } });
        const key = removal.signupKey;
        if (key !== undefined && key.current > 0) {
          ops.push({ op: "update", table: "Runtime", key: signupKeyKey(key.abuseHash), patch: { [CONFIRMED_ACCOUNTS]: key.current - 1 }, condition: { equals: { [CONFIRMED_ACCOUNTS]: key.current } } });
        }
      }
      if (ops.length > 0) await client.transact(ops, at.toISOString());
    },
  };
}

const GUEST_CLOCK_PREFIX = "GUEST#";

/** The operator of a guest generation's clock (`GUEST#isp-guest-s…` → `isp-guest-s…`); `undefined` for any other clock. */
export function ispOfGeneration(account: Pick<GuestAccount, "clockId">): string | undefined {
  if (!account.clockId.startsWith(GUEST_CLOCK_PREFIX)) return undefined;
  const ispId = account.clockId.slice(GUEST_CLOCK_PREFIX.length);
  return ispId.startsWith("isp-guest-") && IspId.safeParse(ispId).success ? ispId : undefined;
}
