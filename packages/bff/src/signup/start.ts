// `signup.start` (ADR-0025 §3, ADR-0026, docs/landing-spec.md §7.3 and §7.5): the only public procedure
// that writes. In this order, and nothing is written before the step that writes:
//
//   1. the form (zod, strict; the password is never here)                    INVALID (INVALID_FORM)
//      and its phone, an international E.164 number, not filler                INVALID (PHONE_INVALID)
//      not a range that is no person's mobile (phone/number.ts)                INVALID (PHONE_NOT_PERSONAL)
//      and of a country of the Americas                                       INVALID (PHONE_COUNTRY_NOT_ALLOWED)
//   2. who is asking: the viewer of the edge (no other caller starts a sign-up) UNAVAILABLE (NO_VIEWER)
//   3. the two consents against their version in force                       INVALID (CONSENT_…)
//   4. the cut of the sign-up (KILL#SIGNUP, KILL#ALL)                          CAP_REACHED
//   5. the domain of the email: not a disposable mailbox of the public or the own list, nor a
//      reserved or test domain (signup/disposable-domains.ts)                 INVALID (EMAIL_NOT_ACCEPTED)
//      then MX, or A/AAAA, within 2 s (a resolver that fails lets it through) INVALID (EMAIL_NOT_ACCEPTED)
//      and no MX at a disposable service's mail server, by name or by address INVALID (EMAIL_NOT_ACCEPTED)
//      Every refusal of the domain gives the visitor the same answer; the log line tells them apart
//      (`DISPOSABLE`, `EMAIL_RESERVED`, `EMAIL_DOMAIN`, `DISPOSABLE_MX`, `DISPOSABLE_MX_ADDRESS`).
//   6. the visitor's counters, then the stage's day (signup/limits.ts)        RATE_LIMITED | CAP_REACHED
//   7. two confirmed accounts of the same person                             RATE_LIMITED
//   8. the lead: new, or one more pending user (≤ 3, the oldest retired, each start's form and
//      consents kept apart under its own user); a confirmed one is left as it is
//   9. the ticket that binds the email and the new `gst-<ULID>` user, 10 minutes
//
// An email that already has an account answers exactly like a new one (a ticket, a user, an expiry),
// so `signup.start` never tells who has an account. Its `SignUp` goes on too (auth-triggers/pre-sign-up.ts)
// and Cognito sends the code to that inbox; only its owner can type it, and the confirmation then fails
// with `AliasExistsException`, which the web reads as "you already have an account" (ADR-0025 §3).
//
// Emails, IPs and tickets never reach a log: a line carries the first 8 characters of the email's hash
// at most (ADR-0026, PII). Refusals are `SignupRejected{reason}`, a start is `SignupStarted`.
import { ToolError } from "@cuadrilla/shared";
import type { TableClient } from "../connector/table-client";
import { leadAttribution } from "../leads/attribution";
import { consentRecords } from "../leads/consent";
import { hashPrefix, leadAbuseHash, leadEmailHash, leadOriginOf, normalizeLeadEmail } from "../leads/keys";
import type { LeadStore } from "../leads/store";
import type { Logger } from "../lib/log";
import { type KillSwitchReader, blockingScope } from "../ops/kill-switch";
import type { EdgeContext } from "../routers/trpc";
import { isDisposableDomain, isReservedDomain } from "./disposable-domains";
import { type DnsResolver, domainOf, emailDomainVerdict } from "./email-domain";
import { parseAccountPhone } from "../phone/number";
import { parseSignupForm } from "./form";
import { SIGNUP_LIMITS, confirmedAccountsOf, ipHashOf, reserveStart } from "./limits";
import { SIGNUP_TICKET_TTL_MS, issueTicket } from "./ticket";

export interface SignupKeys {
  readonly emailHash: () => Uint8Array | string;
  readonly ipHash: () => Uint8Array | string;
  readonly ticket: () => Uint8Array | string;
}

export interface SignupPorts {
  readonly leads: LeadStore;
  readonly runtime: TableClient;
  readonly kill: Pick<KillSwitchReader, "status">;
  readonly keys: SignupKeys;
  readonly resolver: DnsResolver;
  /** Real clock of the server: counters, consents and tickets are real time. */
  readonly now: () => Date;
  /** A fresh ULID (the user name and the ticket's nonce). */
  readonly newUlid: (nowMs: number) => string;
}

export interface SignupCall {
  readonly input: unknown;
  readonly edge: EdgeContext | null;
  readonly log: Logger;
}

export interface SignupStarted {
  readonly ticket: string;
  readonly username: string;
  readonly expiresAt: string;
}

/** Why a start was refused, as the log line says it (the visitor sees the error's `reason`). */
export type SignupRefusal = "INVALID_FORM" | "PHONE_INVALID" | "PHONE_NOT_PERSONAL" | "PHONE_COUNTRY_NOT_ALLOWED" | "NO_VIEWER" | "CONSENT" | "DISPOSABLE" | "EMAIL_RESERVED" | "EMAIL_DOMAIN" | "DISPOSABLE_MX" | "DISPOSABLE_MX_ADDRESS" | "RATE_LIMITED" | "CAP_REACHED" | "UNAVAILABLE";

