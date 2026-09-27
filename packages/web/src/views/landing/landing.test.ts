// The landing's texts and renders (FL-089, docs/landing-spec.md §1 and §6.1): both languages carry the
// same keys and read in Mexican Spanish with "tú"; nothing visible names the contest; every text drawn
// inside a render comes from the main story or copy/ (never from views/landing/), every English caption
// of a scene is the gloss of a story entry, a fixed text is never typed out, and the hero's loop never
// shows the voice note's words.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findNeutralTerms } from "../../../../../scripts/lint/neutral-terms";
import { LANDING_COPY } from "./copy";
import { LandingLangProvider, langFromSearch } from "./lang";
import { typingDelay } from "./motion";
import { HERO_LOOP_ENTRIES, HeroLoop } from "./renders/HeroLoop";
import { RENDERS, SCENE_RENDER_IDS } from "./renders/registry";
import { SCENE_PHONE_ENTRIES } from "./renders/scenes";
import { SCENE_CAPTION_ENTRY, isTyped, photoSource, sceneCaption } from "./renders/sources";
import { Walkthrough } from "./sections/Walkthrough";
import { CONTACT_URL, SIGNUP_PATH, withLang } from "./sections/parts";
import { RENDER_CORPUS, visibleTexts } from "./landing-corpus.test-kit";
import { MAIN_STORY, storyEntry } from "@cuadrilla/bff/story/main-story";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL("../../../public", import.meta.url));

