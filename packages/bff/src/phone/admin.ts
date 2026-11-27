// What only the operator does with an account's phone (ADR-0029), never a request: mark an account
// that no person uses and that cannot receive an SMS (the scenario and test runner's) as `phoneCheck
// AUTOMATION`, take the mark away, or reset a verified number (a person who lost their phone) so the
// next session enrols a new one. One account at a time, found by its Cognito `sub` (`Isps` GSI1).
// `console:phone` and `qa:confirm-signup` call it with the operator's profile.
import type { TableClient } from "../connector/table-client";
import { ConsoleUser } from "../domain/isps";
import { rowsBySub } from "../guest/registry";
import { ownerKey } from "./enrolment";
import { accountPhoneHash } from "./number";

export type PhoneAdminAction = "AUTOMATION" | "HUMAN" | "RESET";

export type PhoneAdminOutcome = { readonly outcome: "DONE"; readonly userId: string; readonly ispId: string } | { readonly outcome: "NO_ROW" };

export interface PhoneAdminDeps {
  readonly client: TableClient;
  /** The `account-phone` subkey: only the reset needs it (it deletes the number's index row). */
  readonly phoneKey?: () => Uint8Array | string;
  readonly now: () => Date;
  /** Waits between reads of the index right after a confirmation (it is eventually consistent). */
  readonly wait?: (ms: number) => Promise<void>;
}

const RETRIES_MS = [500, 1_500];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function rowOf(deps: PhoneAdminDeps, sub: string): Promise<ConsoleUser | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    const rows = await rowsBySub(deps.client, sub);
    if (rows.length === 1 && rows[0] !== undefined) {
      const parsed = ConsoleUser.safeParse(rows[0].item);
      return parsed.success ? parsed.data : undefined;
    }
    const delay = RETRIES_MS[attempt];
    if (rows.length > 1 || delay === undefined) return undefined;
    await (deps.wait ?? sleep)(delay);
  }
}

export async function adminPhone(deps: PhoneAdminDeps, sub: string, action: PhoneAdminAction): Promise<PhoneAdminOutcome> {
  const user = await rowOf(deps, sub);
  if (user === undefined) return { outcome: "NO_ROW" };
  const key = { PK: `ISP#${user.ispId}`, SK: `USER#${user.userId}` };
  const at = deps.now().toISOString();
  if (action === "RESET") {
    if (user.phone !== undefined) {
      if (deps.phoneKey === undefined) throw new RangeError("the reset of a phone needs the account-phone subkey");
      await deps.client.delete("Runtime", ownerKey(accountPhoneHash(deps.phoneKey(), user.phone)));
    }
    await deps.client.update("Isps", key, { phone: null, phoneVerifiedAt: null }, at, { ifExists: true });
  } else {
    await deps.client.update("Isps", key, { phoneCheck: action === "AUTOMATION" ? "AUTOMATION" : null }, at, { ifExists: true });
  }
  return { outcome: "DONE", userId: user.userId, ispId: user.ispId };
}
