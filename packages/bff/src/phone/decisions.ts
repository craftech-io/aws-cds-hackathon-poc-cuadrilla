// The security decisions of the SMS code, by name (ADR-0030): every refusal of a send or a check writes
// one line with a fixed `metric` and its `reason`, never a number, a code or an address.
//
//   SmsCapHits         a daily cap of phone/limits.ts (SMS_ACCOUNT_LIMIT, SMS_NUMBER_LIMIT, SMS_IP_LIMIT,
//                      SMS_DAILY_LIMIT, SMS_FOREIGN_LIMIT)
//   PhoneCodeRefused   any other refusal: the number (PHONE_INVALID, PHONE_NOT_PERSONAL,
//                      PHONE_COUNTRY_NOT_ALLOWED, PHONE_IN_USE, PHONE_LOCKED), the code (CODE_EXPIRED,
//                      CODE_EXHAUSTED, CODE_WRONG has its own PhoneCodeWrong), the wait (RESEND_TOO_SOON), the
//                      account (ACCOUNT_BLOCKED, NO_REGISTRY_ROW) or the delivery (SMS_NOT_DELIVERABLE)
//
// The refusal itself travels on unchanged.
import { ToolError } from "@cuadrilla/shared";
import type { Logger } from "../lib/log";

const SMS_CAPS: ReadonlySet<string> = new Set(["SMS_ACCOUNT_LIMIT", "SMS_NUMBER_LIMIT", "SMS_IP_LIMIT", "SMS_DAILY_LIMIT", "SMS_FOREIGN_LIMIT"]);
/** Logged where they happen, with their own metric (phone/flow.ts). */
const LOGGED_ELSEWHERE: ReadonlySet<string> = new Set(["CODE_WRONG", "SMS_UNAVAILABLE"]);

export type PhoneStep = "SEND" | "VERIFY";

export async function withRefusalLog<T>(log: Logger, userId: string, step: PhoneStep, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ToolError) {
      const reason = error.reason ?? error.code;
      if (!LOGGED_ELSEWHERE.has(reason)) {
        const metric = SMS_CAPS.has(reason) ? "SmsCapHits" : "PhoneCodeRefused";
        log.warn("phone.code.refused", { userId, step, reason, metric, value: 1 });
      }
    }
    throw error;
  }
}
