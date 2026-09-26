// The landing's data: both languages carry the same texts, the media manifest names only files that
// exist, and the public page never names anything but the product and Craftech (the operator's name
// arrives at runtime through the brand configuration, never in the static build).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LANDING_COPY } from "./copy";
import { langFromSearch } from "./lang";
import { LandingManifest } from "./media";

const PUBLIC_DIR = fileURLToPath(new URL("../../../public", import.meta.url));
const manifest = LandingManifest.parse(JSON.parse(readFileSync(`${PUBLIC_DIR}/landing/manifest.json`, "utf8")));

/** Every key path of an object, functions included as leaves. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

describe("landing copy [FL-089]", () => {
  it("has the same keys in Spanish and English", () => {
    expect(keyPaths(LANDING_COPY.en)).toEqual(keyPaths(LANDING_COPY.es));
  });

  it("says in both languages that the demo is synthetic and WhatsApp runs simulated", () => {
    expect(LANDING_COPY.es.hero.note).toMatch(/Demo sintética/);
    expect(LANDING_COPY.en.hero.note).toMatch(/Synthetic demo/);
    expect(LANDING_COPY.es.real.columns.data.text).toMatch(/100 % sintéticos/);
    expect(LANDING_COPY.en.real.columns.data.text).toMatch(/100% synthetic/);
    expect(LANDING_COPY.es.real.columns.simulated.text).toMatch(/simulador/);
    expect(LANDING_COPY.en.real.columns.simulated.text).toMatch(/simulator/);
  });

  it("opens in English only when the link asks for it", () => {
    expect(langFromSearch(new URLSearchParams("lang=en"))).toBe("en");
    expect(langFromSearch(new URLSearchParams(""))).toBe("es");
    expect(langFromSearch(new URLSearchParams("lang=fr"))).toBe("es");
  });
});

describe("landing media manifest", () => {
  it("names only files that exist under public/landing", () => {
    for (const [id, item] of Object.entries(manifest.media)) expect(existsSync(`${PUBLIC_DIR}${item.file}`), `${id}: ${item.file}`).toBe(true);
    if (manifest.video) expect(existsSync(`${PUBLIC_DIR}${manifest.video.src}`)).toBe(true);
  });
});
