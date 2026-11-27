// The SMS code of one session (ADR-0029): six digits from the CSPRNG, of which `Runtime` keeps only the
// HMAC (subkey `phone-code`, bound to the account and the session), for 10 minutes (the TTL and a
// comparison of the date), 5 attempts counted by a conditional increment and compared in constant time.
// The fifth failure invalidates it. A new one is sent at most once a minute.
//
//   Runtime  PHONECODE#<userId>#<sessionKey> · META   digest, purpose, phoneHash, the number while it is
//                                                     being enrolled, attempts, sentAt, codeExpiresAt
import { randomInt } from "node:crypto";
import { ConnectorError } from "@cuadrilla/shared";
import type { Item, Key, TableClient } from "../connector/table-client";
import { keyedDigest, safeEqual } from "../lib/crypto";
import { PHONE_LIMITS } from "./limits";

export type CodePurpose = "ENROL" | "SIGN_IN";

export interface StoredCode {
  readonly purpose: CodePurpose;
  readonly digest: string;
  readonly phoneHash: string;
  /** Only while enrolling: the number the code went to, which becomes the account's on success. */
  readonly phone?: string;
  readonly attempts: number;
  readonly sentAt: string;
  readonly codeExpiresAt: string;
}

export const codeKey = (userId: string, sessionKey: string): Key => ({ PK: `PHONECODE#${userId}#${sessionKey}`, SK: "META" });

/** Six digits, uniformly from the CSPRNG. */
export function newCode(): string {
  return String(randomInt(0, 10 ** PHONE_LIMITS.codeDigits)).padStart(PHONE_LIMITS.codeDigits, "0");
}

export function codeDigest(key: Uint8Array | string, userId: string, sessionKey: string, code: string): string {
  return keyedDigest(key, [userId, sessionKey, code]);
}

function storedOf(item: Item | undefined): StoredCode | undefined {
  if (item === undefined || typeof item.digest !== "string" || typeof item.sentAt !== "string" || typeof item.codeExpiresAt !== "string") return undefined;
  if (item.purpose !== "ENROL" && item.purpose !== "SIGN_IN") return undefined;
  return {
    purpose: item.purpose,
    digest: item.digest,
    phoneHash: typeof item.phoneHash === "string" ? item.phoneHash : "",
    ...(typeof item.phone === "string" ? { phone: item.phone } : {}),
    attempts: typeof item.attempts === "number" ? item.attempts : 0,
    sentAt: item.sentAt,
    codeExpiresAt: item.codeExpiresAt,
  };
}

export async function readCode(client: Pick<TableClient, "get">, key: Key): Promise<StoredCode | undefined> {
  return storedOf(await client.get("Runtime", key));
}

/** When the next code may be sent; `undefined` when it may be sent now. */
export function resendAt(code: Pick<StoredCode, "sentAt"> | undefined, now: Date): Date | undefined {
  if (code === undefined) return undefined;
  const at = new Date(Date.parse(code.sentAt) + PHONE_LIMITS.resendWaitMs);
  return at.getTime() > now.getTime() ? at : undefined;
}

export interface NewCode {
  readonly purpose: CodePurpose;
  readonly digest: string;
  readonly phoneHash: string;
  readonly phone?: string;
}

/**
 * Stores a new code over the one the caller read (`previousSentAt`), or only where none exists: a
 * concurrent send is a CONFLICT, so two sends within the wait never both go out.
 */
export async function storeCode(client: Pick<TableClient, "put">, key: Key, code: NewCode, previousSentAt: string | undefined, now: Date): Promise<void> {
  const expires = now.getTime() + PHONE_LIMITS.codeTtlMs;
  const item: Item = {
    ...key,
    entity: "PhoneCode",
    purpose: code.purpose,
    digest: code.digest,
    phoneHash: code.phoneHash,
    ...(code.phone === undefined ? {} : { phone: code.phone }),
    attempts: 0,
    sentAt: now.toISOString(),
    codeExpiresAt: new Date(expires).toISOString(),
    expiresAt: Math.ceil(expires / 1000),
  };
  await client.put("Runtime", item, previousSentAt === undefined ? { ifNotExists: true } : { equals: { sentAt: previousSentAt } });
}

export type CodeCheck = "MATCH" | "WRONG" | "EXHAUSTED" | "EXPIRED" | "NONE";

/**
 * One attempt: the code must exist and be in time; the attempt is counted (at most 5) BEFORE the
 * comparison, which runs in constant time. A fifth wrong attempt, or one past the ceiling, deletes it.
 */
export async function attemptCode(client: Pick<TableClient, "get" | "increment" | "delete">, key: Key, expected: (code: StoredCode) => string, now: Date): Promise<{ readonly check: CodeCheck; readonly code?: StoredCode; readonly left?: number }> {
  const code = await readCode(client, key);
  if (code === undefined) return { check: "NONE" };
  if (Date.parse(code.codeExpiresAt) <= now.getTime()) {
    await client.delete("Runtime", key);
    return { check: "EXPIRED" };
  }
  let attempts: number;
  try {
    attempts = await client.increment("Runtime", key, "attempts", 1, {
      updatedAt: now.toISOString(),
      max: PHONE_LIMITS.maxAttempts,
      // Only when the row vanished in between: the husk expires with the code it stood for.
      defaults: { entity: "PhoneCode", expiresAt: Math.ceil(Date.parse(code.codeExpiresAt) / 1000) },
    });
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    await client.delete("Runtime", key);
    return { check: "EXHAUSTED" };
  }
  if (safeEqual(code.digest, expected(code))) return { check: "MATCH", code };
  if (attempts >= PHONE_LIMITS.maxAttempts) {
    await client.delete("Runtime", key);
    return { check: "EXHAUSTED" };
  }
  return { check: "WRONG", left: PHONE_LIMITS.maxAttempts - attempts };
}
