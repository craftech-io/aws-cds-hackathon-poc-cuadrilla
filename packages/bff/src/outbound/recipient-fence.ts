// `CP-RECIPIENT-FENCE` (docs/architecture-integrations.md §1, docs/design-brief.md §5.7): who may
// receive an email from a world. Pure, so the single SES client (channels/email/outbound.ts) checks it
// before every send, `fence.probe` of the QaDriver evaluates it without sending, and
// `people.upsert` applies it when an email is written:
//
//   *@simulator.amazonses.com                   every world (SES delivers it and emits the event we
//                                               expect, with no mailbox to read and no reputation hit)
//   SeedOverrides.demoRecipients.emails         only the operator's demo world (`GLOBAL#…`, which is
//                                               also the only world that can be live); never GUEST,
//                                               QA nor EVAL, so a guest who edits a person's email
//                                               cannot aim an alert at a real mailbox
//   cuadrilla.demo.craftech.io and subdomains   never: the domain has no mailboxes (ADR-0003)
//   demo.craftech.io and subdomains             never: the shared demo zone hosts other apps of the
//                                               account, some of which receive email there
//   .test .example .invalid .localhost,
//   example.com|net|org and their subdomains    never (RFC 2606, RFC 6761)
//   anything else                               never
//
// A denial is `RECIPIENT_NOT_ALLOWED` with its reason, decided before SES is called.
import { z } from "zod";
import { ClockId, ispKindOfClock } from "@cuadrilla/shared";
import { type AddressError, isWithinDomain, parseEmailAddress } from "../channels/email/address";

export const FENCE_RULE = "CP-RECIPIENT-FENCE";

/** SES mailbox simulator: `success+<tag>@`, `bounce+<tag>@`, `complaint+<tag>@` (exact domain). */
export const SES_SIMULATOR_DOMAIN = "simulator.amazonses.com";
/** Our sending domain: no MX, no mailboxes. */
export const OWN_DOMAIN = "cuadrilla.demo.craftech.io";
/** The delegated zone every Craftech demo lives in. */
export const DEMO_ZONE = "demo.craftech.io";

const RESERVED_TLDS = ["test", "example", "invalid", "localhost"] as const;
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"] as const;

export const FenceReason = z.enum([
  "INVALID_ADDRESS",
  "OWN_DOMAIN",
  "DEMO_ZONE",
  "RESERVED_DOMAIN",
  "DEMO_RECIPIENT_OUTSIDE_DEMO_WORLD",
  "NOT_ALLOWED",
  /** Set by the SES client: the address bounced permanently or complained before (never retried). */
  "SUPPRESSED",
]);
export type FenceReason = z.infer<typeof FenceReason>;

export type RecipientClass = "SES_SIMULATOR" | "DEMO_RECIPIENT";

export type FenceDecision =
  | { readonly allowed: true; readonly ruleId: typeof FENCE_RULE; readonly address: string; readonly recipientClass: RecipientClass }
  | { readonly allowed: false; readonly ruleId: typeof FENCE_RULE; readonly reason: FenceReason; readonly addressError?: AddressError };

function denied(reason: FenceReason, addressError?: AddressError): FenceDecision {
  return { allowed: false, ruleId: FENCE_RULE, reason, ...(addressError === undefined ? {} : { addressError }) };
}

export function isReservedDomain(domain: string): boolean {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return (RESERVED_TLDS as readonly string[]).includes(tld) || RESERVED_DOMAINS.some((reserved) => isWithinDomain(domain, reserved));
}

/** Demo recipients count only in the operator's demo world (`GLOBAL#…`, `Isp.kind DEMO`). */
export function acceptsDemoRecipients(clockId: string): boolean {
  return ispKindOfClock(clockId) === "DEMO";
}

/** The normalized form of each registered demo recipient; entries that do not parse are ignored. */
export function normalizedDemoRecipients(emails: readonly string[]): ReadonlySet<string> {
  return new Set(emails.flatMap((email) => {
    const parsed = parseEmailAddress(email);
    return parsed.ok ? [parsed.address.normalized] : [];
  }));
}

export interface FenceOptions {
  /** `SeedOverrides.demoRecipients.emails` (PII: never logged). */
  readonly demoRecipients?: readonly string[];
}

/** Whether `raw` may receive an email from the world of `clockId`. */
export function fenceEmailRecipient(raw: string, clockId: string, options: FenceOptions = {}): FenceDecision {
  const world = ClockId.parse(clockId);
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) return denied("INVALID_ADDRESS", parsed.error);
  const { domain, normalized } = parsed.address;
  if (isWithinDomain(domain, OWN_DOMAIN)) return denied("OWN_DOMAIN");
  if (isWithinDomain(domain, DEMO_ZONE)) return denied("DEMO_ZONE");
  if (isReservedDomain(domain)) return denied("RESERVED_DOMAIN");
  if (domain === SES_SIMULATOR_DOMAIN) return { allowed: true, ruleId: FENCE_RULE, address: normalized, recipientClass: "SES_SIMULATOR" };
  if (normalizedDemoRecipients(options.demoRecipients ?? []).has(normalized)) {
    return acceptsDemoRecipients(world) ? { allowed: true, ruleId: FENCE_RULE, address: normalized, recipientClass: "DEMO_RECIPIENT" } : denied("DEMO_RECIPIENT_OUTSIDE_DEMO_WORLD");
  }
  return denied("NOT_ALLOWED");
}
