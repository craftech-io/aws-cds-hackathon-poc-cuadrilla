// The account's own phone (ADR-0029): an international E.164 number of any country, `+` and 8 to 15
// digits, typed with or without spaces, dashes, dots or parentheses. Never the simulator's phones
// (`simulator.*`, ADR-0002): this is the real number of the person who signs in.
import { ToolError } from "@cuadrilla/shared";
import { hmacSha256Hex } from "../lib/crypto";

export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** The number without separators; `PHONE_INVALID` for anything that is not E.164 once they are gone. */
export function parseAccountPhone(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 32) throw new ToolError("INVALID", "the phone must be an international number: + and 8 to 15 digits", "PHONE_INVALID");
  const compact = raw.trim().replace(/[\s().-]/g, "");
  if (!E164_PATTERN.test(compact)) throw new ToolError("INVALID", "the phone must be an international number: + and 8 to 15 digits", "PHONE_INVALID");
  return compact;
}

/** What the screen shows of a verified number: only its last digits. */
export function maskPhone(phone: string): string {
  return `•••• ${phone.slice(-4)}`;
}

/** The number's digest under the `account-phone` subkey: the one-number-one-account index and the SMS caps. */
export function accountPhoneHash(key: Uint8Array | string, phone: string): string {
  return hmacSha256Hex(key, phone);
}
