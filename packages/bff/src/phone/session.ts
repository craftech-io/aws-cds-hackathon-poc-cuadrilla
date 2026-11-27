// "This session passed the SMS code" (ADR-0029): one `Runtime` row per account and sign-in, keyed by
// the session of the id token (`origin_jti`, kept across refreshes; `auth-<auth_time>` without it),
// living as long as that session can (12 hours from its interactive sign-in). Another password typed,
// on this device or another, is another session and asks for its own code; a refresh is the same
// session and asks for nothing; the sign-out deletes the row.
//
//   Runtime  PHONESESSION#<userId>#<sessionKey> · META   passedAt, expiresAt (TTL)
//
// The gate of the BFF (routers/trpc.ts) reads it on every request and keeps a passed session for a
// minute per container.
import type { Key, TableClient } from "../connector/table-client";
import { sha256Hex } from "../lib/crypto";
import { PHONE_LIMITS } from "./limits";

export interface PhoneSession {
  readonly userId: string;
  /** `Principal.sessionId`. */
  readonly sessionId: string;
  /** Epoch seconds of the interactive sign-in (`auth_time`). */
  readonly authTime: number;
}

/** A fixed-length key for the session id (the id itself never travels further than this hash). */
export const sessionKeyOf = (sessionId: string): string => sha256Hex(sessionId).slice(0, 32);

export const sessionMarkKey = (session: Pick<PhoneSession, "userId" | "sessionId">): Key => ({ PK: `PHONESESSION#${session.userId}#${sessionKeyOf(session.sessionId)}`, SK: "META" });

/** Epoch seconds at which a session of this sign-in ends. */
export const sessionEndsAt = (session: Pick<PhoneSession, "authTime">): number => session.authTime + PHONE_LIMITS.sessionTtlMs / 1000;

export async function markSessionPassed(client: Pick<TableClient, "put">, session: PhoneSession, now: Date): Promise<void> {
  await client.put("Runtime", { ...sessionMarkKey(session), entity: "PhoneSession", userId: session.userId, passedAt: now.toISOString(), expiresAt: Math.ceil(sessionEndsAt(session)) });
}

export async function isSessionPassed(client: Pick<TableClient, "get">, session: Pick<PhoneSession, "userId" | "sessionId">, now: Date): Promise<boolean> {
  const item = await client.get("Runtime", sessionMarkKey(session));
  return item !== undefined && typeof item.expiresAt === "number" && item.expiresAt * 1000 > now.getTime();
}

export async function clearSession(client: Pick<TableClient, "delete">, session: Pick<PhoneSession, "userId" | "sessionId">): Promise<void> {
  await client.delete("Runtime", sessionMarkKey(session));
}

const PASSED_CACHE_MS = 60_000;

export interface SessionGate {
  passed(session: Pick<PhoneSession, "userId" | "sessionId">): Promise<boolean>;
  /** After a sign-out in this container. */
  forget(session: Pick<PhoneSession, "userId" | "sessionId">): void;
}

/** Passed sessions are kept a minute per container; a session that has not passed is read on every request. */
export function createSessionGate(client: Pick<TableClient, "get">, now: () => Date = () => new Date()): SessionGate {
  const cache = new Map<string, number>();
  const keyOf = (session: Pick<PhoneSession, "userId" | "sessionId">) => sessionMarkKey(session).PK;
  return {
    async passed(session) {
      const key = keyOf(session);
      const until = cache.get(key);
      if (until !== undefined && until > now().getTime()) return true;
      const passed = await isSessionPassed(client, session, now());
      if (passed) cache.set(key, now().getTime() + PASSED_CACHE_MS);
      else cache.delete(key);
      return passed;
    },
    forget(session) {
      cache.delete(keyOf(session));
    },
  };
}
