// Disposable-mailbox domains `signup.start` refuses (EMAIL_NOT_ACCEPTED, ADR-0025 §3): a code sent to a
// throwaway inbox makes a confirmed account nobody comes back to, takes a sign-up world and its quota,
// and lets one person open accounts without limit. Two lists, one answer: the public, maintained list of
// the `disposable-email-domains` package (data only, pinned, server side only) and the repo's own,
// versioned here for what the public one does not know yet. Lower case, no subdomains (a subdomain of a
// listed domain is refused too). Adding a domain is a pull request.
//
// Reserved and test domains (RFC 2606, RFC 6761) are refused with the same answer: nobody receives mail
// there, so a code sent to them is a bounce of the shared account.
import PUBLIC_DISPOSABLE_DOMAINS from "disposable-email-domains";

export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10mail.org",
  "10minutemail.com",
  "1secmail.com",
  "20minutemail.com",
  "33mail.com",
  "anonaddy.me",
  "blondmail.com",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "emlpro.com",
  "emltmp.com",
  "euploading.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "inboxkitten.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mailpoof.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "spambox.us",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.dev",
  "tempmail.lol",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "vomoto.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

/**
 * Mail servers of disposable services: a new throwaway domain usually points its MX at one of these,
 * so a domain that is not listed yet is refused by its MX (signup/email-domain.ts). Same rules.
 */
export const DISPOSABLE_MX_HOSTS: ReadonlySet<string> = new Set(["smtp.is"]);

/** Second-level names reserved for documentation and tests, and their subdomains. */
const RESERVED_DOMAINS: ReadonlySet<string> = new Set(["example.com", "example.net", "example.org", "test.com"]);

/** Top-level names that never receive mail: the domain itself or anything under it. */
const RESERVED_TLDS: ReadonlySet<string> = new Set(["test", "example", "invalid", "localhost"]);

let publicDomains: ReadonlySet<string> | undefined;

/** The public list as a set, built once per container on the first check. */
function publicList(): ReadonlySet<string> {
  publicDomains ??= new Set(PUBLIC_DISPOSABLE_DOMAINS.map((domain) => domain.toLowerCase()));
  return publicDomains;
}

function matches(list: ReadonlySet<string>, domain: string): boolean {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  for (let start = 0; start < labels.length - 1; start += 1) if (list.has(labels.slice(start).join("."))) return true;
  return false;
}

/** True for a domain of either list or any subdomain of one. */
export function isDisposableDomain(domain: string): boolean {
  return matches(DISPOSABLE_DOMAINS, domain) || matches(publicList(), domain);
}

/** True for a reserved or test domain: `example.com` and its siblings, or a name under `.test`, `.example`, `.invalid`, `.localhost`. */
export function isReservedDomain(domain: string): boolean {
  const name = domain.toLowerCase().replace(/\.$/, "");
  return RESERVED_TLDS.has(name.slice(name.lastIndexOf(".") + 1)) || matches(RESERVED_DOMAINS, name);
}

/** True for a host that is a listed mail server, or that lives under a disposable domain (`mx.yopmail.com`). */
export function isDisposableMxHost(host: string): boolean {
  return matches(DISPOSABLE_MX_HOSTS, host) || isDisposableDomain(host);
}