/** Every key path of an object, functions included as leaves. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

/** Every string of an object, with its functions called with sample arguments. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return strings((value as (...args: unknown[]) => unknown)("x", 1, 2));
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(strings);
}

describe("landing copy [FL-089]", () => {
  it("has the same keys in Spanish and English", () => {
    expect(keyPaths(LANDING_COPY.en)).toEqual(keyPaths(LANDING_COPY.es));
  });

  it("writes Mexican Spanish with tú, never voseo", () => {
    const voseo = /\b(?:probá|creá|tenés|podés|querés|mirá|revisá|escribí|entrá|elegí|hacé|sabés|sos|contá|usá|decí|confirmá|ingresá)\b/i;
    for (const text of strings(LANDING_COPY.es)) expect(text, text).not.toMatch(voseo);
  });

  it("never names the contest nor the people who assess it, in either language", () => {
    for (const lang of ["es", "en"] as const) expect(findNeutralTerms(`copy.${lang}`, strings(LANDING_COPY[lang]).join("\n"))).toEqual([]);
  });

  it("labels every impact figure as a goal, with its source, and draws the two caps without counting", () => {
    for (const lang of ["es", "en"] as const) {
      const impact = LANDING_COPY[lang].impact;
      expect(impact.goal.length).toBeGreaterThan(0);
      expect(impact.assumption.length).toBeGreaterThan(0);
      for (const item of impact.items) expect(item.source.length).toBeGreaterThan(0);
      expect(impact.items.filter((item) => item.kind === "cap").map((item) => item.prefix.trim())).toEqual(["<", "<"]);
    }
  });

  it("opens in English only when the link asks for it, and keeps the language on the way in", () => {
    expect(langFromSearch(new URLSearchParams("lang=en"))).toBe("en");
    expect(langFromSearch(new URLSearchParams("lang=es-MX"))).toBe("es");
    expect(langFromSearch(new URLSearchParams(""))).toBe("es");
    expect(langFromSearch(new URLSearchParams("lang=fr"))).toBe("es");
    expect(withLang(SIGNUP_PATH, "es")).toBe("/signup?lang=es-MX");
    expect(withLang("/login", "en")).toBe("/login?lang=en");
    expect(CONTACT_URL).toBe("https://craftech.io/contact/");
    expect(LANDING_COPY.es.htmlLang).toBe("es-MX");
    expect(LANDING_COPY.en.htmlLang).toBe("en");
  });
});

describe("renders: texts from the main story and copy/ only [FL-089]", () => {
  const renderFiles = readdirSync(`${HERE}renders`).filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."));

  it("no file of renders/ writes a visible text of its own nor reads the landing's copy", () => {
    for (const file of renderFiles) {
      const source = readFileSync(`${HERE}renders/${file}`, "utf8");
      expect(source, file).not.toMatch(/from "\.\.\/copy(?:-es|-en)?"/);
      // Text between JSX tags, or a literal accessible name, with at least one letter.
      const jsxText = [...source.matchAll(/(?<![=\-])>\s*([^<>{}\n=;()]*\p{L}[^<>{}\n=;()]*)\s*</gu)].map((match) => match[1]?.trim()).filter((text) => text && !/^[\w.-]+$/.test(text) && !text.includes("=>"));
      expect(jsxText, file).toEqual([]);
      expect(source, file).not.toMatch(/(?:aria-label|alt|title|label)="[^"]*\p{L}/u);
    }
  });

  it("every text each render draws is a text of the story, of copy/ or of the manual", () => {
    for (const [id, Render] of Object.entries(RENDERS)) {
      const html = renderToStaticMarkup(createElement(Render, { run: false, still: true, reduced: true }));
      for (const text of visibleTexts(html)) expect(RENDER_CORPUS.has(text) || RENDER_CORPUS.contains(text), `${id}: "${text}"`).toBe(true);
    }
  });

  it("every English caption of a scene is the gloss of an entry of that scene", () => {
    for (const [scene, entryId] of Object.entries(SCENE_CAPTION_ENTRY)) {
      const entry = storyEntry(entryId);
      expect(entry.scene).toBe(scene);
      expect(sceneCaption(entry.scene)).toBe(entry.glossEn);
    }
    const html = renderToStaticMarkup(createElement(LandingLangProvider, { initial: "en", children: createElement(Walkthrough) }));
    const captions = [...html.matchAll(/<p lang="en"[^>]*>“([^”]*)”<\/p>/g)].map((match) => match[1]?.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    expect(captions).toHaveLength(Object.keys(SCENE_RENDER_IDS).length);
    const glosses = new Set(MAIN_STORY.map((entry) => entry.glossEn));
    for (const caption of captions) expect(glosses.has(caption ?? ""), caption).toBe(true);
    const spanish = renderToStaticMarkup(createElement(LandingLangProvider, { initial: "es", children: createElement(Walkthrough) }));
    expect(spanish).not.toContain('lang="en"');
  });

  it("types out only example replies and what a person writes in S1, S2 and Héctor's instruction; a fixed text appears whole", () => {
    for (const entry of MAIN_STORY) {
      if (entry.label === "fixedCopy") expect(isTyped(entry), entry.id).toBe(false);
      if (isTyped(entry)) expect(entry.kind === "TEXT" && (entry.label === "exampleAgentReply" || ["S1", "S2"].includes(entry.scene) || entry.id === "s5-hector-instruction"), entry.id).toBe(true);
    }
    expect(typingDelay(10)).toBe(35);
    expect(typingDelay(400) * 400).toBeLessThanOrEqual(4000);
  });

  it("shows every photo of the walkthrough and of the hero from a smaller copy of its seed photo, never an empty box", () => {
    for (const id of [...SCENE_PHONE_ENTRIES, ...HERO_LOOP_ENTRIES]) {
      const entry = storyEntry(id);
      if (entry.kind !== "PHOTO") continue;
      expect(entry.photoId, id).not.toBeNull();
      const src = photoSource(entry);
      expect(src, id).toBe(`/landing/renders/photos/${entry.photoId ?? ""}.jpg`);
      expect(existsSync(`${PUBLIC_DIR}${src ?? ""}`), src).toBe(true);
    }
  });

  it("the hero's loop never shows the voice note's words: they are only its text alternative", () => {
    const voice = storyEntry("s1-voice-note");
    const html = renderToStaticMarkup(createElement(HeroLoop, { label: "loop", pauseLabel: "pause", playLabel: "play", summary: LANDING_COPY.es.hero.loop.summary(voice.text) }));
    const occurrences = html.split(voice.text).length - 1;
    expect(occurrences).toBe(1);
    expect(html).toMatch(new RegExp(`<p class="sr-only">[^<]*${voice.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const poster = renderToStaticMarkup(createElement(RENDERS["hero-loop"], { run: false, still: true, reduced: true }));
    expect(poster).not.toContain(voice.text);
  });
});
