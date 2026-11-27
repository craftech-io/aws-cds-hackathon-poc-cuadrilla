// Disposable-mailbox domains `signup.start` refuses (EMAIL_NOT_ACCEPTED, ADR-0025 §3): a code sent to a
// throwaway inbox makes a confirmed account nobody comes back to, takes a sign-up world and its quota,
// and lets one person open accounts without limit. Versioned here, lower case, no subdomains (a
// subdomain of a listed domain is refused too). Adding a domain is a pull request.
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com",
  "20minutemail.com",
  "33mail.com",
  "anonaddy.me",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
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
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

/** True for a listed domain or any subdomain of one. */
export function isDisposableDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split(".");
  for (let start = 0; start < labels.length - 1; start += 1) if (DISPOSABLE_DOMAINS.has(labels.slice(start).join("."))) return true;
  return false;
}
