import { describe, expect, it } from "vitest";
import { ATTRIBUTION_KEY, attributionOf, captureAttribution, readAttribution } from "./attribution";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

const OWN = "https://cuadrilla.demo.craftech.io";

describe("attribution of a visit [FL-115]", () => {
  it("[FL-115] keeps the UTM tags in shape and the referrer's scheme and host, and drops the rest", () => {
    expect(attributionOf("?utm_source=linkedin&utm_medium=social&utm_campaign=fibra 2026&utm_term=" + "x".repeat(101) + "&other=1", "https://news.example.org/a/b?c=d#e", OWN)).toEqual({
      utm: { utm_source: "linkedin", utm_medium: "social" },
      referrer: "https://news.example.org",
    });
    expect(attributionOf("", "", OWN)).toEqual({});
    expect(attributionOf("", `${OWN}/signup`, OWN)).toEqual({});
    expect(attributionOf("", "javascript:alert(1)", OWN)).toEqual({});
  });

  it("[FL-115] captures the first page of the visit only, in sessionStorage, and reads it back for the sign-up", () => {
    const storage = new MemoryStorage();
    captureAttribution(storage, "?utm_source=linkedin", "https://example.org/x", OWN);
    captureAttribution(storage, "?utm_source=other", "https://other.example/", OWN);
    expect(readAttribution(storage)).toEqual({ utm: { utm_source: "linkedin" }, referrer: "https://example.org" });
    expect(JSON.parse(storage.getItem(ATTRIBUTION_KEY) ?? "{}")).toEqual({ utm: { utm_source: "linkedin" }, referrer: "https://example.org" });
  });

  it("never fails the page: no storage, a throwing storage or a tampered value mean no attribution", () => {
    expect(() => captureAttribution(undefined, "?utm_source=x", "", OWN)).not.toThrow();
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(() => captureAttribution(throwing, "?utm_source=x", "", OWN)).not.toThrow();
    expect(readAttribution(throwing)).toBeUndefined();
    const tampered = new MemoryStorage();
    tampered.setItem(ATTRIBUTION_KEY, JSON.stringify({ utm: { utm_source: "x" }, password: "p" }));
    expect(readAttribution(tampered)).toBeUndefined();
  });
});
