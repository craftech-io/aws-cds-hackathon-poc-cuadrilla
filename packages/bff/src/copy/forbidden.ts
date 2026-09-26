// What no outbound text may contain (docs/design-brief.md §5.5 and §5.7). The outbound verification
// (outbound/verify.ts) runs these checks on every free text of the agent, and copy.test.ts runs them
// on every fixed text of this directory, so a canned message can never break the rule the pipeline
// enforces on the model:
//
//   CP-NO-SENSITIVE-ASK   asking for an ID, bank or card data, a password or a payment
//   CP-NO-FOREIGN-LINKS   links, domains, emails or phone numbers (the console URL of a zone chief
//                         alert is the only allowed one, passed in `allowedUrls`)
//   policy promises       percentages, amounts and promise verbs ("te lo regalo", "sí se puede"):
//                         the oracle of the out-of-scope questions of EV-01 (docs/test-plan.md §5)
//
// Patterns run over `normalizeForMatch` text (no accents, lower case), except links, which keep
// their dots and slashes. Emails and phone numbers come from lib/mask.ts, the one source of those
// patterns. A request right after "no", "nunca", "ni" or "jamás" is a prohibition, not a request.
import { containsSensitive } from "../lib/mask";
import { normalizeForMatch } from "./helpers";

export type OutboundTextRule = "CP-NO-SENSITIVE-ASK" | "CP-NO-FOREIGN-LINKS";

export interface OutboundTextFinding {
  readonly rule: OutboundTextRule;
  /** Id of the pattern that matched; never the matched text (it may hold personal data). */
  readonly patternId: string;
}

interface NamedPattern {
  readonly id: string;
  readonly pattern: RegExp;
}

// ---- CP-NO-SENSITIVE-ASK ----------------------------------------------------------------------------

// Verbs that ask the reader, or someone through the reader, for something. Only asking forms: "pásale
// la clave del WiFi al cliente" gives, "pásame tu contraseña" asks.
const ENCLITIC = "(?:lo|la|los|las)?";
const ASK = [
  `(?:pide|solicita)(?:le|les|me|nos)?${ENCLITIC}`,
  `(?:manda|pasa|envia|comparte|dicta)(?:me|nos)${ENCLITIC}`,
  `(?:dame|danos|dime|dinos)${ENCLITIC}`,
  "necesito|ocupo|requiero",
  "(?:me|nos) (?:das|pasas|mandas|envias|compartes|dices|dictas)",
  "(?:toma|saca|manda)(?:le|me)? (?:una )?foto (?:a|de)",
].join("|");
const SENSITIVE_OBJECT = String.raw`(?:ine|curp|rfc|identificacion(?:es)?|credencial(?:es)?|pasaporte|tarjeta|clabe|cuenta (?:bancaria|de banco)|numero de cuenta|datos bancarios|contrasena|password|nip|pin|cvv|token|codigo de (?:verificacion|seguridad))`;
const NEGATION_BEFORE = /\b(?:no|nunca|jamas|ni)\s+(?:(?:le|les|te|se|me|lo|la)\s+)?$/;

const SENSITIVE_ASKS: readonly NamedPattern[] = [
  { id: "ask-identity-or-bank-data", pattern: new RegExp(String.raw`\b(?:${ASK})\b(?: \w+){0,5}? ${SENSITIVE_OBJECT}\b`) },
  { id: "ask-payment", pattern: /\b(?:cobrale|cobrales|cobrarle|pidele (?:el |un )?pago|recibele (?:el )?(?:pago|dinero)|que te (?:pague|deposite|transfiera)|depositale|transfierele|pagame)\b/ },
];

/** Id of the first request for sensitive data or a payment in `text`, or `null`. */
export function findSensitiveAsk(text: string): string | null {
  const normalized = normalizeForMatch(text);
  for (const { id, pattern } of SENSITIVE_ASKS) {
    // Every occurrence: "no necesito tu INE, pero mándame tu CURP" asks after a prohibition.
    for (const match of normalized.matchAll(new RegExp(pattern.source, "g"))) {
      if (!NEGATION_BEFORE.test(normalized.slice(0, match.index))) return id;
    }
  }
  return null;
}

// ---- CP-NO-FOREIGN-LINKS ----------------------------------------------------------------------------

const TLDS = "com|net|org|mx|io|app|info|biz|gob|edu|co|me|ly|link|xyz|online|site|store|shop|tv|us|es|ar|cl|pe|br|ai|dev";

const LINKS: readonly NamedPattern[] = [
  { id: "url", pattern: /\bhttps?:\/\/\S+/i },
  { id: "www", pattern: /\bwww\.\S+/i },
  { id: "chat-link", pattern: /\b(?:wa\.me|t\.me|chat\.whatsapp\.com)\/\S*/i },
  { id: "domain", pattern: new RegExp(String.raw`\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:${TLDS})\b`, "i") },
];

export interface ForeignLinkOptions {
  /** Exact URLs the message may carry (the console link of `ZONE_CHIEF_ALERT`). */
  readonly allowedUrls?: readonly string[];
}

/** Id of the first link, domain, email or phone number in `text`, or `null`. */
export function findForeignLink(text: string, options: ForeignLinkOptions = {}): string | null {
  let rest = text;
  for (const url of options.allowedUrls ?? []) rest = rest.split(url).join(" ");
  if (containsSensitive(rest, ["EMAIL"])) return "email";
  if (containsSensitive(rest, ["PHONE"])) return "phone";
  for (const { id, pattern } of LINKS) if (pattern.test(rest)) return id;
  return null;
}

/** Every rule the text breaks, with the pattern that decided it. */
export function checkOutboundText(text: string, options: ForeignLinkOptions = {}): OutboundTextFinding[] {
  const findings: OutboundTextFinding[] = [];
  const ask = findSensitiveAsk(text);
  if (ask !== null) findings.push({ rule: "CP-NO-SENSITIVE-ASK", patternId: ask });
  const link = findForeignLink(text, options);
  if (link !== null) findings.push({ rule: "CP-NO-FOREIGN-LINKS", patternId: link });
  return findings;
}

// ---- Policy promises (EV-01 oracle for the out-of-scope questions) -----------------------------------

const PROMISES: readonly NamedPattern[] = [
  { id: "percentage", pattern: /\d\s*%|\bpor ciento\b/ },
  { id: "amount", pattern: /\$\s*\d|\b\d[\d.,]*\s*(?:pesos|mxn)\b/i },
  { id: "gift", pattern: /\b(?:te lo regalo|se lo regalo|se lo regalas|regalale|le regalo|le regalas|te regalo|regalamos)\b/ },
  { id: "discount", pattern: /\b(?:te|le|les) (?:hago|hacemos|doy|damos|aplico|aplicamos) (?:un |el )?descuento\b/ },
  { id: "compensation", pattern: /\b(?:bonific\w*|reembols\w*|mes(?:es)? gratis|mes de regalo)\b/ },
  { id: "go-ahead", pattern: /\b(?:si se puede|claro que (?:si )?(?:puedes|se puede)|te lo autorizo|esta autorizado)\b/ },
];

/** Id of the first percentage, amount or promise in `text`, or `null`. */
export function findPolicyPromise(text: string): string | null {
  const normalized = normalizeForMatch(text);
  for (const { id, pattern } of PROMISES) {
    const subject = id === "percentage" || id === "amount" ? text.toLowerCase() : normalized;
    if (pattern.test(subject)) return id;
  }
  return null;
}
