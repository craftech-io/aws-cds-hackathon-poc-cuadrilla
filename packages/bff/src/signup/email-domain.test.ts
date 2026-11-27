// The domain of a sign-up email (ADR-0025 §3, docs/test-plan.md, FL-104): the public and the own list of
// disposable mailboxes, reserved and test domains, and the DNS verdict with a fake resolver (never a
// real lookup).
import { describe, expect, it } from "vitest";
import { DISPOSABLE_DOMAINS, DISPOSABLE_MX_ADDRESSES, isDisposableDomain, isDisposableMxAddress, isDisposableMxHost, isReservedDomain } from "./disposable-domains";
import { EMAIL_DOMAIN_DEADLINE_MS, emailDomainVerdict } from "./email-domain";
import { fakeResolver } from "./testing";

describe("disposable and reserved domains [FL-104]", () => {
  it("[FL-104] a domain of the public list (or a subdomain of one) is disposable, and so is every domain of the own list", () => {
    for (const domain of ["0-mail.com", "mailinator.com", "inbox.0-mail.com", "Trashmail.WS"]) expect(isDisposableDomain(domain), domain).toBe(true);
    for (const domain of ["euploading.com", "10mail.org", "emltmp.com", "emlpro.com", "vomoto.com", "blondmail.com", "guerrillamailblock.com", "tempmail.lol", "1secmail.com", "mailpwr.com", "mimimail.me", "pickmail.org", "freeml.net", "mailtowin.com", "maximail.vip"]) {
      expect(DISPOSABLE_DOMAINS.has(domain), domain).toBe(true);
      expect(isDisposableDomain(domain), domain).toBe(true);
    }
    for (const domain of ["gmail.com", "outlook.com", "correo-ficticio.mx", "simulator.amazonses.com"]) expect(isDisposableDomain(domain), domain).toBe(false);
  });

  it("[FL-104] reserved and test domains, and anything under the reserved top-level names", () => {
    for (const domain of ["test.com", "example.com", "example.org", "example.net", "mail.example.com", "algo.test", "algo.example", "algo.invalid", "algo.localhost", "localhost", "EXAMPLE.COM."]) {
      expect(isReservedDomain(domain), domain).toBe(true);
    }
    for (const domain of ["contest.com", "example.mx", "testing.io", "gmail.com"]) expect(isReservedDomain(domain), domain).toBe(false);
  });

  it("[FL-104] a mail server of a disposable service, or a host under a disposable domain", () => {
    for (const host of ["smtp.is", "mx.smtp.is.", "mx1.mailinator.com"]) expect(isDisposableMxHost(host), host).toBe(true);
    expect(isDisposableMxHost("gmail-smtp-in.l.google.com")).toBe(false);
  });
});

describe("the DNS verdict of the domain [FL-104]", () => {
  it("[FL-104] answers within 2 s: MX at a disposable server, a name that does not exist, no mail at all, and a resolver that fails or is slow", async () => {
    expect(EMAIL_DOMAIN_DEADLINE_MS).toBe(2_000);
    const resolver = fakeResolver({
      "nuevo.mx": { mx: [{ exchange: "mx.smtp.is", priority: 10 }] },
      "no-existe.mx": { fail: "ENOTFOUND" },
      "sin-correo.mx": {},
      "solo-a.mx": { a: ["192.0.2.7"] },
      "caido.mx": { fail: "ETIMEOUT" },
      "roto.mx": { fail: "ESERVFAIL" },
      "lento.mx": { delayMs: 200 },
    });
    expect(await emailDomainVerdict("ana@nuevo.mx", resolver)).toBe("DISPOSABLE");
    expect(await emailDomainVerdict("ana@no-existe.mx", resolver)).toBe("INVALID");
    expect(await emailDomainVerdict("ana@sin-correo.mx", resolver)).toBe("INVALID");
    expect(await emailDomainVerdict("ana@solo-a.mx", resolver)).toBe("OK");
    expect(await emailDomainVerdict("ana@correo-ficticio.mx", resolver)).toBe("OK");
    expect(await emailDomainVerdict("ana@caido.mx", resolver)).toBe("UNKNOWN");
    expect(await emailDomainVerdict("ana@roto.mx", resolver)).toBe("UNKNOWN");
    expect(await emailDomainVerdict("ana@lento.mx", resolver, 50)).toBe("UNKNOWN");
  });
});

describe("the address of the mail server [FL-104]", () => {
  it("[FL-104] lists the addresses of the disposable services' mail servers, each with its service", () => {
    expect([...DISPOSABLE_MX_ADDRESSES.keys()]).toEqual(["78.47.124.133", "94.130.108.80", "49.12.18.190", "15.204.213.223", "178.162.170.166", "178.32.61.35"]);
    for (const service of DISPOSABLE_MX_ADDRESSES.values()) expect(service.length).toBeGreaterThan(3);
    expect(isDisposableMxAddress(" 94.130.108.80 ")).toBe(true);
    expect(isDisposableMxAddress("142.250.0.27")).toBe(false);
  });

  it("[FL-104] a new domain whose MX resolves to a listed address is DISPOSABLE_ADDRESS; another address is OK; a failed address lookup is OK", async () => {
    const resolver = fakeResolver({
      "nuevo-dominio.mx": { mx: [{ exchange: "mx.nuevo-dominio.mx.", priority: 10 }] },
      "mx.nuevo-dominio.mx": { a: ["78.47.124.133"] },
      "otro-v6.mx": { mx: [{ exchange: "mail.otro-v6.mx", priority: 10 }, { exchange: "backup.otro-v6.mx", priority: 20 }] },
      "mail.otro-v6.mx": { a: ["203.0.113.40"] },
      "backup.otro-v6.mx": { aaaa: ["2001:db8::25"], a: ["178.32.61.35"] },
      "legitimo.mx": { mx: [{ exchange: "mx.legitimo.mx", priority: 10 }] },
      "mx.legitimo.mx": { a: ["203.0.113.25"], aaaa: ["2001:db8::1"] },
      "falla.mx": { mx: [{ exchange: "mx.falla.mx", priority: 10 }] },
      "mx.falla.mx": { fail: "ESERVFAIL" },
    });
    expect(await emailDomainVerdict("ana@nuevo-dominio.mx", resolver)).toBe("DISPOSABLE_ADDRESS");
    expect(await emailDomainVerdict("ana@otro-v6.mx", resolver)).toBe("DISPOSABLE_ADDRESS");
    expect(await emailDomainVerdict("ana@legitimo.mx", resolver)).toBe("OK");
    expect(await emailDomainVerdict("ana@falla.mx", resolver)).toBe("OK");
    expect(resolver.lookups).toContain("a:mx.nuevo-dominio.mx");
  });
});

