// The items of the `Leads` table (ADR-0026, docs/architecture.md §5), as zod schemas and key builders.
// The table lives OUTSIDE the demo: no `clockId`, no `world`, never read by the world factory, the
// demo's exports, metrics or audit log. Its email addresses are real personal data: they live only in
// the lead `META` item (`email`), never in an event, a log entry of `LEADLOG#`, a log line or a key
// (the key is the HMAC of the normalized email with the `email-hash` subkey).
//
//   Lead         LEAD#<emailHash> · META           the contact, its consents and its lifecycle
//   Lead event   LEAD#<emailHash> · EVT#<ts>#<ulid> STARTED, CONFIRMED, LOGIN, NOTIFIED, EXPORTED, …
//   Lead log     LEADLOG#<yyyy-mm> · <ts>#<ulid>   deletions, expiries, refusals: `leadId`, never the email
import { z } from "zod";
import { ConsentId, ConsentVersion, LegalLocale } from "@cuadrilla/shared/legal/consents";

export const LEAD_PARTITION_PREFIX = "LEAD#";
export const LEAD_META = "META";
export const LEAD_EVENT_PREFIX = "EVT#";
export const LEAD_LOG_PREFIX = "LEADLOG#";
export const LEAD_SUB_PREFIX = "SUB#";
/** Product that produced the lead (the same table shape serves every Craftech demo). */
export const ORIGIN_POC = "cuadrilla";

const DAY_SECONDS = 24 * 60 * 60;
/** A pending lead lives 7 days from its first start (never extended). */
export const PENDING_TTL_SECONDS = 7 * DAY_SECONDS;
/** A confirmed lead, 24 months from its last sign-in (post-authentication renews it). */
export const CONFIRMED_TTL_MONTHS = 24;
/** The lead log keeps 24 months of entries without anything that identifies a person. */
export const LEAD_LOG_TTL_MONTHS = 24;

export const EmailHash = z.string().regex(/^[0-9a-f]{64}$/, "expected an HMAC-SHA256 in hex");
/** `gst-<ULID>`: the only Cognito users the own sign-up creates (ADR-0025 §1). */
export const SIGNUP_USERNAME_PATTERN = /^gst-[0-9A-HJKMNP-TV-Z]{26}$/;
export const SignupUsername = z.string().regex(SIGNUP_USERNAME_PATTERN, "expected gst-<ULID>");
/** `usr-g<ULID>`: the console user post-confirmation creates for a guest of the own sign-up. */
export const SIGNUP_USER_ID_PATTERN = /^usr-g[0-9A-HJKMNP-TV-Z]{26}$/;
export const SignupUserId = z.string().regex(SIGNUP_USER_ID_PATTERN, "expected usr-g<ULID>");
const Ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const Iso = z.iso.datetime({ offset: true });
const Text80 = z.string().trim().min(1).max(80);

/** Who decided: the server, never a field of the request (ADR-0025 §7). */
export const LeadOrigin = z.enum(["WEB", "QA"]);
export type LeadOrigin = z.infer<typeof LeadOrigin>;

export const NotifyOutcome = z.enum(["SENT", "SUPPRESSED_QA", "FAILED"]);
export type NotifyOutcome = z.infer<typeof NotifyOutcome>;

/** One answer to one consent, as stored: accepted or not, when (server's real clock), which text, which language. */
export const ConsentRecord = z
  .object({
    id: ConsentId,
    accepted: z.boolean(),
    at: Iso,
    textVersion: ConsentVersion,
    locale: LegalLocale,
  })
  .strict();
export type ConsentRecord = z.infer<typeof ConsentRecord>;

export const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;
export const Utm = z
  .object({
    source: z.string().optional(),
    medium: z.string().optional(),
    campaign: z.string().optional(),
    term: z.string().optional(),
    content: z.string().optional(),
  })
  .strict();
export type Utm = z.infer<typeof Utm>;

export const Lead = z.object({
  PK: z.string().startsWith(LEAD_PARTITION_PREFIX),
  SK: z.literal(LEAD_META),
  entity: z.literal("Lead"),
  leadId: Ulid,
  /** The address as the visitor wrote it: it is the contact. */
  email: z.string().min(3).max(320),
  name: Text80.optional(),
  company: Text80.optional(),
  jobTitle: Text80.optional(),
  locale: LegalLocale,
  originPoc: z.literal(ORIGIN_POC),
  origin: LeadOrigin,
  utm: Utm.optional(),
  referrerOrigin: z.string().max(300).optional(),
  consents: z.object({ TERMS_PRIVACY: ConsentRecord, CONTACT: ConsentRecord }).strict(),
  consentHistory: z.array(ConsentRecord),
  abuseHash: EmailHash,
  pendingUsernames: z.array(SignupUsername).max(3),
  /** Absent while the lead is pending; `CONFIRMED` is written only by post-confirmation. */
  status: z.literal("CONFIRMED").optional(),
  signupStartedAt: Iso,
  confirmedAt: Iso.optional(),
  lastLoginAt: Iso.optional(),
  cognitoSub: z.string().min(1).max(128).optional(),
  cognitoUsername: SignupUsername.optional(),
  userId: z.string().min(1).max(64).optional(),
  subKey: z.string().startsWith(LEAD_SUB_PREFIX).optional(),
  notifiedAt: Iso.optional(),
  notifyOutcome: NotifyOutcome.optional(),
  expiresAt: z.int().min(0),
  version: z.int().min(1),
  createdAt: Iso,
  updatedAt: Iso,
});
export type Lead = z.infer<typeof Lead>;