const REFUSALS = {
  NO_VIEWER: () => new ToolError("UNAVAILABLE", "the account could not be created right now", "NO_VIEWER"),
  EMAIL_NOT_ACCEPTED: () => new ToolError("INVALID", "use a work or personal email that receives mail", "EMAIL_NOT_ACCEPTED"),
  RATE_LIMITED: () => new ToolError("CAP_REACHED", "too many sign-ups from this connection or with this email", "RATE_LIMITED"),
  CAP_REACHED: () => new ToolError("CAP_REACHED", "new test accounts are not being opened right now", "CAP_REACHED"),
  UNAVAILABLE: () => new ToolError("UNAVAILABLE", "the account could not be created right now", "UNAVAILABLE"),
} as const satisfies Readonly<Record<string, () => ToolError>>;

/** The viewer the edge verified: its IP and whether AWS WAF labelled it anonymous. */
function viewerOf(call: SignupCall): { readonly address: string; readonly anonymous: boolean } | undefined {
  if (call.edge !== null && call.edge.viewerIp.length > 0) return { address: call.edge.viewerIp, anonymous: call.edge.anonymousIp === true };
  return undefined;
}

export async function startSignup(ports: () => SignupPorts, call: SignupCall): Promise<SignupStarted> {
  const refuse = (reason: SignupRefusal, error: ToolError, hash?: string): never => {
    call.log.warn("signup.refused", { reason, metric: "SignupRejected", value: 1, ...(hash === undefined ? {} : { emailHash: hashPrefix(hash) }) });
    throw error;
  };
  let form;
  try {
    form = parseSignupForm(call.input);
  } catch (error) {
    return refuse("INVALID_FORM", error as ToolError);
  }
  let phone: string;
  try {
    phone = parseAccountPhone(form.phone);
  } catch (error) {
    const refusal = error as ToolError;
    return refuse(refusal.reason === "PHONE_NOT_PERSONAL" || refusal.reason === "PHONE_COUNTRY_NOT_ALLOWED" ? refusal.reason : "PHONE_INVALID", refusal);
  }
  const origin = viewerOf(call);
  if (origin === undefined) return refuse("NO_VIEWER", REFUSALS.NO_VIEWER());
  const p = ports();
  const now = p.now();
  let consents;
  try {
    consents = consentRecords(form.consents, form.locale, now);
  } catch (error) {
    return refuse("CONSENT", error instanceof ToolError ? error : REFUSALS.UNAVAILABLE());
  }

  let cut;
  try {
    cut = blockingScope(await p.kill.status(), "SIGNUP");
  } catch {
    return refuse("UNAVAILABLE", REFUSALS.UNAVAILABLE());
  }
  if (cut !== undefined) return refuse("CAP_REACHED", REFUSALS.CAP_REACHED());

  const email = normalizeLeadEmail(form.email);
  const emailKey = p.keys.emailHash();
  const emailHash = leadEmailHash(emailKey, email);
  if (isDisposableDomain(domainOf(email))) return refuse("DISPOSABLE", REFUSALS.EMAIL_NOT_ACCEPTED(), emailHash);
  if (isReservedDomain(domainOf(email))) return refuse("EMAIL_RESERVED", REFUSALS.EMAIL_NOT_ACCEPTED(), emailHash);
  const domain = await emailDomainVerdict(email, p.resolver);
  if (domain === "INVALID") return refuse("EMAIL_DOMAIN", REFUSALS.EMAIL_NOT_ACCEPTED(), emailHash);
  if (domain === "DISPOSABLE") return refuse("DISPOSABLE_MX", REFUSALS.EMAIL_NOT_ACCEPTED(), emailHash);
  if (domain === "DISPOSABLE_ADDRESS") return refuse("DISPOSABLE_MX_ADDRESS", REFUSALS.EMAIL_NOT_ACCEPTED(), emailHash);
  if (domain === "UNKNOWN") call.log.warn("signup.email_domain.unknown", { metric: "SignupMxUnknown", value: 1, emailHash: hashPrefix(emailHash) });

  const abuseHash = leadAbuseHash(emailKey, email);
  const reserved = await reserveStart(p.runtime, { ipHash: ipHashOf(p.keys.ipHash(), origin.address), abuseHash, anonymous: origin.anonymous }, now);
  if (reserved !== "RESERVED") return refuse(reserved, REFUSALS[reserved](), emailHash);
  if ((await confirmedAccountsOf(p.runtime, abuseHash)) >= SIGNUP_LIMITS.confirmedAccountsPerPerson) return refuse("RATE_LIMITED", REFUSALS.RATE_LIMITED(), emailHash);

  const username = `gst-${p.newUlid(now.getTime())}`;
  const started = await p.leads.startPending({
    emailHash,
    email: form.email,
    abuseHash,
    username,
    locale: form.locale,
    origin: leadOriginOf(email),
    name: form.name,
    company: form.company,
    jobTitle: form.jobTitle,
    phone,
    ...leadAttribution({ utm: form.attribution?.utm, referrer: form.attribution?.referrer }),
    consents,
    at: now,
  });

  const exp = Math.floor((now.getTime() + SIGNUP_TICKET_TTL_MS) / 1000);
  const ticket = issueTicket(p.keys.ticket(), { nonce: p.newUlid(now.getTime()), emailHash, username, exp });
  const leadOrigin = started.outcome === "EMAIL_TAKEN" ? leadOriginOf(email) : started.lead.origin;
  call.log.info("signup.started", { metric: "SignupStarted", value: 1, outcome: started.outcome, origin: leadOrigin, emailHash: hashPrefix(emailHash) });
  return { ticket, username, expiresAt: new Date(exp * 1000).toISOString() };
}
