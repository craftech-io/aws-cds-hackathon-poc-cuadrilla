// Rules 11 to 15 of docs/design-brief.md §5.7: what the message carries.
//
//   CP-RECIPIENT-FENCE   email only to the world's fence (outbound/recipient-fence.ts decides the
//                        address; the caller passes its verdict) and within the world's daily cap
//   CP-CERT-EVIDENCE     the certificate only for a CLOSED order, with the stored PDF's SHA-256
//   CP-NO-SENSITIVE-ASK  no text asks for IDs, bank or card data, passwords or payments (a person's
//                        text on the bridge is masked, not censored)
//   CP-NO-FOREIGN-LINKS  no link, domain, email or phone; the console link of its own case is the
//                        one URL a zone chief alert may carry
//   CP-CITATION          an agent reply with policy or procedure statements cites a section that
//                        `search_procedures` returned in the same turn, and cites nothing else
//
// The text patterns have one source, copy/forbidden.ts, which also checks every fixed text of copy/.
import { type ContactRule, ManualSectionId } from "@cuadrilla/shared";
import { findForeignLink, findSensitiveAsk } from "../copy/forbidden";
import { type RuleChecks, type RuleOutcome, fail, notApplicable, pass } from "./check";
import { CERTIFICATE_KINDS } from "./kinds";
import type { PolicyInput, PolicyMessage } from "./types";

type ContentRule = Extract<ContactRule, "CP-RECIPIENT-FENCE" | "CP-CERT-EVIDENCE" | "CP-NO-SENSITIVE-ASK" | "CP-NO-FOREIGN-LINKS" | "CP-CITATION">;

/** Origin of the operator console (docs/architecture.md §1). */
export const CONSOLE_ORIGIN = "https://cuadrilla.demo.craftech.io";

/** The console page of a case: the only URL a `ZONE_CHIEF_ALERT` may carry (it requires a login). */
export function consoleCaseUrl(caseId: string): string {
  return `${CONSOLE_ORIGIN}/app/cases/${caseId}`;
}

const SECTION_REF = /§\s*([A-Z]{2,4}-\d{2})\b/g;

/** Manual sections a text cites in the "(Manual v1, §COM-04)" form, without repeats. */
export function sectionsCitedIn(text: string): string[] {
  const cited = [...text.matchAll(SECTION_REF)].map((match) => match[1] ?? "");
  return [...new Set(cited.filter((section) => ManualSectionId.safeParse(section).success))];
}

function recipientFence({ recipient }: PolicyInput): RuleOutcome {
  if (recipient.kind !== "EMAIL") return notApplicable();
  if (!recipient.fence.allowed) return fail("RECIPIENT_NOT_ALLOWED", { detail: recipient.fence.reason ?? "outside the world's fence" });
  if (recipient.emailsLeftToday === 0) return fail("EMAIL_CAP_REACHED", { detail: "the world's daily email cap is spent" });
  return pass({ detail: recipient.fence.reason ?? recipient.role });
}

function certificateEvidence({ message, facts }: PolicyInput): RuleOutcome {
  if (!CERTIFICATE_KINDS.has(message.kind)) return notApplicable();
  const certificate = facts.certificate;
  if (certificate === undefined) return fail("CERT_MISSING", { detail: "no order or certificate" });
  if (certificate.workOrderStatus !== "CLOSED") return fail("CERT_ORDER_NOT_CLOSED", { detail: `order ${certificate.workOrderStatus}` });
  if (certificate.sha256 === undefined) return fail("CERT_MISSING", { detail: "the certificate has no PDF yet" });
  if (message.attachmentSha256 !== certificate.sha256) {
    return fail("CERT_HASH_MISMATCH", { detail: message.attachmentSha256 === undefined ? "no attachment" : "attachment is not the stored certificate" });
  }
  return pass({ detail: `sha256 ${certificate.sha256.slice(0, 12)}` });
}

function textOf(message: PolicyMessage): string | undefined {
  return message.text !== undefined && message.text.trim() !== "" ? message.text : undefined;
}

function noSensitiveAsk({ message }: PolicyInput): RuleOutcome {
  const text = textOf(message);
  if (text === undefined) return notApplicable();
  if (message.author === "PERSON") return notApplicable({ detail: "a person's text is masked, not censored" });
  const pattern = findSensitiveAsk(text);
  return pattern === null ? pass() : fail("SENSITIVE_ASK", { detail: `pattern ${pattern}` });
}

function noForeignLinks({ message }: PolicyInput): RuleOutcome {
  const text = textOf(message);
  if (text === undefined) return notApplicable();
  const allowedUrls = message.kind === "ZONE_CHIEF_ALERT" && message.caseId !== undefined ? [consoleCaseUrl(message.caseId)] : [];
  const pattern = findForeignLink(text, { allowedUrls });
  return pattern === null ? pass() : fail("FOREIGN_LINK", { detail: `pattern ${pattern}` });
}

function citation({ message, facts }: PolicyInput): RuleOutcome {
  if (message.kind !== "REPLY" || message.author !== "AGENT") return notApplicable();
  const cited = [...new Set([...message.citations, ...sectionsCitedIn(message.text ?? "")])];
  if (cited.length === 0) {
    return message.claimsPolicy ? fail("CITATION_MISSING", { detail: "policy or procedure without a manual section" }) : notApplicable({ detail: "no policy statement" });
  }
  if (facts.turnSections === undefined) return fail("TURN_SECTIONS_UNKNOWN", { detail: "the turn's search_procedures results are not known" });
  const returned = new Set(facts.turnSections);
  const outside = cited.filter((section) => !returned.has(section));
  if (outside.length > 0) return fail("CITATION_NOT_IN_TURN", { detail: `not returned in the turn: ${outside.join(", ")}` });
  return pass({ detail: cited.join(", ") });
}

export const CONTENT_CHECKS: RuleChecks<ContentRule> = {
  "CP-RECIPIENT-FENCE": recipientFence,
  "CP-CERT-EVIDENCE": certificateEvidence,
  "CP-NO-SENSITIVE-ASK": noSensitiveAsk,
  "CP-NO-FOREIGN-LINKS": noForeignLinks,
  "CP-CITATION": citation,
};
