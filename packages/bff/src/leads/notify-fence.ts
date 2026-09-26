// Fence of the lead notice (ADR-0026, docs/architecture-integrations.md §9.3): the notice to Craftech
// only ever goes to a mailbox of the exact domain `craftech.io`. Same strict RFC 5322 parser as the
// demo's fence (channels/email/address.ts): one dot-atom `addr-spec`, no display name, quotes,
// comments, whitespace, CR/LF, non-ASCII or IDN; the domain is compared lower-case and exactly, so a
// subdomain (`sub.craftech.io`) or a look-alike suffix (`craftech.io.evil.test`) never passes.
//
// Three layers say the same: the zod of `LeadConfig` (lib/secret-schemas.ts) at load, this check
// before every send, and `SEND_LEAD_NOTIFY` in IAM (`ses:Recipients *@craftech.io`). The demo's fence
// (`CP-RECIPIENT-FENCE`) is a different fence and never admits `craftech.io`. Pure: no DNS, no SDK.
import { type AddressError, parseEmailAddress } from "../channels/email/address";

/** The only domain a lead notice may reach. */
export const LEAD_NOTIFY_DOMAIN = "craftech.io";

export type NotifyFenceDecision =
  | { readonly allowed: true; readonly address: string }
  | { readonly allowed: false; readonly reason: "INVALID_ADDRESS" | "NOT_CRAFTECH"; readonly addressError?: AddressError };

/** Whether `raw`, exactly as given, is a mailbox of `craftech.io` (normalized lower-case when allowed). */
export function fenceLeadNotifyRecipient(raw: string): NotifyFenceDecision {
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) return { allowed: false, reason: "INVALID_ADDRESS", addressError: parsed.error };
  if (parsed.address.domain !== LEAD_NOTIFY_DOMAIN) return { allowed: false, reason: "NOT_CRAFTECH" };
  return { allowed: true, address: parsed.address.normalized };
}

export function isCraftechMailbox(raw: string): boolean {
  return fenceLeadNotifyRecipient(raw).allowed;
}

/**
 * The recipients a notice goes to: every configured address checked again (the secret could have been
 * set by hand), duplicates collapsed. Throws when one fails: a notice never goes out half-fenced.
 */
export function fencedNotifyRecipients(configured: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of configured) {
    const decision = fenceLeadNotifyRecipient(raw);
    if (!decision.allowed) throw new RangeError(`a LeadConfig recipient is outside the notice fence (${decision.reason})`);
    out.add(decision.address);
  }
  if (out.size === 0) throw new RangeError("LeadConfig has no recipient");
  return [...out];
}
