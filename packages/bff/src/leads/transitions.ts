// The changes of a lead as pure functions (ADR-0026): the store reads the `META` item, one of these
// computes the next one, and the store writes it on the version it read. Every attribute a pending
// lead carries is one the `Bff` may write (infra/leads-spec.ts `BFF_LEAD_ATTRIBUTES`), so
// `signup.start` can put the whole item; `status`, `cognitoSub`, `cognitoUsername`, `userId`,
// `subKey`, `confirmedAt`, `lastLoginAt`, `notifiedAt` and `notifyOutcome` appear only from the
// confirmation on, written by the triggers and `LeadStream`.
//
// Anyone who types an address can start a sign-up for it, and nothing proves ownership until the code
// is confirmed. So a start is kept apart, by user, in `pending[<username>]`, and never replaces what
// another start said: the confirmation promotes the entry of the user who confirmed (its form, its
// attribution and only its consents). A start past the third pending user retires the oldest one
// instead of refusing, and a retired user keeps its entry and may still confirm: Cognito accepts its
// code and gives it the email alias, so a lead that refused it would lock the address out.
import type { LegalLocale } from "@cuadrilla/shared/legal/consents";
import {
  type ConsentRecord,
  type Lead,
  type LeadOrigin,
  LEAD_META,
  MAX_PENDING_USERNAMES,
  MAX_RETIRED_USERNAMES,
  ORIGIN_POC,
  type PendingStart,
  type Utm,
  confirmedExpiresAt,
  isPending,
  leadPartition,
  mayConfirm,
  leadSubKey,
  pendingExpiresAt,
} from "./model";

export { MAX_PENDING_USERNAMES };

export interface LeadForm {
  readonly name?: string | undefined;
  readonly company?: string | undefined;
  readonly jobTitle?: string | undefined;
}

export interface StartPendingInput extends LeadForm {
  /** HMAC of the normalized email with the `email-hash` subkey (leads/keys.ts). */
  readonly emailHash: string;
  /** The address as the visitor wrote it (trimmed): the contact. */
  readonly email: string;
  readonly abuseHash: string;
  /** The `gst-<ULID>` `signup.start` generated for this start. */
  readonly username: string;
  readonly locale: LegalLocale;
  /** Decided by the server from the address (leads/keys.ts `leadOriginOf`), never by the request. */
  readonly origin: LeadOrigin;
  readonly utm?: Utm | undefined;
  readonly referrerOrigin?: string | undefined;
  readonly consents: { readonly TERMS_PRIVACY: ConsentRecord; readonly CONTACT: ConsentRecord };
  /** Real clock of the server. */
  readonly at: Date;
}

export interface ConfirmInput {
  readonly emailHash: string;
  /** `event.userName` of the confirmation. */
  readonly username: string;
  readonly sub: string;
  readonly userId: string;
  readonly at: Date;
}

type FormFields = Pick<Lead, "name" | "company" | "jobTitle" | "utm" | "referrerOrigin">;

function optionalFields(input: Partial<FormFields>): Partial<FormFields> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.company === undefined ? {} : { company: input.company }),
    ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle }),
    ...(input.utm === undefined || Object.keys(input.utm).length === 0 ? {} : { utm: input.utm }),
    ...(input.referrerOrigin === undefined ? {} : { referrerOrigin: input.referrerOrigin }),
  };
}

/** What one start said, kept under its own user. */
export function pendingStartOf(input: StartPendingInput): PendingStart {
  return {
    email: input.email,
    ...optionalFields(input),
    locale: input.locale,
    consents: { TERMS_PRIVACY: input.consents.TERMS_PRIVACY, CONTACT: input.consents.CONTACT },
    at: input.at.toISOString(),
  };
}

