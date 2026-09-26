import { describe, expect, it } from "vitest";
import { leadAttribution, referrerOriginOf, sanitizeUtm } from "./attribution";
import { QA_ADDRESS_PATTERN, abuseForm, leadOriginOf, normalizeLeadEmail } from "./keys";

describe("attribution of a lead [FL-115]", () => {
  it("[FL-115] keeps the five UTM tags that are at most 100 characters of [A-Za-z0-9._-]", () => {
    expect(sanitizeUtm({ utm_source: "linkedin", utm_medium: "social", utm_campaign: "fibra_2026-q4", utm_term: "ftth.copilot", utm_content: "hero-a" })).toEqual({
      source: "linkedin",
      medium: "social",
      campaign: "fibra_2026-q4",
      term: "ftth.copilot",
      content: "hero-a",
    });
  });

  it("[FL-115] discards (never truncates or repairs) a tag out of format", () => {
    const tooLong = "a".repeat(101);
    expect(sanitizeUtm({ utm_source: "linkedin", utm_medium: "correo electrónico", utm_campaign: tooLong, utm_term: "<script>", utm_content: "" })).toEqual({ source: "linkedin" });
    expect(sanitizeUtm({ utm_source: "a".repeat(100) })).toEqual({ source: "a".repeat(100) });
    expect(sanitizeUtm({ utm_source: 42, utm_medium: ["x"] } as never)).toBeUndefined();
    expect(sanitizeUtm(undefined)).toBeUndefined();
  });

  it("[FL-115] reduces the referrer to its scheme and host, only for http(s)", () => {
    expect(referrerOriginOf("https://Blog.Example.org/post/ftth?utm=1#top")).toBe("https://blog.example.org");
    expect(referrerOriginOf("http://example.org:8080/a")).toBe("http://example.org:8080");
    expect(referrerOriginOf("https://user:secret@example.org/private")).toBe("https://example.org");
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "not a url", "", 7, undefined, `https://example.org/${"x".repeat(2100)}`]) {
      expect(referrerOriginOf(bad), String(bad).slice(0, 30)).toBeUndefined();
    }
  });

  it("[FL-115] returns both, and nothing for what does not pass", () => {
    expect(leadAttribution({ utm: { utm_source: "linkedin" }, referrer: "https://example.org/a" })).toEqual({ utm: { source: "linkedin" }, referrerOrigin: "https://example.org" });
    expect(leadAttribution({ utm: { utm_source: "no válido" }, referrer: "ftp://example.org" })).toEqual({});
  });
});

describe("keys of a lead [FL-115]", () => {
  it("[FL-115] the exact form only lower-cases and trims", () => {
    expect(normalizeLeadEmail("  Ana.Prueba+Demo@Example.COM ")).toBe("ana.prueba+demo@example.com");
    for (const bad of ["no-at", "@example.com", "a@", "a b@example.com", "a@b@example.com"]) expect(() => normalizeLeadEmail(bad), bad).toThrow(RangeError);
  });

  it("[FL-115] the abuse form folds the aliases of one mailbox, except the simulator's tags", () => {
    expect(abuseForm("me+1@gmail.com")).toBe("me@gmail.com");
    expect(abuseForm("m.e@gmail.com")).toBe("me@gmail.com");
    expect(abuseForm("me@googlemail.com")).toBe("me@gmail.com");
    expect(abuseForm("Ana.Prueba+x@example.com")).toBe("ana.prueba@example.com");
    expect(abuseForm("success+qa-a@simulator.amazonses.com")).not.toBe(abuseForm("success+qa-b@simulator.amazonses.com"));
  });

  it("[FL-115] the origin comes from the address alone: only the QA seam's simulator addresses are QA", () => {
    expect(leadOriginOf("success+qa-run-812@simulator.amazonses.com")).toBe("QA");
    expect(leadOriginOf("Success+QA-run-812@Simulator.AmazonSES.com")).toBe("QA");
    expect(leadOriginOf("success+g07-c10421@simulator.amazonses.com")).toBe("WEB");
    expect(leadOriginOf("success+qa-x@simulator.amazonses.com.example.org")).toBe("WEB");
    expect(QA_ADDRESS_PATTERN.test("qa@example.com")).toBe(false);
  });
});
