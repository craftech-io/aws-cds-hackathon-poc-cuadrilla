// The changes of a lead as pure functions (ADR-0026): the store reads the `META` item, one of these
// computes the next one, and the store writes it on the version it read. Every attribute a pending
// lead carries is one the `Bff` may write (infra/leads-spec.ts `BFF_LEAD_ATTRIBUTES`), so
// `signup.start` can put the whole item; `status`, `cognitoSub`, `cognitoUsername`, `userId`,
// `subKey`, `confirmedAt`, `lastLoginAt`, `notifiedAt` and `notifyOutcome` appear only from the
// confirmation on, written by the triggers and `LeadStream`.
import type { LegalLocale } from "@cuadrilla/shared/legal/consents";
import {
  type ConsentRecord,
  type Lead,
  type LeadOrigin,
  LEAD_META,
  ORIGIN_POC,
  type Utm,
  confirmedExpiresAt,
  isPending,
  leadPartition,
  leadSubKey,
  pendingExpiresAt,
} from "./model";

/** Users without confirmation per email: a fourth start answers `RATE_LIMITED` (ADR-0025 §3). */
export const MAX_PENDING_USERNAMES = 3;

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

function optionalFields(input: StartPendingInput): Partial<Pick<Lead, "name" | "company" | "jobTitle" | "utm" | "referrerOrigin">> {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.company === undefined ? {} : { company: input.company }),
    ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle }),
    ...(input.utm === undefined || Object.keys(input.utm).length === 0 ? {} : { utm: input.utm }),
    ...(input.referrerOrigin === undefined ? {} : { referrerOrigin: input.referrerOrigin }),
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
    signupStartedAt: at,
    expiresAt: pendingExpiresAt(input.at),
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Another start for a pending lead: one more pending user (at most 3; `undefined` beyond), the form,
 * the attribution and the consents of the last start (the previous ones stay in `consentHistory`),
 * and the first `signupStartedAt` and `expiresAt` kept: the lead still expires 7 days after its first start.
 */
export function restartedLead(current: Lead, input: StartPendingInput): Lead | undefined {
  if (!isPending(current) || current.pendingUsernames.length >= MAX_PENDING_USERNAMES) return undefined;
  const { name: _name, company: _company, jobTitle: _jobTitle, utm: _utm, referrerOrigin: _referrer, ...kept } = current;
  return {
    ...kept,
    email: input.email,
    ...optionalFields(input),
    locale: input.locale,
    origin: input.origin,
    consents: { TERMS_PRIVACY: input.consents.TERMS_PRIVACY, CONTACT: input.consents.CONTACT },
    consentHistory: [...current.consentHistory, input.consents.TERMS_PRIVACY, input.consents.CONTACT],
    pendingUsernames: [...current.pendingUsernames, input.username],
    version: current.version + 1,
    updatedAt: input.at.toISOString(),
  };
}

/**
 * Post-confirmation: only a pending lead whose `pendingUsernames` lists the confirmed user becomes
 * `CONFIRMED` (ADR-0025 §1); its retention becomes 24 months. The other pending users stay listed
 * until `LeadStream` has deleted them from Cognito.
 */
export function confirmedLead(current: Lead, input: ConfirmInput): Lead | undefined {
  if (!isPending(current) || !current.pendingUsernames.includes(input.username)) return undefined;
  const at = input.at.toISOString();
  return {
    ...current,
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
