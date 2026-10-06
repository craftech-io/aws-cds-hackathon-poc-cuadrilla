// Deterministic verification of every outbound text (docs/design-brief.md §5.5), what G2 does not
// guarantee. It runs after G2 and before the transport:
//
//   FACTS      every power figure, serial, order number, time, date, amount and length of a text the
//              agent wrote (or a summary it wrote) exists in the tool results of the turn (facts.ts)
//   CITATION   a policy or procedure statement of an agent's REPLY cites a section, and every section
//              it cites (in `refs.citations` or as "§XXX-00") was returned by `search_procedures` in
//              the turn (`CP-CITATION`)
//   SENSITIVE  no text asks for IDs, bank or card data, passwords or payments (`CP-NO-SENSITIVE-ASK`;
//              a person's text on the bridge is masked, not censored)
//   LINKS      no link, domain, email or phone (`CP-NO-FOREIGN-LINKS`; the zone chief alert's console
//              link is the one allowed URL)
//   LANGUAGE   Spanish; a fixed text or a person's message fails only when it is clearly English
//
// Template parameters are checked for sensitive asks and links one by one (their PII goes to G3). A
// failure is `GROUNDING_FAIL`; its detail names checks and fact kinds, never the text.
import { checkOutboundText, findSensitiveAsk } from "../../copy/forbidden";
import { sectionsCitedIn } from "../../policy/rules-content";
import { detectLanguage } from "../../services/language/language";
import { claimsPolicy } from "./claims";
import { collectSourceFacts, ungroundedFacts } from "./facts";

export { claimsPolicy } from "./claims";
export { CANONICAL_MINUS, containsWords, normalizeFacts, numberOf } from "./normalize";

/** Who wrote the words: the agent (checked against the turn), the code (copy/) or a person on the bridge. */
export type TextSource = "MODEL" | "CODE" | "PERSON";

export type VerifyCheck = "FACTS" | "CITATION" | "SENSITIVE" | "LINKS" | "LANGUAGE";

export interface VerifyFailure {
  readonly check: VerifyCheck;
  /** Ids, fact kinds and pattern ids only; never the text. */
  readonly detail: string;
}

export interface VerifyInput {
  readonly textSource: TextSource;
  readonly text?: string;
  readonly templateParams?: readonly string[];
  /** Redacted tool outputs of the turn (`Runtime/TURN#`). */
  readonly sources: readonly unknown[];
  /** Only for an agent's `REPLY`: the sections it cites and the ones the turn returned. */
  readonly citation?: { readonly cited: readonly string[]; readonly turnSections?: readonly string[] };
  /** The one URL the message may carry (`ZONE_CHIEF_ALERT`). */
  readonly allowedUrls?: readonly string[];
}

function languageFailure(source: TextSource, text: string): VerifyFailure | undefined {
  const { language } = detectLanguage(text);
  if (language === "es") return undefined;
  if (source !== "MODEL" && language === "und") return undefined;
  return { check: "LANGUAGE", detail: `the text must be in Spanish (detected ${language})` };
}

function citationFailure(text: string, citation: NonNullable<VerifyInput["citation"]>): VerifyFailure | undefined {
  const cited = [...new Set([...citation.cited, ...sectionsCitedIn(text)])];
  if (cited.length === 0) return claimsPolicy(text) ? { check: "CITATION", detail: "a policy or procedure statement without a manual section of this turn" } : undefined;
  const returned = new Set(citation.turnSections ?? []);
  const outside = cited.filter((section) => !returned.has(section));
  return outside.length === 0 ? undefined : { check: "CITATION", detail: `sections not returned by search_procedures in this turn: ${outside.join(", ")}` };
}

function textFailures(source: TextSource, text: string, allowedUrls: readonly string[]): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  for (const finding of checkOutboundText(text, { allowedUrls })) {
    if (finding.rule === "CP-NO-SENSITIVE-ASK" && source !== "PERSON") failures.push({ check: "SENSITIVE", detail: `pattern ${finding.patternId}` });
    if (finding.rule === "CP-NO-FOREIGN-LINKS") failures.push({ check: "LINKS", detail: `pattern ${finding.patternId}` });
  }
  return failures;
}

/** Every failed check of an outbound text; empty when it may go out. */
export function verifyContent(input: VerifyInput): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  const allowedUrls = input.allowedUrls ?? [];
  const { text } = input;
  if (text !== undefined && text.trim() !== "") {
    failures.push(...textFailures(input.textSource, text, allowedUrls));
    const language = languageFailure(input.textSource, text);
    if (language !== undefined) failures.push(language);
    if (input.textSource === "MODEL") {
      const ungrounded = ungroundedFacts(text, collectSourceFacts(input.sources));
      if (ungrounded.length > 0) failures.push({ check: "FACTS", detail: `not in this turn's tool results: ${[...new Set(ungrounded)].slice(0, 5).join(", ")}` });
      const citation = input.citation === undefined ? undefined : citationFailure(text, input.citation);
      if (citation !== undefined) failures.push(citation);
    }
  }
  (input.templateParams ?? []).forEach((param, index) => {
    if (findSensitiveAsk(param) !== null) failures.push({ check: "SENSITIVE", detail: `template parameter ${index + 1}` });
    if (checkOutboundText(param, { allowedUrls }).some((finding) => finding.rule === "CP-NO-FOREIGN-LINKS")) failures.push({ check: "LINKS", detail: `template parameter ${index + 1}` });
  });
  return failures;
}
