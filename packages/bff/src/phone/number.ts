// The account's own phone (ADR-0029): an international E.164 number of any country, `+` and 8 to 15
// digits, typed with or without spaces, dashes, dots or parentheses. Never the simulator's phones
// (`simulator.*`, ADR-0002): this is the real number of the person who signs in.
//
// Hardening of 2026-11-27 (ADR-0029 §1): a number that ends in seven or more equal digits is filler
// (`PHONE_INVALID`); a range that is not a person's mobile (machines, personal numbering, international
// networks, satellites) is refused when the number is typed or corrected (`PHONE_NOT_PERSONAL`). Every
// country is still accepted, but a number outside the home region shares a small daily SMS quota of the
// whole demo (phone/limits.ts). The two lists of prefixes live only here.
import { ToolError } from "@cuadrilla/shared";
import { hmacSha256Hex } from "../lib/crypto";

export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Seven or more equal digits at the end: `+5491100000000`. */
const FILLER_PATTERN = /(\d)\1{6}$/;

/** Ranges that are not a person's mobile: refused with "use a personal mobile phone". */
export const NON_PERSONAL_PREFIXES: readonly string[] = [
  "+3197", // machine-to-machine numbers, Netherlands
  "+4470", // personal numbering, United Kingdom
  "+882", // international networks
  "+883", // international networks
  "+870", // satellite
  "+881", // satellite
  "+888",
  "+979",
];

/** The home region: Latin America and Spain. Any other country shares the foreign SMS quota. */
export const HOME_PREFIXES: readonly string[] = [
  "+54", // Argentina
  "+55", // Brazil
  "+56", // Chile
  "+57", // Colombia
  "+52", // Mexico
  "+51", // Peru
  "+598", // Uruguay
  "+595", // Paraguay
  "+591", // Bolivia
  "+593", // Ecuador
  "+58", // Venezuela
  "+506", // Costa Rica
  "+507", // Panama
  "+502", // Guatemala
  "+503", // El Salvador
  "+504", // Honduras
  "+505", // Nicaragua
  "+1809", // Dominican Republic
  "+1829", // Dominican Republic
  "+1849", // Dominican Republic
  "+34", // Spain
];

const invalid = (): ToolError => new ToolError("INVALID", "the phone must be an international number: + and 8 to 15 digits", "PHONE_INVALID");

const startsWithAny = (phone: string, prefixes: readonly string[]): boolean => prefixes.some((prefix) => phone.startsWith(prefix));

/**
 * The number without separators; `PHONE_INVALID` for anything that is not E.164 once they are gone or
 * that is filler, `PHONE_NOT_PERSONAL` for a range that is not a person's mobile.
 */
export function parseAccountPhone(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 32) throw invalid();
  const compact = raw.trim().replace(/[\s().-]/g, "");
  if (!E164_PATTERN.test(compact) || FILLER_PATTERN.test(compact)) throw invalid();
  if (startsWithAny(compact, NON_PERSONAL_PREFIXES)) throw new ToolError("INVALID", "use a personal mobile phone", "PHONE_NOT_PERSONAL");
  return compact;
}

/** True for a number of the home region (it does not take the foreign SMS quota). */
export function isHomeNumber(phone: string): boolean {
  return startsWithAny(phone, HOME_PREFIXES);
}

/** What the screen shows of a verified number: only its last digits. */
export function maskPhone(phone: string): string {
  return `•••• ${phone.slice(-4)}`;
}

/** The number's digest under the `account-phone` subkey: the one-number-one-account index and the SMS caps. */
export function accountPhoneHash(key: Uint8Array | string, phone: string): string {
  return hmacSha256Hex(key, phone);
}
