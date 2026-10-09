// `guest.forceExpire` of the QA seam (ADR-0025 §7, `SC-20/6`), run by `GuestWorlds`, which owns the
// account rows: the QaDriver's role is denied every `GUESTACCOUNT#` write by IAM (infra/qa-driver-fence.ts)
// and invokes it with `{op: QA_FORCE_EXPIRE, userId}`. Only an account of the own sign-up whose slots count
// in a QA run's room (`slotScope QA#qa-<run>`, decided by the server from the lead's address,
// guest/slots.ts) is touched, and only its `expiresAtReal`, conditioned on what was read: the next sign-in
// (post authentication) recreates the world by the same path as a visitor's.
import { z } from "zod";
import { ConnectorError, ToolError } from "@cuadrilla/shared";
import type { TableClient } from "../connector/table-client";
import { guestAccountKey } from "../leads/guest-accounts";
import { SignupUserId } from "../leads/model";
import { getGuestAccount } from "./account";

export const QA_FORCE_EXPIRE = "QA_FORCE_EXPIRE";
export const QaForceExpireRequest = z.object({ op: z.literal(QA_FORCE_EXPIRE), userId: SignupUserId }).strict();
export type QaForceExpireRequest = z.infer<typeof QaForceExpireRequest>;

/** How far in the past the generation ends: already expired for the next sign-in. */
const EXPIRED_AGO_MS = 60_000;

export const QaForceExpireAnswer = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("EXPIRED"), userId: SignupUserId, clockId: z.string().min(1), expiresAtReal: z.iso.datetime() }).strict(),
  z.object({ outcome: z.literal("REFUSED"), reason: z.enum(["NO_ACCOUNT", "NOT_A_QA_ACCOUNT"]) }).strict(),
]);
export type QaForceExpireOutcome = z.infer<typeof QaForceExpireAnswer>;

export function isQaForceExpire(event: unknown): boolean {
  return typeof event === "object" && event !== null && (event as { op?: unknown }).op === QA_FORCE_EXPIRE;
}

export async function forceExpireQaAccount(client: TableClient, raw: unknown, now: Date): Promise<QaForceExpireOutcome> {
  const parsed = QaForceExpireRequest.safeParse(raw);
  if (!parsed.success) throw new ToolError("INVALID", "QA_FORCE_EXPIRE takes {op, userId} of a sign-up account and nothing else");
  const { userId } = parsed.data;
  const account = await getGuestAccount(client, userId);
  if (account === undefined) return { outcome: "REFUSED", reason: "NO_ACCOUNT" };
  if (account.guestOrigin !== "SIGNUP" || account.slotScope === undefined || account.slotScope === "PUBLIC") return { outcome: "REFUSED", reason: "NOT_A_QA_ACCOUNT" };
  const expiresAtReal = new Date(now.getTime() - EXPIRED_AGO_MS).toISOString();
  try {
    await client.update("Runtime", guestAccountKey(userId), { expiresAtReal }, now.toISOString(), { equals: { guestOrigin: "SIGNUP", slotScope: account.slotScope, clockId: account.clockId } });
  } catch (error) {
    if (error instanceof ConnectorError && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) return { outcome: "REFUSED", reason: "NO_ACCOUNT" };
    throw error;
  }
  return { outcome: "EXPIRED", userId, clockId: account.clockId, expiresAtReal };
}
