import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type DemoBrand, NEUTRAL_BRAND } from "../../lib/brand";
import { BrandMark } from "./BrandMark";

const COBRAND: DemoBrand = {
  mode: "cobrand",
  partnerDisplayName: "Operadora Socia",
  logos: { onLight: "https://seed.example.test/brand/logo-on-light.svg?sig=1", onDark: "https://seed.example.test/brand/logo-on-dark.svg?sig=2" },
  disclaimer: "Demo sintética: el manual, las políticas y los datos son inventados.",
};

const render = (brand: DemoBrand, tone: "light" | "dark" = "light") => renderToStaticMarkup(createElement(BrandMark, { brand, tone }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("BrandMark (ADR-0018)", () => {
  it("shows Cuadrilla · Powered by Craftech in the neutral mode, with no partner and no disclaimer", () => {
    const html = render(NEUTRAL_BRAND);
    expect(text(html)).toContain("Cuadrilla");
    expect(text(html)).toContain("Powered by");
    expect(html).toContain('alt="Craftech"');
    expect(html).not.toContain(">for<");
    expect(html).not.toContain('role="note"');
  });

  it("co-brands with the partner's logo for the background, always as <img>, and the disclaimer", () => {
    const light = render(COBRAND, "light");
    expect(light).toContain(">for<");
    expect(light).toContain('src="https://seed.example.test/brand/logo-on-light.svg?sig=1"');
    expect(light).toContain('alt="Operadora Socia"');
    expect(light).toContain('role="note"');
    expect(text(light)).toContain("Demo sintética: el manual, las políticas y los datos son inventados.");
    expect(render(COBRAND, "dark")).toContain('src="https://seed.example.test/brand/logo-on-dark.svg?sig=2"');
    expect(light).not.toMatch(/<svg|<object|<iframe|<embed/);
  });

  it("falls back to a text wordmark when there is no logo for the background", () => {
    const html = render({ ...COBRAND, logos: { onLight: "https://seed.example.test/brand/logo-on-light.svg" } }, "dark");
    expect(html).not.toContain('alt="Operadora Socia"');
    expect(html).toContain(">for<");
    expect(text(html)).toContain("Operadora Socia");
    const withoutLogos = render({ mode: "cobrand", partnerDisplayName: "Operadora Socia", disclaimer: "Demo sintética." });
    expect(text(withoutLogos)).toContain("Operadora Socia");
  });

  it("reads as a sentence, with real spaces between its parts", () => {
    const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const html = renderToStaticMarkup(createElement(BrandMark, { brand: { mode: "cobrand", partnerDisplayName: "Operadora Socia", disclaimer: "Demo sintética." }, tone: "light", withPoweredBy: false }));
    expect(plain(html).startsWith("Cuadrilla. for Operadora Socia")).toBe(true);
    expect(plain(renderToStaticMarkup(createElement(BrandMark, { tone: "light" })))).toBe("Cuadrilla. Powered by");
  });
});
