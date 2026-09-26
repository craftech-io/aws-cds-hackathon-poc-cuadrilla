// Fixtures of the deletion tests (leads/deletion.test.ts, handlers/guest-account-deletion.test.ts,
// routers/account.test.ts): a memory `Leads` table and a memory `TableClient` for `Isps` and `Runtime`,
// recorded Cognito calls and world destructions, and the rows post-confirmation leaves for a guest of
// the own sign-up or an internal account. Never imported by a Lambda.
import { MemoryTableClient } from "../connector/memory/table-client";
import { createLogger } from "../lib/log";
import type { CognitoUsers } from "./cognito-users";
import type { DeletionDeps } from "./deletion";
import { CONFIRMED_ACCOUNTS, type GuestAccount, createGuestAccountPorts, guestAccountKey, signupKeyKey, signupSubKey } from "./guest-accounts";
import type { MemoryLeadTable } from "./memory-table";
import type { LeadStore } from "./store";
import { T0, confirmedLead, hashOf, leadHarness, signupUserId } from "./testing";

export const EMAIL = "ana.prueba@example.com";
export const GENERATION = { ispId: "isp-guest-s261001abcde", clockId: "GUEST#isp-guest-s261001abcde" };
export const SUB = "sub-0001";

export interface World {
  readonly table: MemoryLeadTable;
  readonly store: LeadStore;
  readonly data: MemoryTableClient;
  readonly deps: DeletionDeps;
  readonly cognitoCalls: string[];
  readonly destroyed: GuestAccount[];
  readonly lines: string[];
}

export function world(): World {
  const { table, store } = leadHarness();
  const data = new MemoryTableClient();
  const cognitoCalls: string[] = [];
  const destroyed: GuestAccount[] = [];
  const lines: string[] = [];
  const cognito: Pick<CognitoUsers, "deleteUser"> = {
    async deleteUser(name) {
      cognitoCalls.push(name);
      return "DELETED";
    },
  };
  const deps: DeletionDeps = {
    leads: store,
    accounts: createGuestAccountPorts(data),
    cognito,
    worlds: { destroyGeneration: async (account) => void destroyed.push(account) },
    emailHash: hashOf,
    now: () => T0,
    log: createLogger({ level: "debug", sink: (line) => lines.push(line) }),
  };
  return { table, store, data, deps, cognitoCalls, destroyed, lines };
}

const at = T0.toISOString();

/** What post-confirmation leaves for a guest of the own sign-up (ADR-0025 §1). */
export async function signupGuest(w: World, options: { readonly userId?: string; readonly sub?: string; readonly user?: number } = {}): Promise<void> {
  const userId = options.userId ?? signupUserId(1);
  const sub = options.sub ?? SUB;
  const lead = await confirmedLead(w.store, { sub, userId, user: options.user ?? 1 });
  await w.data.put("Isps", { PK: `ISP#${GENERATION.ispId}`, SK: `USER#${userId}`, entity: "ConsoleUser", ispId: GENERATION.ispId, userId, role: "GUEST", guestOrigin: "SIGNUP", cognitoUsername: lead.cognitoUsername, cognitoSub: sub, cognitoSubKey: `SUB#${sub}`, name: "Invitado", active: true, version: 1, createdAt: at, updatedAt: at });
  await w.data.put("Runtime", { ...guestAccountKey(userId), entity: "GuestAccount", guestOrigin: "SIGNUP", clockId: GENERATION.clockId, generation: 1, status: "READY", version: 1, createdAt: at, updatedAt: at });
  await w.data.put("Runtime", { ...signupSubKey(sub), entity: "SignupSub", userId, version: 1, createdAt: at, updatedAt: at });
  await w.data.put("Runtime", { ...signupKeyKey(lead.abuseHash), entity: "SignupKey", [CONFIRMED_ACCOUNTS]: 1, version: 1, createdAt: at, updatedAt: at });
}

/** An internal or invited account: a registry row and, for a guest, its world; never a lead. */
export async function otherAccount(w: World, row: { readonly ispId: string; readonly userId: string; readonly role: string; readonly guestOrigin?: string; readonly cognitoUsername: string }): Promise<void> {
  await w.data.put("Isps", { PK: `ISP#${row.ispId}`, SK: `USER#${row.userId}`, entity: "ConsoleUser", ...row, cognitoSub: `sub-${row.userId}`, cognitoSubKey: `SUB#sub-${row.userId}`, name: "Interno", active: true, version: 1, createdAt: at, updatedAt: at });
  if (row.role === "GUEST") await w.data.put("Runtime", { ...guestAccountKey(row.userId), entity: "GuestAccount", guestOrigin: row.guestOrigin, clockId: `GUEST#${row.ispId}`, version: 1, createdAt: at, updatedAt: at });
}
