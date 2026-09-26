import { describe, expect, it } from "vitest";
import { acceptsDemoRecipients, fenceEmailRecipient, isReservedDomain, normalizedDemoRecipients } from "./recipient-fence";

// Worlds of every kind (docs/seed-spec.md §3).
const DEMO = "GLOBAL#isp-demo";
const JUDGE = "JUDGE#isp-judge-07";
const JUDGE_TEST = "JUDGE#isp-judge-test";
const QA = "qa-812-1-sc11-fence";
const EVAL = "eval-812-1";
const WORLDS = [DEMO, JUDGE, JUDGE_TEST, QA, EVAL];

// A registered demo mailbox (`SeedOverrides.demoRecipients.emails`); the domain is invented for the test.
const DEMO_MAILBOX = "bandeja@equipo-demo-ficticio.mx";
const OPTIONS = { demoRecipients: [DEMO_MAILBOX, "not an address"] };

describe("fenceEmailRecipient [FL-076]", () => {
  it.each(WORLDS)("[FL-076] admits the SES mailbox simulator in %s, with its success, bounce and complaint tags", (clockId) => {
    for (const address of ["success+c10421@simulator.amazonses.com", "bounce+c10431@simulator.amazonses.com", "complaint+j07-c10433@simulator.amazonses.com", "success+zc-marisol@simulator.amazonses.com"]) {
      expect(fenceEmailRecipient(address, clockId, OPTIONS)).toEqual({ allowed: true, ruleId: "CP-RECIPIENT-FENCE", address, recipientClass: "SES_SIMULATOR" });
    }
  });

  it("[FL-076] compares the simulator domain case-insensitively and answers the normalized address", () => {
    expect(fenceEmailRecipient("SUCCESS+C10421@SIMULATOR.AMAZONSES.COM", QA)).toMatchObject({ allowed: true, address: "success+c10421@simulator.amazonses.com" });
  });

  it("[FL-076] admits the registered demo mailboxes only in the operator's demo world", () => {
    expect(fenceEmailRecipient(DEMO_MAILBOX, DEMO, OPTIONS)).toEqual({ allowed: true, ruleId: "CP-RECIPIENT-FENCE", address: DEMO_MAILBOX, recipientClass: "DEMO_RECIPIENT" });
    expect(fenceEmailRecipient("Bandeja@Equipo-Demo-Ficticio.MX", DEMO, OPTIONS)).toMatchObject({ allowed: true, recipientClass: "DEMO_RECIPIENT" });
    for (const clockId of [JUDGE, JUDGE_TEST, QA, EVAL]) {
      expect(fenceEmailRecipient(DEMO_MAILBOX, clockId, OPTIONS)).toEqual({ allowed: false, ruleId: "CP-RECIPIENT-FENCE", reason: "DEMO_RECIPIENT_OUTSIDE_DEMO_WORLD" });
    }
    expect(acceptsDemoRecipients(DEMO)).toBe(true);
    expect(acceptsDemoRecipients(JUDGE)).toBe(false);
    expect(normalizedDemoRecipients(OPTIONS.demoRecipients)).toEqual(new Set([DEMO_MAILBOX]));
  });

  it.each(WORLDS)("[FL-076] never sends to our own domain, which has no mailboxes (%s)", (clockId) => {
    for (const address of ["actas@cuadrilla.demo.craftech.io", "avisos@cuadrilla.demo.craftech.io", "x@bounce.cuadrilla.demo.craftech.io", "ACTAS@CUADRILLA.DEMO.CRAFTECH.IO"]) {
      expect(fenceEmailRecipient(address, clockId, { demoRecipients: [address] })).toMatchObject({ allowed: false, reason: "OWN_DOMAIN" });
    }
  });

  it("[FL-076] never sends into the shared demo zone of other apps", () => {
    expect(fenceEmailRecipient("inbox@otra-app.demo.craftech.io", DEMO, { demoRecipients: ["inbox@otra-app.demo.craftech.io"] })).toMatchObject({ allowed: false, reason: "DEMO_ZONE" });
    expect(fenceEmailRecipient("x@demo.craftech.io", DEMO)).toMatchObject({ allowed: false, reason: "DEMO_ZONE" });
  });

  it("[FL-076] never sends to reserved domains (RFC 2606, RFC 6761), even when registered", () => {
    for (const address of ["cliente@example.com", "cliente@mail.example.org", "a@example.net", "a@buzon.test", "a@x.example", "a@y.invalid", "a@z.localhost"]) {
      expect(fenceEmailRecipient(address, DEMO, { demoRecipients: [address] })).toMatchObject({ allowed: false, reason: "RESERVED_DOMAIN" });
    }
    expect(isReservedDomain("examplecom.mx")).toBe(false);
  });

  it("[FL-076] refuses misleading suffixes and lookalikes of the simulator", () => {
    expect(fenceEmailRecipient("success@simulator.amazonses.com.attacker.example", QA)).toMatchObject({ allowed: false, reason: "RESERVED_DOMAIN" });
    for (const address of ["success@simulator.amazonses.com.attacker.io", "success@evilsimulator.amazonses.com", "success@sub.simulator.amazonses.com", "success@simulator-amazonses.com", "success@amazonses.com"]) {
      expect(fenceEmailRecipient(address, QA)).toEqual({ allowed: false, ruleId: "CP-RECIPIENT-FENCE", reason: "NOT_ALLOWED" });
    }
  });

  it("[FL-076] refuses what the strict parser refuses: trailing dot, quotes, IDN, CR/LF, display names", () => {
    const cases: Array<[string, string]> = [
      ["success@simulator.amazonses.com.", "TRAILING_DOT"],
      ['"success"@simulator.amazonses.com', "QUOTED"],
      ["success@xn--simulatr-u9a.amazonses.com", "IDN"],
      [`success@simulat${String.fromCodePoint(0xf6)}r.amazonses.com`, "NON_ASCII"],
      ["success@simulator.amazonses.com\nBcc: otro@simulator.amazonses.com", "CONTROL_CHARACTER"],
      ["Cliente <success@simulator.amazonses.com>", "WHITESPACE"],
    ];
    for (const [address, addressError] of cases) {
      expect(fenceEmailRecipient(address, DEMO, { demoRecipients: [address] })).toEqual({ allowed: false, ruleId: "CP-RECIPIENT-FENCE", reason: "INVALID_ADDRESS", addressError });
    }
  });

  it("[FL-076] refuses any other address in every world, and an invalid world outright", () => {
    for (const clockId of WORLDS) expect(fenceEmailRecipient("alguien@correo-cualquiera.mx", clockId, OPTIONS)).toMatchObject({ allowed: false, reason: "NOT_ALLOWED" });
    expect(() => fenceEmailRecipient("success@simulator.amazonses.com", "JUDGE#otro")).toThrow();
  });
});
