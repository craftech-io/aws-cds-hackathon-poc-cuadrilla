// The SMS code of the session (ADR-0029, docs/landing-spec.md §7.10) without React: the contract of the
// `phone` procedures checked with zod at the edge, the refusals the screen explains and the countdown of
// the resend. Tested in phone-model.test.ts.
import { z } from "zod";
import { toApiError } from "../../lib/api-error";

export const PHONE_PROCEDURES = { status: "phone.status", send: "phone.sendCode", verify: "phone.verifyCode", end: "phone.endSession" } as const;

/** What the four procedures answer (packages/bff/src/routers/phone.ts). */
export const PhoneStatus = z.object({
  state: z.enum(["PASSED", "ENROL", "SIGN_IN"]),
  phone: z.string().optional(),
  maskedPhone: z.string().optional(),
  codeSent: z.boolean(),
  codeExpiresAt: z.string().optional(),
  resendAt: z.string().optional(),
});
export type PhoneStatus = z.infer<typeof PhoneStatus>;

export const PHONE_ERRORS = [
  "PHONE_INVALID",
  "PHONE_REQUIRED",
  "PHONE_IN_USE",
  "PHONE_LOCKED",
  "RESEND_TOO_SOON",
  "CODE_INVALID",
  "CODE_WRONG",
  "CODE_EXPIRED",
  "CODE_EXHAUSTED",
  "SMS_ACCOUNT_LIMIT",
  "SMS_NUMBER_LIMIT",
  "SMS_IP_LIMIT",
  "SMS_DAILY_LIMIT",
  "SMS_NOT_DELIVERABLE",
  "UNAVAILABLE",
] as const;
export type PhoneErrorCode = (typeof PHONE_ERRORS)[number];

const KNOWN: ReadonlySet<string> = new Set(PHONE_ERRORS);

/** The BFF's `reason` of a refused call, as the screen explains it; anything else is `UNAVAILABLE`. */
export function phoneErrorOf(error: unknown): PhoneErrorCode {
  const reason = toApiError(error).reason;
  return reason !== null && KNOWN.has(reason) ? (reason as PhoneErrorCode) : "UNAVAILABLE";
}

/** The phone as typed, without spaces, dashes, dots or parentheses. */
export function compactPhone(raw: string): string {
  return raw.trim().replace(/[\s().-]/g, "");
}

/** `+` and 8 to 15 digits, any country. */
export function looksLikePhone(raw: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(compactPhone(raw));
}

/** Six digits once the spaces are gone; `undefined` otherwise. */
export function codeOf(raw: string): string | undefined {
  const digits = raw.replace(/\s/g, "");
  return /^\d{6}$/.test(digits) ? digits : undefined;
}

/** Whole seconds left until `iso` (0 once it passed, or without it). */
export function secondsUntil(iso: string | undefined, nowMs: number): number {
  if (iso === undefined) return 0;
  return Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 1000));
}

/** `0:45` / `1:00`. */
export function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
