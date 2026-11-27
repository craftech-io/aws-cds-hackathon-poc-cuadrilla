// What a first passed code leaves behind (ADR-0029): the number becomes the account's, once, and only
// for one account.
//
//   Runtime  PHONEOWNER#<phoneHash> · META   userId: one number, one account (created if absent; a number
//                                           another account verified answers PHONE_IN_USE)
//   Isps     USER#<userId>                  phone, phoneVerifiedAt, only where none was verified yet:
//                                           nobody changes a verified number from a request (the operator
//                                           does it with `console:invite --reset-phone`)
//   Leads    LEAD#<emailHash> · META        phone, phoneVerifiedAt of a sign-up guest's confirmed lead:
//                                           `LeadStream` sends the notice to Craftech on that change
import { ConnectorError, ToolError } from "@cuadrilla/shared";
import { userKey } from "../connector/keys";
import type { Key, TableClient } from "../connector/table-client";
import { ConsoleUser } from "../domain/isps";
import type { LeadStore } from "../leads/store";

export const ownerKey = (phoneHash: string): Key => ({ PK: `PHONEOWNER#${phoneHash}`, SK: "META" });

export const PHONE_IN_USE = (): ToolError => new ToolError("CONFLICT", "this number is already in use by another account", "PHONE_IN_USE");

/** The account that verified this number, if any. */
export async function ownerOf(client: Pick<TableClient, "get">, phoneHash: string): Promise<string | undefined> {
  const item = await client.get("Runtime", ownerKey(phoneHash));
  return typeof item?.userId === "string" ? item.userId : undefined;
}

/** Takes the number for the account; `PHONE_IN_USE` when another account holds it. */
export async function claimNumber(client: Pick<TableClient, "get" | "put">, phoneHash: string, userId: string, now: Date): Promise<void> {
  try {
    await client.put("Runtime", { ...ownerKey(phoneHash), entity: "PhoneOwner", userId, createdAt: now.toISOString() }, { ifNotExists: true });
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    if ((await ownerOf(client, phoneHash)) !== userId) throw PHONE_IN_USE();
  }
}

/** The registry row of the principal, read by its key (consistent), or `undefined`. */
export async function registryUser(client: Pick<TableClient, "get">, ispId: string, userId: string): Promise<ConsoleUser | undefined> {
  const item = await client.get("Isps", userKey(ispId, userId));
  const parsed = item === undefined ? undefined : ConsoleUser.safeParse(item);
  return parsed?.success === true ? parsed.data : undefined;
}

/** The number on the row, only where no number was verified; a concurrent enrolment of the same number is fine. */
export async function recordOnRow(client: Pick<TableClient, "get" | "update">, user: Pick<ConsoleUser, "ispId" | "userId">, phone: string, now: Date): Promise<void> {
  try {
    await client.update("Isps", userKey(user.ispId, user.userId), { phone, phoneVerifiedAt: now.toISOString() }, now.toISOString(), { ifExists: true, absent: ["phoneVerifiedAt"] });
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    const current = await registryUser(client, user.ispId, user.userId);
    if (current?.phone !== phone) throw new ToolError("CONFLICT", "this account already has a verified phone", "PHONE_LOCKED");
  }
}

export interface LeadSide {
  readonly leads: Pick<LeadStore, "get" | "verifyPhone">;
  readonly emailHash: (email: string) => string;
}

/** A sign-up guest's confirmed lead gets the verified number (and with it, the notice). */
export async function recordOnLead(side: LeadSide, who: { readonly sub: string; readonly email: string | undefined }, phone: string, now: Date): Promise<boolean> {
  if (who.email === undefined) return false;
  const emailHash = side.emailHash(who.email);
  return side.leads.verifyPhone(emailHash, { sub: who.sub, phone, at: now });
}
