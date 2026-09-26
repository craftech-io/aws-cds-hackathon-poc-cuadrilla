// Fixtures of the lead tests (never imported by a Lambda): a memory `Leads` table, deterministic ids,
// the `email-hash` subkey of a test master key, and a lead started and confirmed through the store
// itself, so every fixture is a lead the real code could have written. Addresses are `@example.com`
// or the mailbox simulator; notice recipients are `@craftech.io` fixtures, never a real mailbox.
import { CONSENTS_VERSION, type ConsentAnswers } from "@cuadrilla/shared/legal/consents";
import { deriveSubkey } from "../lib/crypto";
import { consentRecords } from "./consent";
import { leadAbuseHash, leadEmailHash, leadOriginOf } from "./keys";
import { MemoryLeadTable } from "./memory-table";
import type { Lead } from "./model";
import { type LeadStore, createLeadStore } from "./store";

export const TEST_MASTER_KEY = "test-master-key-test-master-key-00000000";
export const EMAIL_KEY = deriveSubkey(TEST_MASTER_KEY, "email-hash");
export const hashOf = (email: string): string => leadEmailHash(EMAIL_KEY, email);

export const T0 = new Date("2026-10-01T15:00:00.000Z");
export const NOTIFY_FIXTURE = "leads-fixture@craftech.io";

/** Crockford ULIDs in sequence: 01K…0001, 01K…0002, … */
export function sequentialIds(prefix = "01K6"): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}${next.toString(32).toUpperCase().replace(/[ILOU]/g, "0").padStart(26 - prefix.length, "0")}`;
  };
}

/** `gst-<ULID>` for the n-th user of a test. */
export const username = (n: number): string => `gst-01K6${String(n).padStart(22, "0")}`;
/** `usr-g<ULID>` for the n-th console user of a test. */
export const signupUserId = (n: number): string => `usr-g01K6${String(n).padStart(22, "0")}`;

export function answers(contact: boolean, terms = true, version: string = CONSENTS_VERSION): ConsentAnswers {
  return { TERMS_PRIVACY: { accepted: terms, textVersion: version }, CONTACT: { accepted: contact, textVersion: version } };
}

export interface LeadHarness {
  readonly table: MemoryLeadTable;
  readonly store: LeadStore;
}

export function leadHarness(): LeadHarness {
  const table = new MemoryLeadTable();
  return { table, store: createLeadStore(table, { newId: sequentialIds() }) };
}

export interface StartOptions {
  readonly email?: string;
  readonly user?: number;
  readonly contact?: boolean;
  readonly at?: Date;
  readonly name?: string;
  readonly company?: string;
  readonly jobTitle?: string;
}

/** `signup.start` as the store sees it. */
export async function startLead(store: LeadStore, options: StartOptions = {}) {
  const email = options.email ?? "ana.prueba@example.com";
  const at = options.at ?? T0;
  return store.startPending({
    emailHash: hashOf(email),
    email,
    abuseHash: leadAbuseHash(EMAIL_KEY, email),
    username: username(options.user ?? 1),
    locale: "es-MX",
    origin: leadOriginOf(email),
    name: options.name,
    company: options.company,
    jobTitle: options.jobTitle,
    utm: { source: "linkedin", campaign: "fibra-2026" },
    referrerOrigin: "https://example.org",
    consents: consentRecords(answers(options.contact ?? true), "es-MX", at),
    at,
  });
}

/** A lead started by user `user` and confirmed by post-confirmation. */
export async function confirmedLead(store: LeadStore, options: StartOptions & { readonly sub?: string; readonly userId?: string } = {}): Promise<Lead> {
  const email = options.email ?? "ana.prueba@example.com";
  await startLead(store, options);
  const result = await store.confirm({ emailHash: hashOf(email), username: username(options.user ?? 1), sub: options.sub ?? "sub-0001", userId: options.userId ?? signupUserId(1), at: options.at ?? T0 });
  if (result.outcome !== "CONFIRMED") throw new Error("the fixture lead did not confirm");
  return result.lead;
}
