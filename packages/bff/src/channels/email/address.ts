// Strict RFC 5322 address parser of the recipient fence (docs/architecture-integrations.md §1): one
// `addr-spec` in dot-atom form and nothing else. Everything a mailer would tolerate but a fence must
// not is refused with its reason: quoted local parts, comments, display names, whitespace, CR/LF or
// any control character, non-ASCII (and so IDN, also in its `xn--` form), IP literals, a trailing
// dot, more than one `@`. The domain is compared lower-case and exactly, so
// `simulator.amazonses.com.attacker.example` is never the simulator. Pure: no DNS, no SDK.
import { z } from "zod";

/** RFC 5321 limits: 64 octets of local part, 254 of path (255 minus the brackets' null), 253 of domain. */
export const MAX_LOCAL_PART = 64;
export const MAX_ADDRESS = 254;
export const MAX_DOMAIN = 253;

export const AddressError = z.enum([
  "EMPTY",
  "TOO_LONG",
  "CONTROL_CHARACTER",
  "WHITESPACE",
  "NON_ASCII",
  "QUOTED",
  "DISPLAY_NAME",
  "MISSING_AT",
  "MULTIPLE_AT",
  "BAD_LOCAL_PART",
  "IP_LITERAL",
  "TRAILING_DOT",
  "IDN",
  "BAD_DOMAIN",
]);
export type AddressError = z.infer<typeof AddressError>;

export interface EmailAddress {
  /** Local part as written (case kept for display; SES and the fence compare lower-case). */
  readonly localPart: string;
  /** Lower-case domain without a trailing dot. */
  readonly domain: string;
  /** `local@domain`, all lower-case: the form every comparison, hash and send uses. */
  readonly normalized: string;
}

export type AddressParse = { readonly ok: true; readonly address: EmailAddress } | { readonly ok: false; readonly error: AddressError };

// atext of RFC 5322 §3.2.3, in dot-atom form: no leading, trailing or doubled dots.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const DOT_ATOM = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*$`);
// LDH labels (RFC 1123): letters, digits and inner hyphens, 63 characters at most.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^[a-z]{2,63}$/;

function failure(error: AddressError): AddressParse {
  return { ok: false, error };
}

function domainError(domain: string): AddressError | undefined {
  if (domain.startsWith("[")) return "IP_LITERAL";
  if (domain.endsWith(".")) return "TRAILING_DOT";
  if (domain.length === 0 || domain.length > MAX_DOMAIN) return "BAD_DOMAIN";
  const labels = domain.split(".");
  if (labels.some((label) => label.startsWith("xn--"))) return "IDN";
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return "BAD_DOMAIN";
  return TLD.test(labels[labels.length - 1] ?? "") ? undefined : "BAD_DOMAIN";
}

/** Parses one address exactly as given (no trimming: surrounding whitespace is an error). */
export function parseEmailAddress(raw: string): AddressParse {
  if (raw.length === 0) return failure("EMPTY");
  if (raw.length > MAX_ADDRESS) return failure("TOO_LONG");
  if (/[\u0000-\u001F\u007F]/.test(raw)) return failure("CONTROL_CHARACTER");
  if (/[^\x20-\x7E]/.test(raw)) return failure("NON_ASCII");
  if (/\s/.test(raw)) return failure("WHITESPACE");
  if (raw.includes('"')) return failure("QUOTED");
  if (/[<>()]/.test(raw)) return failure("DISPLAY_NAME");
  const at = raw.indexOf("@");
  if (at === -1) return failure("MISSING_AT");
  if (raw.indexOf("@", at + 1) !== -1) return failure("MULTIPLE_AT");
  const localPart = raw.slice(0, at);
  if (localPart.length === 0 || localPart.length > MAX_LOCAL_PART || !DOT_ATOM.test(localPart)) return failure("BAD_LOCAL_PART");
  const domain = raw.slice(at + 1).toLowerCase();
  const error = domainError(domain);
  if (error !== undefined) return failure(error);
  return { ok: true, address: { localPart, domain, normalized: `${localPart.toLowerCase()}@${domain}` } };
}

/** True when `domain` is `parent` or one of its subdomains (exact label match, never a suffix of a label). */
export function isWithinDomain(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}
