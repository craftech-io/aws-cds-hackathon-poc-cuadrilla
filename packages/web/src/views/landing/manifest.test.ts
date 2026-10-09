// The landing's media manifest (FL-089, docs/landing-spec.md §6.3): it lists every entry of the spec's
// table, every entry is a capture of the real console (never a render) that names its capture (routes,
// viewports, state of the world) and the work package that took it, no capture points to a view outside
// docs/design-brief.md §6 (or the public pages of §7 for the signup), a placeholder always has its
// replacement date, the walkthrough and the gallery show entries of the manifest and every file of a
// capture exists. The counts come from the manifest, never written here.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findNeutralTerms } from "../../../../../scripts/lint/neutral-terms";
import { LandingManifest } from "./media";
import { CapturesFile } from "../../../../../scripts/landing/captures";
import { GALLERY_IDS, SCENE_ENTRY_IDS, SIGNUP_ENTRY_IDS } from "./story";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL("../../../public", import.meta.url));
const manifest = LandingManifest.parse(JSON.parse(readFileSync(`${PUBLIC_DIR}/landing/manifest.json`, "utf8")));
const entries = Object.entries(manifest.media);

/** The rows of a Markdown table under `heading` whose first cell matches `cell`, first cell each. */
function tableFirstCells(doc: string, heading: RegExp, cell: RegExp): string[] {
  const start = doc.search(heading);
  if (start < 0) throw new Error(`heading ${heading.source} not found`);
  const rest = doc.slice(start);
  const next = rest.slice(1).search(/\n#{2,3} /);
  const section = next < 0 ? rest : rest.slice(0, next + 1);
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|")[1]?.trim() ?? "")
    .map((first) => cell.exec(first)?.[1])
    .filter((value): value is string => value !== undefined);
}

const spec = readFileSync(`${ROOT}docs/landing-spec.md`, "utf8");
const brief = readFileSync(`${ROOT}docs/design-brief.md`, "utf8");

/** Ids of docs/landing-spec.md §6.3. */
const SPEC_IDS = tableFirstCells(spec, /### 6\.3 /, /^`([a-z0-9-]+)`$/);

/** Routes of the console views (design-brief §6) and of the public pages (§7), as patterns. */
function routesOf(heading: RegExp): string[] {
  const start = brief.search(heading);
  const section = brief.slice(start, start + brief.slice(start + 1).search(/\n## /) + 1);
  return [...section.matchAll(/`(\/[A-Za-z0-9/:_.-]*)`/g)].map((match) => match[1] ?? "");
}
const CONSOLE_ROUTES = routesOf(/## 6\. Consola/);
const PUBLIC_ROUTES = routesOf(/## 7\. Superficies/);

/** A route of a view, or the detail of one item of it (`/app/manual/:sectionId` of `/app/manual`). */
function isRouteOf(allowed: readonly string[], route: string): boolean {
  return allowed.includes(route) || allowed.includes(route.replace(/\/:[A-Za-z]+$/, ""));
}

describe("landing manifest [FL-089]", () => {
  it("lists every entry of docs/landing-spec.md §6.3, and only those", () => {
    expect(SPEC_IDS.length).toBeGreaterThan(0);
    expect(Object.keys(manifest.media).sort()).toEqual([...SPEC_IDS].sort());
  });

  it("names, for every entry, the capture that replaces it and its work package", () => {
    for (const [id, item] of entries) {
      expect(item.replacement.routes.length, id).toBeGreaterThan(0);
      expect(item.replacement.viewports.length, id).toBeGreaterThan(0);
      expect(item.replacement.worldState.length, id).toBeGreaterThan(0);
      expect(item.replacement.by, id).toBe((SIGNUP_ENTRY_IDS as readonly string[]).includes(id) ? "WP-63" : "WP-44");
    }
    const console = entries.filter(([id]) => !(SIGNUP_ENTRY_IDS as readonly string[]).includes(id));
    expect(console.length).toBe(entries.length - SIGNUP_ENTRY_IDS.length);
  });

  it("points only to views of docs/design-brief.md §6 (and §7 for the signup)", () => {
    expect(CONSOLE_ROUTES).toContain("/app/simulator");
    for (const [id, item] of entries) {
      const allowed = (SIGNUP_ENTRY_IDS as readonly string[]).includes(id) ? PUBLIC_ROUTES : CONSOLE_ROUTES;
      for (const route of item.replacement.routes) expect(isRouteOf(allowed, route), `${id}: ${route}`).toBe(true);
    }
  });

  it("refuses a placeholder without its replacement date", () => {
    const base = { alt: { es: "captura", en: "capture" }, replacement: { routes: ["/app/orders"], viewports: ["1440x900"], worldState: "día", by: "WP-44" }, file: "/landing/captures/x.webp", width: 10, height: 10 };
    const without = { version: 2, video: null, media: { x: { ...base, status: "placeholder" } } };
    const withDate = { version: 2, video: null, media: { x: { ...base, status: "placeholder", replaceBy: "2026-10-20" } } };
    expect(LandingManifest.safeParse(without).success).toBe(false);
    expect(LandingManifest.safeParse(withDate).success).toBe(true);
  });

  it("has no render left: every entry is a capture, and the walkthrough and the gallery show entries of the manifest", () => {
    for (const [id, item] of entries) expect(item.status, id).toBe("capture");
    const sceneIds = Object.values(SCENE_ENTRY_IDS).flat();
    expect(new Set(sceneIds).size).toBe(sceneIds.length);
    for (const id of [...sceneIds, ...GALLERY_IDS, ...SIGNUP_ENTRY_IDS]) expect(manifest.media[id], id).toBeDefined();
  });

  it("names only files that exist under public/landing", () => {
    for (const [id, item] of entries) expect(existsSync(`${PUBLIC_DIR}${item.file}`), `${id}: ${item.file}`).toBe(true);
    if (manifest.video) {
      expect(existsSync(`${PUBLIC_DIR}${manifest.video.src}`)).toBe(true);
      expect(existsSync(`${PUBLIC_DIR}${manifest.video.poster}`)).toBe(true);
    }
  });

  it("takes every console entry with a capture of the ledger, on the routes and viewport the manifest names", () => {
    const captures = CapturesFile.parse(JSON.parse(readFileSync(`${ROOT}scripts/landing/captures.json`, "utf8")));
    // `{order:24817}`, `{case:24818}` and a manual section stand for the route's named segment.
    const pattern = (route: string) => route.replace(/\{order:\d{5}\}/, ":workOrderId").replace(/\{case:\d{5}\}/, ":caseId").replace(/^\/app\/manual\/[A-Z]+-\d{2}$/, "/app/manual/:sectionId");
    for (const [id, item] of entries) {
      if ((SIGNUP_ENTRY_IDS as readonly string[]).includes(id)) continue;
      const spec = Object.values(captures.captures).find((capture) => capture.manifest?.id === id);
      expect(spec, id).toBeDefined();
      if (spec === undefined) continue;
      const routes = [spec.route, ...(spec.beside ? [spec.beside.route] : [])].map(pattern);
      for (const route of routes) expect(item.replacement.routes, `${id}: ${route}`).toContain(route);
      expect(item.replacement.viewports, id).toContain(spec.manifest?.viewport);
    }
  });

  it("describes every visual in both languages without naming the contest", () => {
    for (const [id, item] of entries) {
      expect(findNeutralTerms(id, `${item.alt.es}\n${item.alt.en}\n${item.replacement.worldState}`), id).toEqual([]);
    }
  });
});
