// `signup.start` (ADR-0025 §3, ADR-0026, docs/landing-spec.md §7.3 and §7.5): the only public procedure
// that writes. In this order, and nothing is written before the step that writes:
//
//   1. the form (zod, strict; the password is never here)                    INVALID (INVALID_FORM)
//   2. who is asking: the viewer of the edge, or the QaDriver's run           UNAVAILABLE (NO_VIEWER)
//   3. the two consents against their version in force                       INVALID (CONSENT_…)
//   4. the cut of the sign-up (KILL#SIGNUP, KILL#ALL)                          CAP_REACHED
//   5. the domain of the email: MX, or A/AAAA, within 1 s                     INVALID (EMAIL_DOMAIN)
//   6. the visitor's counters, then the stage's day (signup/limits.ts)        RATE_LIMITED | CAP_REACHED
//   7. two confirmed accounts of the same person                             RATE_LIMITED
//   8. the lead: new, or one more pending user (≤ 3); a confirmed one         EMAIL_TAKEN | RATE_LIMITED
//   9. the ticket that binds the email and the new `gst-<ULID>` user, 10 minutes
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
import type { EdgeContext, QaContext } from "../routers/trpc";
import { type DnsResolver, emailDomainVerdict } from "./email-domain";
import { parseSignupForm } from "./form";
import { type LimitScope, SIGNUP_LIMITS, confirmedAccountsOf, ipHashOf, reserveStart } from "./limits";
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
  readonly qa: QaContext | null;
  readonly log: Logger;
}

export interface SignupStarted {
  readonly ticket: string;
  readonly username: string;
  readonly expiresAt: string;
}

export type SignupRefusal = "INVALID_FORM" | "NO_VIEWER" | "CONSENT" | "EMAIL_DOMAIN" | "RATE_LIMITED" | "CAP_REACHED" | "EMAIL_TAKEN" | "UNAVAILABLE";

const REFUSALS: Readonly<Record<Exclude<SignupRefusal, "INVALID_FORM" | "CONSENT">, () => ToolError>> = {
  NO_VIEWER: () => new ToolError("UNAVAILABLE", "the account could not be created right now", "NO_VIEWER"),
  EMAIL_DOMAIN: () => new ToolError("INVALID", "the domain of this email cannot receive mail", "EMAIL_DOMAIN"),
  RATE_LIMITED: () => new ToolError("CAP_REACHED", "too many sign-ups from this connection or with this email", "RATE_LIMITED"),
  CAP_REACHED: () => new ToolError("CAP_REACHED", "new test accounts are not being opened right now", "CAP_REACHED"),
  EMAIL_TAKEN: () => new ToolError("CONFLICT", "there is already an account with this email", "EMAIL_TAKEN"),
  UNAVAILABLE: () => new ToolError("UNAVAILABLE", "the account could not be created right now", "UNAVAILABLE"),
};

/** Where the call's counters live and what its "IP" is: the edge's viewer, or the QaDriver's run. */
function scopeOf(call: SignupCall): { readonly scope: LimitScope; readonly address: string; readonly anonymous: boolean } | undefined {
  if (call.qa !== null) return { scope: { kind: "QA", runId: call.qa.runId }, address: `qa-${call.qa.runId}`, anonymous: false };
  if (call.edge !== null && call.edge.viewerIp.length > 0) return { scope: { kind: "PUBLIC" }, address: call.edge.viewerIp, anonymous: call.edge.anonymousIp === true };
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
  const origin = scopeOf(call);
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
  const domain = await emailDomainVerdict(email, p.resolver);
  if (domain === "INVALID") return refuse("EMAIL_DOMAIN", REFUSALS.EMAIL_DOMAIN(), emailHash);
  if (domain === "UNKNOWN") call.log.warn("signup.email_domain.unknown", { metric: "SignupMxUnknown", value: 1, emailHash: hashPrefix(emailHash) });

  const abuseHash = leadAbuseHash(emailKey, email);
  const reserved = await reserveStart(p.runtime, origin.scope, { ipHash: ipHashOf(p.keys.ipHash(), origin.address), abuseHash, anonymous: origin.anonymous }, now);
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
    ...leadAttribution({ utm: form.attribution?.utm, referrer: form.attribution?.referrer }),
    consents,
    at: now,
  });
  if (started.outcome === "EMAIL_TAKEN") return refuse("EMAIL_TAKEN", REFUSALS.EMAIL_TAKEN(), emailHash);
  if (started.outcome === "TOO_MANY_PENDING") return refuse("RATE_LIMITED", REFUSALS.RATE_LIMITED(), emailHash);

  const exp = Math.floor((now.getTime() + SIGNUP_TICKET_TTL_MS) / 1000);
  const ticket = issueTicket(p.keys.ticket(), { nonce: p.newUlid(now.getTime()), emailHash, username, exp });
  call.log.info("signup.started", { metric: "SignupStarted", value: 1, outcome: started.outcome, origin: started.lead.origin, emailHash: hashPrefix(emailHash) });
  return { ticket, username, expiresAt: new Date(exp * 1000).toISOString() };
}
