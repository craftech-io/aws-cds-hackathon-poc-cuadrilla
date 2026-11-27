// The operator's block of one account (ADR-0029 §11), never a request. An id token is verified offline
// and lives 15 minutes, and a disabled Cognito user keeps it: disabling the user alone leaves its
// sessions open, with their SMS pass. So the block, in this order:
//
//   1. `blockedAt` on the registry row (`Isps/USER#`): every procedure of the account's sessions, the
//      SMS code's included, answers `ACCOUNT_BLOCKED` (routers/trpc.ts, phone/flow.ts); no SMS goes out
//   2. the user disabled in Cognito (no new sign-in) and signed out everywhere (no refresh)
//   3. every passed session of the SMS code and every code still out, deleted (phone/session.ts)
//
// The unblock clears `blockedAt` and enables the user again; the person signs in and passes a new code.
// `console:block` calls it with the operator's profile, one account at a time.
import type { TableClient } from "../connector/table-client";
import { type PhoneAdminDeps, registryRowOf } from "./admin";
import { clearAllSessions } from "./session";

export type BlockAction = "BLOCK" | "UNBLOCK";

/** What the block needs from Cognito, by the Cognito user name. */
export interface CognitoAccounts {
  disable(username: string): Promise<void>;
  enable(username: string): Promise<void>;
  /** Revokes every refresh token of the user. */
  signOutEverywhere(username: string): Promise<void>;
}

export interface BlockDeps extends Pick<PhoneAdminDeps, "wait" | "now"> {
  readonly client: TableClient;
  readonly cognito: CognitoAccounts;
}

export interface BlockTarget {
  readonly username: string;
  readonly sub: string;
}

export type BlockOutcome =
  | { readonly outcome: "BLOCKED"; readonly userId: string; readonly ispId: string; readonly sessionsCleared: number }
  | { readonly outcome: "UNBLOCKED"; readonly userId: string; readonly ispId: string }
  | { readonly outcome: "NO_ROW" };

export async function blockAccount(deps: BlockDeps, target: BlockTarget, action: BlockAction): Promise<BlockOutcome> {
  const user = await registryRowOf(deps, target.sub);
  if (user === undefined) return { outcome: "NO_ROW" };
  const key = { PK: `ISP#${user.ispId}`, SK: `USER#${user.userId}` };
  const at = deps.now().toISOString();
  if (action === "UNBLOCK") {
    await deps.client.update("Isps", key, { blockedAt: null }, at, { ifExists: true });
    await deps.cognito.enable(target.username);
    return { outcome: "UNBLOCKED", userId: user.userId, ispId: user.ispId };
  }
  await deps.client.update("Isps", key, { blockedAt: user.blockedAt ?? at }, at, { ifExists: true });
  await deps.cognito.disable(target.username);
  await deps.cognito.signOutEverywhere(target.username);
  const sessionsCleared = await clearAllSessions(deps.client, user.userId);
  return { outcome: "BLOCKED", userId: user.userId, ispId: user.ispId, sessionsCleared };
}
