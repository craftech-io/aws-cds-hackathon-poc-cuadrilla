import { describe, expect, it } from "vitest";
import { BrandConfigValue, LeadConfigValue, OriginVerifyKeyValue, SECRET_NAMES, signupBrandMode } from "./secret-schemas";

const COBRAND = {
  mode: "cobrand",
  partnerDisplayName: "Design Partner Fibra",
  partnerShortName: "Partner",
  logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" },
  disclaimer: { es: "Demo sintética: datos inventados.", en: "Synthetic demo: invented data." },
} as const;

describe("names of the secrets", () => {
  it("lists the eight secrets of docs/architecture.md §3, the origin key and the lead configuration included", () => {
    expect([...SECRET_NAMES].sort()).toEqual(["BrandConfig", "LeadConfig", "OriginVerifyKey", "SeedOverrides", "SessionTokenKey", "WabaId", "WhatsAppMetaPhoneNumberId", "WhatsAppPhoneNumberId"]);
  });
});

describe("OriginVerifyKey (ADR-0025 §3)", () => {
  it("takes the 32 random bytes in base64 of `openssl rand -base64 32`", () => {
    expect(OriginVerifyKeyValue.safeParse("q1W2e3R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8l9Z0x1C=").success).toBe(true);
    expect(OriginVerifyKeyValue.safeParse(Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString("base64")).success).toBe(true);
  });

  it("refuses a short, guessable or placeholder value", () => {
    for (const weak of ["", "secret", "not-connected", "a".repeat(10), "a".repeat(64), "ab".repeat(30), "has spaces in it and is long enough to pass the length"]) {
      expect(OriginVerifyKeyValue.safeParse(weak).success, weak).toBe(false);
    }
  });
});

describe("LeadConfig (ADR-0026)", () => {
  it("takes 1 to 5 mailboxes of the exact domain craftech.io and an optional privacy contact", () => {
    expect(LeadConfigValue.safeParse({ notifyRecipients: ["leads-fixture@craftech.io"] }).success).toBe(true);
    expect(LeadConfigValue.safeParse({ notifyRecipients: ["a-fixture@craftech.io", "b-fixture@craftech.io"], privacyContact: "https://craftech.io/contact/" }).success).toBe(true);
  });

  it("refuses any other domain, subdomain or look-alike, an empty or too long list and unknown fields", () => {
    for (const notifyRecipients of [[], ["a@craftech.io.evil.test"], ["a@sub.craftech.io"], ["a@example.com"], ["Leads <a@craftech.io>"], Array.from({ length: 6 }, (_, i) => `a${i}@craftech.io`)]) {
      expect(LeadConfigValue.safeParse({ notifyRecipients }).success, JSON.stringify(notifyRecipients)).toBe(false);
    }
    expect(LeadConfigValue.safeParse({ notifyRecipients: ["a@craftech.io"], other: 1 }).success).toBe(false);
  });
});

describe("BrandConfig.signupMode (ADR-0018, ADR-0025 §2)", () => {
  it("is neutral by default, in both modes", () => {
    expect(signupBrandMode(BrandConfigValue.parse({ mode: "neutral" }))).toBe("neutral");
    expect(signupBrandMode(BrandConfigValue.parse(COBRAND))).toBe("neutral");
  });

  it("co-brands the sign-up worlds only when the co-branding mode says so explicitly", () => {
    expect(signupBrandMode(BrandConfigValue.parse({ ...COBRAND, signupMode: "cobrand" }))).toBe("cobrand");
    expect(signupBrandMode(BrandConfigValue.parse({ ...COBRAND, signupMode: "neutral" }))).toBe("neutral");
  });

  it("refuses a co-branded sign-up without the partner's data and an unknown mode", () => {
    expect(BrandConfigValue.safeParse({ mode: "neutral", signupMode: "cobrand" }).success).toBe(false);
    expect(BrandConfigValue.safeParse({ mode: "neutral", signupMode: "neutral" }).success).toBe(true);
    expect(BrandConfigValue.safeParse({ ...COBRAND, signupMode: "partner" }).success).toBe(false);
  });
});