/** The first start of an email: a pending lead that lives 7 days, whatever happens next. */
export function newLead(input: StartPendingInput, leadId: string): Lead {
  const at = input.at.toISOString();
  return {
    PK: leadPartition(input.emailHash),
    SK: LEAD_META,
    entity: "Lead",
    leadId,
    email: input.email,
    ...optionalFields(input),
    locale: input.locale,
    originPoc: ORIGIN_POC,
    origin: input.origin,
    consents: { TERMS_PRIVACY: input.consents.TERMS_PRIVACY, CONTACT: input.consents.CONTACT },
    consentHistory: [input.consents.TERMS_PRIVACY, input.consents.CONTACT],
    abuseHash: input.abuseHash,
    pendingUsernames: [input.username],
    pending: { [input.username]: pendingStartOf(input) },
    signupStartedAt: at,
    expiresAt: pendingExpiresAt(input.at),
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Another start for a pending lead: one more pending user with its own entry, the oldest pending user
 * retired when there were already 3 (it keeps its entry and may still confirm; `LeadStream` deletes it
 * from Cognito with the others), and nothing another start said touched: the lead's own fields stay the
 * first start's, and the first `signupStartedAt` and `expiresAt` are kept (7 days after the first start).
 * `undefined` for a lead that is no longer pending.
 */
export function restartedLead(current: Lead, input: StartPendingInput): Lead | undefined {
  if (!isPending(current)) return undefined;
  const listed = [...current.pendingUsernames, input.username];
  const retired = listed.slice(0, Math.max(0, listed.length - MAX_PENDING_USERNAMES));
  const kept = listed.slice(retired.length);
  const retiredUsernames = [...(current.retiredUsernames ?? []), ...retired].slice(-MAX_RETIRED_USERNAMES);
  const entries = [...retiredUsernames, ...kept].filter((name) => name !== input.username);
  const pending = Object.fromEntries(entries.flatMap((name) => (current.pending?.[name] === undefined ? [] : [[name, current.pending[name]] as const])));
  return {
    ...current,
    pendingUsernames: kept,
    pending: { ...pending, [input.username]: pendingStartOf(input) },
    ...(retiredUsernames.length === 0 ? {} : { retiredUsernames }),
    version: current.version + 1,
    updatedAt: input.at.toISOString(),
  };
}

/** The lead without its pending state and, when the confirmed user's start is there, with that start's fields. */
function promoted(current: Lead, username: string): Omit<Lead, "pending"> {
  const { pending: _pending, ...lead } = current;
  const start = current.pending?.[username];
  // A lead written before the entries existed keeps its own fields.
  if (start === undefined) return lead;
  const { name: _name, company: _company, jobTitle: _jobTitle, utm: _utm, referrerOrigin: _referrer, ...rest } = lead;
  return {
    ...rest,
    email: start.email,
    ...optionalFields(start),
    locale: start.locale,
    consents: start.consents,
    consentHistory: [start.consents.TERMS_PRIVACY, start.consents.CONTACT],
  };
}

/**
 * Post-confirmation: only a pending lead that lists the confirmed user, as pending or as retired
 * (`mayConfirm`), becomes `CONFIRMED` (ADR-0025 §1), with the form, attribution and consents of THAT
 * user's start (what other starts said is dropped with `pending`); its retention becomes 24 months. The
 * other pending and retired users stay listed until `LeadStream` has deleted them from Cognito.
 */
export function confirmedLead(current: Lead, input: ConfirmInput): Lead | undefined {
  if (!mayConfirm(current, input.username)) return undefined;
  const at = input.at.toISOString();
  return {
    ...promoted(current, input.username),
    status: "CONFIRMED",
    cognitoSub: input.sub,
    cognitoUsername: input.username,
    userId: input.userId,
    subKey: leadSubKey(input.sub),
    confirmedAt: at,
    expiresAt: confirmedExpiresAt(input.at),
    version: current.version + 1,
    updatedAt: at,
  };
}

/** Post-authentication of a confirmed lead: last sign-in and 24 more months. */
export function loggedInLead(current: Lead, at: Date): Lead | undefined {
  if (current.status !== "CONFIRMED") return undefined;
  return { ...current, lastLoginAt: at.toISOString(), expiresAt: confirmedExpiresAt(at), version: current.version + 1, updatedAt: at.toISOString() };
}

/** The contact consent withdrawn (art. 27, Ley 25.326): a new `CONTACT` record, nothing else touched. */
export function withdrawnContactLead(current: Lead, record: ConsentRecord, at: Date): Lead {
  if (record.id !== "CONTACT" || record.accepted) throw new RangeError("a withdrawal is a CONTACT record that is not accepted");
  return {
    ...current,
    consents: { ...current.consents, CONTACT: record },
    consentHistory: [...current.consentHistory, record],
    version: current.version + 1,
    updatedAt: at.toISOString(),
  };
}

/** Contactable: confirmed, from the web, and the contact consent in force accepted. */
export function isContactable(lead: Pick<Lead, "status" | "origin" | "consents">): boolean {
  return lead.status === "CONFIRMED" && lead.origin === "WEB" && lead.consents.CONTACT.accepted;
}

export type { LegalLocale };
