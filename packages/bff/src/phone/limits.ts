// Every number of the SMS code (ADR-0029), in one place: the code itself, its resend wait and the daily
// caps of what an SMS costs. The caps are counters of `Runtime` with the same mechanism as the own
// sign-up's (signup/limits.ts): an `increment` with a ceiling inside a transaction, a TTL past its day,
// and no phone, IP or email in clear in any key (`phoneHash` with the `account-phone` subkey, `ipHash`
// with `ip-hash`).
//
//   PHONESMS#ACCOUNT#<userId>#<realDay>      6 SMS per account per day (enrolment and sign-ins)   SMS_ACCOUNT_LIMIT
//   PHONESMS#NUMBER#<phoneHash>#<realDay>    3 SMS per number per day                             SMS_NUMBER_LIMIT
//   PHONESMS#IP#<ipHash>#<realDay>           5 SMS per viewer IP per day                          SMS_IP_LIMIT
//   PHONESMS#GLOBAL#<realDay>                150 SMS per day in the stage                         SMS_DAILY_LIMIT
//
// The account's, the number's and the IP's counters move together (all or none); the stage's day after
// them, so a caller over its own limit never takes a place of the day.
import { ToolError } from "@cuadrilla/shared";
import type { TableClient } from "../connector/table-client";
import { type CounterSpec, SIGNUP_COUNTER, counterIncrementOp, endOfDay, isFull, numberOf, realDay } from "../signup/limits";

export const PHONE_LIMITS = {
  codeDigits: 6,
  codeTtlMs: 10 * 60_000,
  maxAttempts: 5,
  resendWaitMs: 60_000,
  smsPerAccountPerDay: 6,
  smsPerNumberPerDay: 3,
  smsPerIpPerDay: 5,
  smsPerDay: 150,
  /** A passed session lives as long as the console's refresh token (infra/auth-email.ts, 12 hours). */
  sessionTtlMs: 12 * 3_600_000,
} as const;

const COUNTER_ENTITY = "PhoneSmsCounter";
const PREFIX = "PHONESMS#";

export interface SmsKeys {
  readonly userId: string;
  readonly phoneHash: string;
  readonly ipHash: string;
}

export type SmsLimitReason = "SMS_ACCOUNT_LIMIT" | "SMS_NUMBER_LIMIT" | "SMS_IP_LIMIT" | "SMS_DAILY_LIMIT";

const MESSAGES: Readonly<Record<SmsLimitReason, string>> = {
  SMS_ACCOUNT_LIMIT: "this account received all the codes it can get today",
  SMS_NUMBER_LIMIT: "this number received all the codes it can get today",
  SMS_IP_LIMIT: "this connection asked for all the codes it can get today",
  SMS_DAILY_LIMIT: "no more codes can be sent today",
};

export const smsLimitError = (reason: SmsLimitReason): ToolError => new ToolError("CAP_REACHED", MESSAGES[reason], reason);

/** The caller's three counters of one day, in the order a full one is reported. */
export function callerCounters(keys: SmsKeys, at: Date): ReadonlyArray<CounterSpec & { readonly reason: SmsLimitReason }> {
  const day = realDay(at);
  const end = endOfDay(at);
  return [
    { key: `${PREFIX}ACCOUNT#${keys.userId}#${day}`, limit: PHONE_LIMITS.smsPerAccountPerDay, periodEndsAt: end, reason: "SMS_ACCOUNT_LIMIT" },
    { key: `${PREFIX}NUMBER#${keys.phoneHash}#${day}`, limit: PHONE_LIMITS.smsPerNumberPerDay, periodEndsAt: end, reason: "SMS_NUMBER_LIMIT" },
    { key: `${PREFIX}IP#${keys.ipHash}#${day}`, limit: PHONE_LIMITS.smsPerIpPerDay, periodEndsAt: end, reason: "SMS_IP_LIMIT" },
  ];
}

export const smsDayKey = (at: Date): string => `${PREFIX}GLOBAL#${realDay(at)}`;

/** Which of the caller's counters is full (read after its transaction failed). */
async function fullCounter(client: Pick<TableClient, "get">, specs: ReturnType<typeof callerCounters>): Promise<SmsLimitReason> {
  for (const spec of specs) {
    if (numberOf(await client.get("Runtime", { PK: spec.key, SK: "META" }), SIGNUP_COUNTER) >= spec.limit) return spec.reason;
  }
  return "SMS_ACCOUNT_LIMIT";
}

/** One SMS: the caller's counters together, then the stage's day. Throws the typed refusal of the first full one. */
export async function reserveSms(client: Pick<TableClient, "transact" | "get">, keys: SmsKeys, at: Date): Promise<void> {
  const iso = at.toISOString();
  const specs = callerCounters(keys, at);
  try {
    await client.transact(
      specs.map((spec) => counterIncrementOp(spec, at, COUNTER_ENTITY)),
      iso,
    );
  } catch (error) {
    if (isFull(error)) throw smsLimitError(await fullCounter(client, specs));
    throw error;
  }
  try {
    await client.transact([counterIncrementOp({ key: smsDayKey(at), limit: PHONE_LIMITS.smsPerDay, periodEndsAt: endOfDay(at) }, at, COUNTER_ENTITY)], iso);
  } catch (error) {
    if (isFull(error)) throw smsLimitError("SMS_DAILY_LIMIT");
    throw error;
  }
}
