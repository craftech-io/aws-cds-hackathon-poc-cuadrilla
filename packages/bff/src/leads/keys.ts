// The keys a lead is found by (ADR-0025 §3, ADR-0026). Both are HMACs with the `email-hash` subkey, so
// neither the table nor a counter ever holds an address in clear:
//
//   emailHash  of the exact address (lower-case, trimmed): the lead's key `LEAD#<emailHash>`
//   abuseHash  of a reduced form that folds the aliases of one mailbox (`+tag`, Gmail's dots,
//              `googlemail.com`): the per-person limits and the confirmed accounts per person
//
// The lead's origin (`WEB` | `QA`) is decided here from the address alone, never by a field of the
// request (ADR-0025 §7): QA addresses are the mailbox simulator's `success+qa-…` of the QA seam.
import { emailHash, hmacSha256Hex } from "../lib/crypto";
import { type LeadOrigin } from "./model";

/** Exact form: lower-case and trimmed; the local part keeps its dots and its `+tag`. */
export function normalizeLeadEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1 || email.indexOf("@") !== at || /\s/.test(email)) throw new RangeError("invalid email address");
  return email;
}

const SES_SIMULATOR = "simulator.amazonses.com";
const GMAIL = "gmail.com";

/**
 * Reduced form of the abuse key: without the `+tag` of the local part (kept for the mailbox
 * simulator, whose tags are the only way to tell its test mailboxes apart), without dots in a Gmail
 * local part, and `googlemail.com` folded into `gmail.com`.
 */
export function abuseForm(raw: string): string {
  const email = normalizeLeadEmail(raw);
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (domain === "googlemail.com") domain = GMAIL;
  if (domain !== SES_SIMULATOR) {
    const plus = local.indexOf("+");
    if (plus > 0) local = local.slice(0, plus);
  }
  if (domain === GMAIL) local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/** The same value as lib/crypto.ts `emailHash` (the key of `Leads`), after the stricter check of this module. */
export function leadEmailHash(emailHashKey: Uint8Array | string, raw: string): string {
  return emailHash(emailHashKey, normalizeLeadEmail(raw));
}

export function leadAbuseHash(emailHashKey: Uint8Array | string, raw: string): string {
  return hmacSha256Hex(emailHashKey, abuseForm(raw));
}

/** Addresses of the QA seam (ADR-0025 §7): the only ones whose lead is `origin QA`. */
export const QA_ADDRESS_PATTERN = /^success\+qa-[a-z0-9-]{1,60}@simulator\.amazonses\.com$/;

export function leadOriginOf(raw: string): LeadOrigin {
  return QA_ADDRESS_PATTERN.test(normalizeLeadEmail(raw)) ? "QA" : "WEB";
}

/** `success+qa-<runId>-<n>@…`: the run ids of the QaDriver (qa-driver/contract.ts `RunId`) and a label. */
const QA_ADDRESS_RUN = /^success\+qa-(\d{1,20}-\d{1,3}(?:-r\d)?|local-[0-9a-hjkmnp-tv-z]{26})-[a-z0-9]{1,24}@simulator\.amazonses\.com$/;

/**
 * The QA run an address belongs to, so its account counts in that run's room (guest/slots.ts): the run of
 * `success+qa-<runId>-<n>@…`, any other QA address its whole tag; `undefined` for a non-QA address.
 */
export function qaRunOfAddress(raw: string): string | undefined {
  const email = normalizeLeadEmail(raw);
  if (!QA_ADDRESS_PATTERN.test(email)) return undefined;
  return QA_ADDRESS_RUN.exec(email)?.[1] ?? email.slice("success+qa-".length, email.indexOf("@"));
}

/** The first 8 characters of a hash: the only trace of a lead a log line may carry. */
export function hashPrefix(hash: string): string {
  return hash.slice(0, 8);
}
