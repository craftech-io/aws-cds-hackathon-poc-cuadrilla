import { describe, expect, it } from "vitest";
import { BrandView, NEUTRAL_BRAND, demoBrandOf } from "./brand";

// A fictitious partner: the repository never holds the real one (ADR-0018).
const COBRAND = {
  mode: "cobrand",
  displayName: "Operadora Socia",
  logos: { onLight: "https://seed.example.test/brand/logo-on-light.svg?X-Amz-Signature=1", onDark: null },
  disclaimer: { es: "Demo sintética: el manual, las políticas y los datos son inventados.", en: "Synthetic demo: the manual, the policies and the data are made up." },
};

describe("brand.get answer (ADR-0018)", () => {
  it("accepts the neutral and the co-branding answers, and fields added later", () => {
    expect(BrandView.parse({ mode: "neutral", displayName: "Operadora ficticia", logos: { onLight: null, onDark: null }, disclaimer: null }).mode).toBe("neutral");
    expect(BrandView.parse({ ...COBRAND, extra: 1 }).displayName).toBe("Operadora Socia");
  });

  it("only takes https logo URLs", () => {
    for (const bad of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "http://seed.example.test/logo.svg", "not a url"]) {
      expect(BrandView.safeParse({ ...COBRAND, logos: { onLight: bad, onDark: null } }).success).toBe(false);
    }
  });

  it("rejects an unknown mode or an empty name", () => {
    expect(BrandView.safeParse({ ...COBRAND, mode: "whitelabel" }).success).toBe(false);
    expect(BrandView.safeParse({ ...COBRAND, displayName: "  " }).success).toBe(false);
  });
});

describe("demoBrandOf", () => {
  it("is neutral until the stage answers, and for the neutral mode", () => {
    expect(demoBrandOf(undefined, "es")).toBe(NEUTRAL_BRAND);
    expect(demoBrandOf(BrandView.parse({ mode: "neutral", displayName: "Operadora ficticia" }), "en")).toBe(NEUTRAL_BRAND);
  });

  it("co-brands with the partner, the logos it has and the disclaimer in the surface's language", () => {
    const view = BrandView.parse(COBRAND);
    expect(demoBrandOf(view, "es")).toEqual({
      mode: "cobrand",
      partnerDisplayName: "Operadora Socia",
      logos: { onLight: COBRAND.logos.onLight },
      disclaimer: COBRAND.disclaimer.es,
    });
    expect(demoBrandOf(view, "en")).toMatchObject({ disclaimer: COBRAND.disclaimer.en });
  });

  it("draws the text wordmark when there is no logo at all", () => {
    const brand = demoBrandOf(BrandView.parse({ ...COBRAND, logos: { onLight: null, onDark: null } }), "es");
    expect(brand).toEqual({ mode: "cobrand", partnerDisplayName: "Operadora Socia", disclaimer: COBRAND.disclaimer.es });
  });

  it("never shows the partner without the synthetic-demo disclaimer", () => {
    expect(demoBrandOf(BrandView.parse({ ...COBRAND, disclaimer: null }), "es")).toBe(NEUTRAL_BRAND);
    expect(demoBrandOf(BrandView.parse({ mode: "cobrand", displayName: "Operadora Socia" }), "es")).toBe(NEUTRAL_BRAND);
  });
});
