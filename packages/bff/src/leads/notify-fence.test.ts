import { describe, expect, it } from "vitest";
import { LeadConfigValue } from "../lib/secret-schemas";
import { fenceLeadNotifyRecipient, fencedNotifyRecipients, isCraftechMailbox } from "./notify-fence";

// Only fixture mailboxes: the real recipients live in the `LeadConfig` secret, never in the code.
const GOOD = "leads-fixture@craftech.io";
const BAD = [
  "a@sub.craftech.io",
  "a@craftech.io.evil.test",
  "craftech.io@otro.example",
  "a@craftech.io@otro.example",
  '"a"@craftech.io',
  "Leads <leads-fixture@craftech.io>",
  "a@craftech.io\r\nBcc: b@example.com",
  "a@craftech.io\n",
  " a@craftech.io",
  "a@crаftech.io",
  "a@xn--crftech-2of.io",
  "a@craftech.co",
  "a@craftech.io.",
  "a@[127.0.0.1]",
  "",
];

describe("fence of the lead notice [FL-116]", () => {
  it("[FL-116] admits a mailbox of the exact domain craftech.io, normalized to lower case", () => {
    expect(fenceLeadNotifyRecipient(GOOD)).toEqual({ allowed: true, address: GOOD });
    expect(fenceLeadNotifyRecipient("Leads-Fixture@CRAFTECH.IO")).toEqual({ allowed: true, address: GOOD });
  });

  it("[FL-116] refuses subdomains, look-alike suffixes, quotes, display names, CR/LF, IDN and anything else", () => {
    for (const address of BAD) expect(isCraftechMailbox(address), JSON.stringify(address)).toBe(false);
    expect(fenceLeadNotifyRecipient("a@sub.craftech.io")).toEqual({ allowed: false, reason: "NOT_CRAFTECH" });
    expect(fenceLeadNotifyRecipient('"a"@craftech.io')).toMatchObject({ allowed: false, reason: "INVALID_ADDRESS", addressError: "QUOTED" });
  });

  it("[FL-116] the zod of LeadConfig refuses the same at load, and takes 1 to 5 recipients", () => {
    expect(LeadConfigValue.safeParse({ notifyRecipients: [GOOD] }).success).toBe(true);
    expect(LeadConfigValue.safeParse({ notifyRecipients: [GOOD], privacyContact: "https://craftech.io/contact/" }).success).toBe(true);
    for (const address of BAD) expect(LeadConfigValue.safeParse({ notifyRecipients: [GOOD, address] }).success, JSON.stringify(address)).toBe(false);
    expect(LeadConfigValue.safeParse({ notifyRecipients: [] }).success).toBe(false);
    expect(LeadConfigValue.safeParse({ notifyRecipients: Array.from({ length: 6 }, (_, i) => `leads-${i}@craftech.io`) }).success).toBe(false);
    expect(LeadConfigValue.safeParse({ notifyRecipients: [GOOD], extra: true }).success).toBe(false);
  });

  it("[FL-116] checks every configured recipient again before a send, and collapses duplicates", () => {
    expect(fencedNotifyRecipients([GOOD, "LEADS-FIXTURE@craftech.io", "otra-fixture@craftech.io"])).toEqual([GOOD, "otra-fixture@craftech.io"]);
    expect(() => fencedNotifyRecipients([GOOD, "a@craftech.io.evil.test"])).toThrow(RangeError);
    expect(() => fencedNotifyRecipients([])).toThrow(RangeError);
  });
});
