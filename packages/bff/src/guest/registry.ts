// The guest's row of the registry (`Isps/USER#<userId>`, the only source of a token's operator and role)
// and the rows that make a sign-up unique (ADR-0025 §1-§3):
//
//   Isps     ISP#<generation> · USER#usr-g<ULID>   role GUEST, guestOrigin SIGNUP, cognitoUsername gst-<ULID>,
//                                                 cognitoSub; GSI1 SUB#<sub>; no TTL (it moves with the
//                                                 generation and outlives it)
//   Runtime  SIGNUPSUB#<sub> · META               one registry per Cognito `sub`, created with the row
//   Runtime  SIGNUPKEY#<abuseHash> · META          `confirmedAccounts` of one person: 2 at most, read by
//                                                 signup.start and the pre sign-up, and the increment
//                                                 itself carries the ceiling
//
// A sign-up guest's console user shares the ULID of its Cognito user: `gst-<ULID>` → `usr-g<ULID>`, so a
// retried confirmation always names the same user.
import { type GuestOrigin, clockIdOfIsp, guestOriginOfIsp } from "@cuadrilla/shared";
import { ConsoleUser } from "../domain/isps";
import { cognitoSubKey, userKey } from "../connector/keys";
import { createRepoContext, entityRow } from "../connector/dynamo/repo";
import type { Item, TableClient, TransactOp } from "../connector/table-client";
import { signupKeyKey, signupSubKey, CONFIRMED_ACCOUNTS } from "../leads/guest-accounts";
import { SIGNUP_USERNAME_PATTERN, SIGNUP_USER_ID_PATTERN } from "../leads/model";
import { SIGNUP_LIMITS } from "../signup/limits";

/** Visible name of a sign-up guest's console user: a fixed word, never what the visitor typed. */
export const SIGNUP_GUEST_NAME = "Invitado";

/** `usr-g<ULID>` of the Cognito user `gst-<ULID>`; throws for any other user name. */
export function signupUserIdOf(username: string): string {
  if (!SIGNUP_USERNAME_PATTERN.test(username)) throw new RangeError("not a user of the own sign-up");
  const userId = `usr-g${username.slice("gst-".length)}`;
  if (!SIGNUP_USER_ID_PATTERN.test(userId)) throw new RangeError("not a user of the own sign-up");
  return userId;
}

/** A registry row as the guest flows read it (a `ConsoleUser` of `Isps`). */
export interface RegistryRow {
  readonly ispId: string;
  readonly userId: string;
  readonly role: string;
  readonly guestOrigin?: GuestOrigin | undefined;
  readonly cognitoSub: string;
  readonly cognitoUsername?: string | undefined;
  readonly item: Item;
}

/** A stored `ConsoleUser` item as a registry row; `undefined` for anything else. */
export function registryRowOf(item: Item): RegistryRow | undefined {
  const parsed = ConsoleUser.safeParse(item);
  if (!parsed.success) return undefined;
  const user = parsed.data;
  return { ispId: user.ispId, userId: user.userId, role: user.role, guestOrigin: user.guestOrigin, cognitoSub: user.cognitoSub, cognitoUsername: user.cognitoUsername, item };
}

/** Every registry row the `SUB#<sub>` index lists (eventually consistent: at most a few). */
export async function rowsBySub(client: TableClient, sub: string): Promise<RegistryRow[]> {
  if (sub === "") return [];
  const items = await client.query("Isps", { index: "GSI1", hashValue: cognitoSubKey(sub), limit: 3 });
  return items.map(registryRowOf).filter((row): row is RegistryRow => row !== undefined);
}

/** The origin of a guest's row: its own field, or the one its operator's id says (rows seeded before it). */
export function originOf(row: Pick<RegistryRow, "guestOrigin" | "ispId">): GuestOrigin | undefined {
  return row.guestOrigin ?? guestOriginOfIsp(row.ispId);
}

export interface NewSignupRow {
  readonly ispId: string;
  readonly userId: string;
  readonly sub: string;
  readonly username: string;
}

/** The registry row of a sign-up guest in a generation, created only where none exists. */
export function signupRowOp(client: TableClient, input: NewSignupRow, now: Date): TransactOp {
  const ctx = createRepoContext(client, { now: () => now });
  const row = entityRow(ctx, ConsoleUser, "ConsoleUser", {
    ispId: input.ispId,
    userId: input.userId,
    role: "GUEST",
    name: SIGNUP_GUEST_NAME,
    cognitoSub: input.sub,
    active: true,
    guestOrigin: "SIGNUP",
    cognitoUsername: input.username,
  });
  return { op: "put", table: "Isps", item: row.item, condition: { ifNotExists: true } };
}

/** The same row moved to another generation: the new one created, the old one removed, in one transaction. */
export function moveRowOps(row: RegistryRow, toIspId: string, now: Date): TransactOp[] {
  const moved: Item = { ...row.item, ...userKey(toIspId, row.userId), ispId: toIspId, updatedAt: now.toISOString(), version: 1 };
  return [
    { op: "put", table: "Isps", item: moved, condition: { ifNotExists: true } },
    { op: "delete", table: "Isps", key: userKey(row.ispId, row.userId), condition: { ifExists: true } },
  ];
}

/** `SIGNUPSUB#<sub>`: the uniqueness of the registry per `sub`, with who it belongs to. */
export function signupSubOp(input: { readonly sub: string; readonly userId: string; readonly username: string }, now: Date): TransactOp {
  const item: Item = { ...signupSubKey(input.sub), entity: "SignupSub", sub: input.sub, userId: input.userId, username: input.username, createdAt: now.toISOString() };
  return { op: "put", table: "Runtime", item, condition: { ifNotExists: true } };
}

export interface SignupSub {
  readonly userId: string;
  readonly username: string;
}

export async function getSignupSub(client: TableClient, sub: string): Promise<SignupSub | undefined> {
  const item = await client.get("Runtime", signupSubKey(sub));
  if (item === undefined) return undefined;
  return { userId: typeof item.userId === "string" ? item.userId : "", username: typeof item.username === "string" ? item.username : "" };
}

/**
 * One more confirmed account of a person (`GuestAccountDeletion` gives it back), never past the two of
 * ADR-0025 §3: a transaction that would pass it fails as a whole (CONFLICT).
 */
export function confirmedAccountOp(abuseHash: string, now: Date): TransactOp {
  return {
    op: "increment",
    table: "Runtime",
    key: signupKeyKey(abuseHash),
    attribute: CONFIRMED_ACCOUNTS,
    by: 1,
    max: SIGNUP_LIMITS.confirmedAccountsPerPerson,
    defaults: { entity: "SignupKey", createdAt: now.toISOString() },
  };
}

/** The clock of a registry row's operator. */
export function clockOfRow(row: Pick<RegistryRow, "ispId">): string {
  return clockIdOfIsp(row.ispId);
}