export const LeadEventKind = z.enum(["STARTED", "CONFIRMED", "LOGIN", "NOTIFIED", "EXPORTED", "CONTACT_WITHDRAWN", "DELETION_REQUESTED"]);
export type LeadEventKind = z.infer<typeof LeadEventKind>;

export const LeadActor = z.enum(["GUEST", "OPERATOR", "TTL", "SYSTEM"]);
export type LeadActor = z.infer<typeof LeadActor>;

/** An event of a lead: what happened and who did it; never the email. */
export const LeadEvent = z
  .object({
    PK: z.string().startsWith(LEAD_PARTITION_PREFIX),
    SK: z.string().startsWith(LEAD_EVENT_PREFIX),
    entity: z.literal("LeadEvent"),
    kind: LeadEventKind,
    actor: LeadActor,
    createdAt: Iso,
    expiresAt: z.int().min(0),
  })
  .strict();
export type LeadEvent = z.infer<typeof LeadEvent>;

export const LeadLogKind = z.enum(["LEAD_DELETED", "LEAD_EXPIRED", "CONTACT_WITHDRAWN", "SIGNUP_CONFIRM_IGNORED", "DELETION_REFUSED"]);
export type LeadLogKind = z.infer<typeof LeadLogKind>;

/** Reasons are codes, never free text that could carry what the visitor typed. */
const LogReason = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);

/** An entry of the lead log: `leadId` (which no longer points at anyone once the lead is gone), never the email nor its hash. */
export const LeadLogEntry = z
  .object({
    PK: z.string().startsWith(LEAD_LOG_PREFIX),
    SK: z.string(),
    entity: z.literal("LeadLog"),
    kind: LeadLogKind,
    leadId: Ulid.optional(),
    actor: LeadActor,
    reason: LogReason.optional(),
    /** Cognito `sub` of an ignored confirmation (ADR-0025 §1), never an address. */
    sub: z.string().min(1).max(128).optional(),
    createdAt: Iso,
    expiresAt: z.int().min(0),
  })
  .strict();
export type LeadLogEntry = z.infer<typeof LeadLogEntry>;

export interface LeadLogInput {
  readonly kind: LeadLogKind;
  readonly actor: LeadActor;
  readonly leadId?: string | undefined;
  readonly reason?: string | undefined;
  readonly sub?: string | undefined;
}

// ---- Keys and lifetimes ----------------------------------------------------------------------------

export const leadPartition = (emailHash: string): string => `${LEAD_PARTITION_PREFIX}${EmailHash.parse(emailHash)}`;
export const leadKey = (emailHash: string) => ({ PK: leadPartition(emailHash), SK: LEAD_META });
export const leadSubKey = (sub: string): string => `${LEAD_SUB_PREFIX}${sub}`;
export const emailHashOfPartition = (pk: string): string => EmailHash.parse(pk.slice(LEAD_PARTITION_PREFIX.length));

export const epochSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);

/** The same calendar instant `months` later (UTC); the 31st becomes the last day of a shorter month. */
export function addMonths(at: Date, months: number): Date {
  const out = new Date(at.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

export const pendingExpiresAt = (signupStartedAt: Date): number => epochSeconds(signupStartedAt) + PENDING_TTL_SECONDS;
export const confirmedExpiresAt = (lastActivity: Date): number => epochSeconds(addMonths(lastActivity, CONFIRMED_TTL_MONTHS));
export const logExpiresAt = (at: Date): number => epochSeconds(addMonths(at, LEAD_LOG_TTL_MONTHS));

/** `LEADLOG#<yyyy-mm>` of a real instant. */
export const leadLogPartition = (at: Date): string => `${LEAD_LOG_PREFIX}${at.toISOString().slice(0, 7)}`;

/** Whether a lead is still pending (the `PENDING` of every other document is the absence of `status`). */
export const isPending = (lead: Pick<Lead, "status">): boolean => lead.status === undefined;

/** The consent in force of one id: the last record of its history. */
export function currentConsent(lead: Pick<Lead, "consents">, id: z.infer<typeof ConsentId>): ConsentRecord {
  return lead.consents[id];
}
