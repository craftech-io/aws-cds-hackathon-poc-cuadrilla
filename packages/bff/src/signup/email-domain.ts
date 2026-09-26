// Can the domain of the email receive mail at all (ADR-0025 §3)? Authentication emails are the only
// ones of the shared account that go to addresses nobody verified: a typo or a made-up domain is a hard
// bounce, and bounces feed the SES reputation of the whole account. Checked before anything is written:
//
//   MX records               → OK, unless the only one is the null MX of RFC 7505 (`0 .`) → INVALID
//   no MX, but A or AAAA     → OK (RFC 5321 §5.1, implicit MX)
//   no MX, no A, no AAAA     → INVALID
//   the 1 s deadline passed, or the resolver failed otherwise → UNKNOWN: the start goes on (metric
//   `SignupMxUnknown`), a flaky resolver never blocks a real visitor
import { resolve4, resolve6, resolveMx } from "node:dns/promises";
import { withDeadline } from "../lib/deadline";

/** The whole check, all lookups together (ADR-0025 §3). */
export const EMAIL_DOMAIN_DEADLINE_MS = 1_000;

export interface MxRecord {
  readonly exchange: string;
  readonly priority: number;
}

/** The lookups the check makes; node's resolver in a Lambda, a fake in the tests. */
export interface DnsResolver {
  mx(domain: string): Promise<readonly MxRecord[]>;
  a(domain: string): Promise<readonly string[]>;
  aaaa(domain: string): Promise<readonly string[]>;
}

export type EmailDomainVerdict = "OK" | "INVALID" | "UNKNOWN";

export const nodeResolver: DnsResolver = {
  mx: (domain) => resolveMx(domain),
  a: (domain) => resolve4(domain),
  aaaa: (domain) => resolve6(domain),
};

// The answers that mean "this name has no such record" (or no such name); anything else is a failure.
const ABSENT = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN", "ENONAME"]);

function isAbsent(error: unknown): boolean {
  return error instanceof Error && ABSENT.has(String(Reflect.get(error, "code") ?? ""));
}

async function records<T>(lookup: () => Promise<readonly T[]>): Promise<readonly T[]> {
  try {
    return await lookup();
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
}

const isNullMx = (record: MxRecord): boolean => record.priority === 0 && (record.exchange === "" || record.exchange === ".");

async function check(domain: string, resolver: DnsResolver): Promise<EmailDomainVerdict> {
  const mx = await records(() => resolver.mx(domain));
  if (mx.length > 0) return mx.length === 1 && mx[0] !== undefined && isNullMx(mx[0]) ? "INVALID" : "OK";
  const [a, aaaa] = await Promise.all([records(() => resolver.a(domain)), records(() => resolver.aaaa(domain))]);
  return a.length > 0 || aaaa.length > 0 ? "OK" : "INVALID";
}

/** The domain part of a normalized address, as the resolver takes it (no trailing dot). */
export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).replace(/\.$/, "");
}

export async function emailDomainVerdict(email: string, resolver: DnsResolver, deadlineMs: number = EMAIL_DOMAIN_DEADLINE_MS): Promise<EmailDomainVerdict> {
  try {
    return await withDeadline("signup.email_domain", deadlineMs, () => check(domainOf(email), resolver));
  } catch {
    return "UNKNOWN";
  }
}
