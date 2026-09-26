// Validation of the two consents of the sign-up form against their single source,
// packages/shared/src/legal/consents.ts (ADR-0026): `signup.start` answers `INVALID` for a version other
// than the one in force or for `TERMS_PRIVACY` not accepted. What it stores is one record per consent
// with the server's real clock, the version shown and the language of the form. The error never
// quotes the request: only which consent and why.
import { ToolError } from "@cuadrilla/shared";
import { CONSENTS, CONSENT_IDS, type ConsentAnswers, type ConsentId, type LegalLocale } from "@cuadrilla/shared/legal/consents";
import type { ConsentRecord } from "./model";

export type ConsentIssue = { readonly id: ConsentId; readonly reason: "STALE_VERSION" | "REQUIRED" };

/** Why the answers cannot create an account; empty when they can. */
export function consentIssues(answers: ConsentAnswers): ConsentIssue[] {
  const issues: ConsentIssue[] = [];
  for (const id of CONSENT_IDS) {
    const answer = answers[id];
    const definition = CONSENTS[id];
    if (answer.textVersion !== definition.textVersion) issues.push({ id, reason: "STALE_VERSION" });
    else if (definition.required && !answer.accepted) issues.push({ id, reason: "REQUIRED" });
  }
  return issues;
}

/** Throws `INVALID` (reason `CONSENT_<id>_<why>`) when an answer does not match the consents in force. */
export function assertConsents(answers: ConsentAnswers): void {
  const [issue] = consentIssues(answers);
  if (issue !== undefined) throw new ToolError("INVALID", "the consents do not match the version in force", `CONSENT_${issue.id}_${issue.reason}`);
}

/** The two records the lead stores for one start: accepted or not, when (real clock), which version, which language. */
export function consentRecords(answers: ConsentAnswers, locale: LegalLocale, at: Date): { readonly TERMS_PRIVACY: ConsentRecord; readonly CONTACT: ConsentRecord } {
  assertConsents(answers);
  const record = (id: ConsentId): ConsentRecord => ({ id, accepted: answers[id].accepted, at: at.toISOString(), textVersion: CONSENTS[id].textVersion, locale });
  return { TERMS_PRIVACY: record("TERMS_PRIVACY"), CONTACT: record("CONTACT") };
}

/** `leads:unsubscribe`: the contact consent withdrawn, with the version in force (art. 27, Ley 25.326). */
export function contactWithdrawal(locale: LegalLocale, at: Date): ConsentRecord {
  return { id: "CONTACT", accepted: false, at: at.toISOString(), textVersion: CONSENTS.CONTACT.textVersion, locale };
}
