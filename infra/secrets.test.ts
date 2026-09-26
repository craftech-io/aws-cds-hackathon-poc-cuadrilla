import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as schemas from "../packages/bff/src/lib/secret-schemas";
import {
  BrandConfigValue,
  NOT_CONNECTED,
  SECRET_NAMES,
  SeedOverridesValue,
  WhatsAppMetaPhoneNumberIdValue,
  WhatsAppPhoneNumberIdValue,
} from "../packages/bff/src/lib/secret-schemas";

/** A zod schema of packages/bff/src/lib/secret-schemas.ts by its name (`<Secret>Value`), published by WP-59. */
function schemaOf(name: string): z.ZodType {
  const schema: unknown = Reflect.get(schemas, name);
  if (typeof schema !== "object" || schema === null || typeof Reflect.get(schema, "safeParse") !== "function") {
    throw new Error(`packages/bff/src/lib/secret-schemas.ts exports no ${name}: the shape of every secret of infra/secrets.ts lives there (WP-59).`);
  }
  return schema as z.ZodType;
}

// infra/secrets.ts only evaluates inside the SST program ($app, sst), so it is read as text.
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const declared = (source: string): string[] => [...stripComments(source).matchAll(/new sst\.Secret\("([A-Za-z0-9]+)"/g)].map((match) => match[1] ?? "");

const infraSecrets = read("./secrets.ts");

const COBRAND = {
  mode: "cobrand",
  partnerDisplayName: "Design Partner Fibra",
  partnerShortName: "Partner",
  logoAssetKeys: { onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg" },
  disclaimer: { es: "Demo sintética: datos inventados.", en: "Synthetic demo: invented data." },
};

describe("shared secrets", () => {
  it("declares exactly the names packages/bff/src/lib/secret-schemas.ts reads", () => {
    expect([...declared(infraSecrets)].sort()).toEqual([...SECRET_NAMES].sort());
  });

  it("declares the eight secrets of docs/architecture.md §3, each once and never with a placeholder", () => {
    const names = declared(infraSecrets);
    expect([...names].sort()).toEqual(["BrandConfig", "LeadConfig", "OriginVerifyKey", "SeedOverrides", "SessionTokenKey", "WabaId", "WhatsAppMetaPhoneNumberId", "WhatsAppPhoneNumberId"]);
    expect(new Set(names).size).toBe(names.length);
    expect(stripComments(infraSecrets)).not.toMatch(/new sst\.Secret\("[A-Za-z0-9]+"\s*,/);
  });

  it("is the only infra module that declares a secret", () => {
    const modules = readdirSync(fileURLToPath(new URL(".", import.meta.url))).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "secrets.ts",
    );
    expect(modules.length).toBeGreaterThan(10);
    for (const file of modules) expect(declared(read(`./${file}`)), `infra/${file}`).toEqual([]);
  });
});

describe("WhatsApp number ids (ADR-0002)", () => {
  it("accepts the AWS id only in its phone-number-id-<32 hex> shape, or not-connected", () => {
    expect(WhatsAppPhoneNumberIdValue.safeParse(NOT_CONNECTED).success).toBe(true);
    expect(WhatsAppPhoneNumberIdValue.safeParse(`phone-number-id-${"a1".repeat(16)}`).success).toBe(true);
    for (const wrong of ["123456789012345", "phone-number-id-XYZ", `phone-number-id-${"a".repeat(31)}`, ""]) {
      expect(WhatsAppPhoneNumberIdValue.safeParse(wrong).success, wrong).toBe(false);
    }
  });

  it("accepts the Meta id only as digits, or not-connected, and never the AWS shape", () => {
    expect(WhatsAppMetaPhoneNumberIdValue.safeParse(NOT_CONNECTED).success).toBe(true);
    expect(WhatsAppMetaPhoneNumberIdValue.safeParse("106540352242922").success).toBe(true);
    expect(WhatsAppMetaPhoneNumberIdValue.safeParse(`phone-number-id-${"a1".repeat(16)}`).success).toBe(false);
    expect(WhatsAppMetaPhoneNumberIdValue.safeParse("12345").success).toBe(false);
  });
});

describe("BrandConfig (ADR-0018)", () => {
  it("accepts the neutral fallback and the full co-branding shape", () => {
    expect(BrandConfigValue.safeParse({ mode: "neutral" }).success).toBe(true);
    expect(BrandConfigValue.safeParse(COBRAND).success).toBe(true);
  });

  it("requires every co-branding field", () => {
    for (const field of ["partnerDisplayName", "partnerShortName", "logoAssetKeys", "disclaimer"] as const) {
      const { [field]: _dropped, ...rest } = COBRAND;
      expect(BrandConfigValue.safeParse(rest).success, field).toBe(false);
    }
    expect(BrandConfigValue.safeParse({ ...COBRAND, disclaimer: { es: "solo es" } }).success).toBe(false);
    expect(BrandConfigValue.safeParse({ ...COBRAND, logoAssetKeys: { onLight: "brand/logo-on-light.svg" } }).success).toBe(false);
  });

  it("takes logos only as generic SVG keys under brand/", () => {
    for (const key of ["logo.svg", "brand/../secrets.svg", "brand/logo.png", "https://example.test/logo.svg"]) {
      expect(BrandConfigValue.safeParse({ ...COBRAND, logoAssetKeys: { onLight: key, onDark: "brand/logo-on-dark.svg" } }).success, key).toBe(false);
    }
  });

  it("rejects unknown modes and extra fields", () => {
    expect(BrandConfigValue.safeParse({ mode: "partner" }).success).toBe(false);
    expect(BrandConfigValue.safeParse({ mode: "neutral", partnerDisplayName: "x" }).success).toBe(false);
  });
});

describe("SeedOverrides", () => {
  it("accepts the empty initial value and at most one live world", () => {
    expect(SeedOverridesValue.safeParse({}).success).toBe(true);
    expect(SeedOverridesValue.safeParse({ liveWorldClockId: "GLOBAL#isp-demo" }).success).toBe(true);
    expect(SeedOverridesValue.safeParse({ liveWorldClockId: ["GLOBAL#isp-demo", "GLOBAL#isp-other"] }).success).toBe(false);
  });

  it("takes phones only in E.164 and rejects unknown keys", () => {
    expect(SeedOverridesValue.safeParse({ demoRecipients: { emails: [], phones: ["5512345678"] } }).success).toBe(false);
    expect(SeedOverridesValue.safeParse({ unknown: true }).success).toBe(false);
  });
});

describe("OriginVerifyKey (ADR-0025 §3)", () => {
  const architecture = readFileSync(fileURLToPath(new URL("../docs/architecture.md", import.meta.url)), "utf8");

  it("is declared, documented in §3 and linked to the Bff and the Router's origin, never set as a value", () => {
    expect(declared(infraSecrets)).toContain("OriginVerifyKey");
    expect(architecture).toContain("| `OriginVerifyKey` |");
    expect(stripComments(read("./bff.ts"))).toMatch(/link: \[[^\]]*\bOriginVerifyKey\b/);
    expect(stripComments(read("./web.ts"))).toContain("OriginVerifyKey.value");
    expect(stripComments(infraSecrets)).not.toMatch(/OriginVerifyKey"\s*,/);
  });

  it("takes a random value of at least 32 bytes, never a short or guessable one", () => {
    const schema = schemaOf("OriginVerifyKeyValue");
    expect(schema.safeParse("q1W2e3R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8l9Z0x1C=").success).toBe(true);
    for (const weak of ["", "secret", "not-connected", "a".repeat(10)]) expect(schema.safeParse(weak).success, weak).toBe(false);
  });
});

describe("LeadConfig (ADR-0026)", () => {
  it("is linked only to LeadStream among the Lambdas", () => {
    const linking = readdirSync(fileURLToPath(new URL(".", import.meta.url)))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "secrets.ts")
      .filter((file) => /\bLeadConfig\b/.test(stripComments(read(`./${file}`))));
    expect(linking).toEqual(["leads.ts"]);
    expect(stripComments(read("./leads.ts"))).toMatch(/new sst\.aws\.Function\("LeadStream"[\s\S]*?link: links\(\[[^\]]*\bLeadConfig\b/);
  });

  it("takes 1 to 5 recipients of the exact domain craftech.io and nothing else", () => {
    const schema = schemaOf("LeadConfigValue");
    expect(schema.safeParse({ notifyRecipients: ["leads-fixture@craftech.io"] }).success).toBe(true);
    const wrong = [[], ["a@craftech.io.evil.test"], ["a@sub.craftech.io"], ["a@example.com"], Array.from({ length: 6 }, (_, i) => `a${i}@craftech.io`)];
    for (const notifyRecipients of wrong) expect(schema.safeParse({ notifyRecipients }).success, JSON.stringify(notifyRecipients)).toBe(false);
  });
});
