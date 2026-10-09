// The landing's texts and visuals (FL-089, docs/landing-spec.md §1 and §6.1): both languages carry the
// same keys and read in Mexican Spanish with "tú"; nothing visible names the contest; every English
// caption of a scene is the gloss of a story entry; the scenes and the hero show the captures of the real
// console, and the hero's loop never shows the voice note's words but in its text alternative.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findNeutralTerms } from "../../../../../scripts/lint/neutral-terms";
import { LANDING_COPY } from "./copy";
import { LandingLangProvider, langFromSearch } from "./lang";
import { SCENE_CAPTION_ENTRY, SCENE_ENTRY_IDS, sceneCaption } from "./story";
import { Walkthrough } from "./sections/Walkthrough";
import { CONTACT_URL, SIGNUP_PATH, withLang } from "./sections/parts";
import { MAIN_STORY, storyEntry } from "@cuadrilla/bff/story/main-story";
import { HERO_FRAME_IDS, HeroFrames, capturesOf, heroFrames } from "./captured";
import { LandingManifest, type MediaItem, type MediaState } from "./media";
import { VideoSection } from "./sections/Video";

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

describe("scene captions from the main story [FL-089]", () => {
  it("every English caption of a scene is the gloss of an entry of that scene", () => {
    for (const [scene, entryId] of Object.entries(SCENE_CAPTION_ENTRY)) {
      const entry = storyEntry(entryId);
      expect(entry.scene).toBe(scene);
      expect(sceneCaption(entry.scene)).toBe(entry.glossEn);
    }
    const html = renderToStaticMarkup(createElement(LandingLangProvider, { initial: "en", children: createElement(Walkthrough, { media: { status: "loading" } }) }));
    const captions = [...html.matchAll(/<p lang="en"[^>]*>“([^”]*)”<\/p>/g)].map((match) => match[1]?.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    expect(captions).toHaveLength(Object.keys(SCENE_ENTRY_IDS).length);
    const glosses = new Set(MAIN_STORY.map((entry) => entry.glossEn));
    for (const caption of captions) expect(glosses.has(caption ?? ""), caption).toBe(true);
    const spanish = renderToStaticMarkup(createElement(LandingLangProvider, { initial: "es", children: createElement(Walkthrough, { media: { status: "loading" } }) }));
    expect(spanish).not.toContain('lang="en"');
  });
});

const MANIFEST = LandingManifest.parse(JSON.parse(readFileSync(`${PUBLIC_DIR}/landing/manifest.json`, "utf8")));

/** The manifest with only `ids` as captures (the rest pending, dated placeholders) and the video set. */
function mediaWith(ids: readonly string[], video: LandingManifest["video"] = null): MediaState {
  const pending = (item: MediaItem): MediaItem => ({ ...item, status: "placeholder", replaceBy: "2026-10-20" });
  const captured = (id: string, item: MediaItem): MediaItem => ({
    status: "capture",
    alt: item.alt,
    replacement: item.replacement,
    file: `/landing/captures/${id}-1440x900-1440w.webp`,
    width: 1440,
    height: 900,
    sources: [{ type: "image/avif", srcset: `/landing/captures/${id}-1440x900-1440w.avif 1440w` }],
  });
  const media = Object.fromEntries(Object.entries(MANIFEST.media).map(([id, item]) => [id, ids.includes(id) ? captured(id, item) : pending(item)]));
  return { status: "ready", manifest: { ...MANIFEST, video, media } };
}

const inLang = (lang: "es" | "en", child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LandingLangProvider, { initial: lang, children: child }));

describe("captures of the real console [FL-089]", () => {
  it("shows a group as captures only when every entry of it is one", () => {
    expect(capturesOf(mediaWith([]), ["s1-voice-diagnosis"])).toBeUndefined();
    expect(capturesOf(mediaWith(["s3-photo-reject"]), SCENE_ENTRY_IDS.S3)).toBeUndefined();
    expect(capturesOf(mediaWith(["s3-photo-reject", "s3-photo-pass"]), SCENE_ENTRY_IDS.S3)?.map(({ id }) => id)).toEqual(["s3-photo-reject", "s3-photo-pass"]);
    expect(capturesOf({ status: "loading" }, ["s1-voice-diagnosis"])).toBeUndefined();
  });

  it("draws each scene of the walkthrough as its pictures, with the manifest's alt, and none while the manifest is not read", () => {
    for (const lang of ["es", "en"] as const) {
      const html = inLang(lang, createElement(Walkthrough, { media: mediaWith(["s1-voice-diagnosis"]) }));
      const alt = MANIFEST.media["s1-voice-diagnosis"]?.alt[lang] ?? "";
      expect(html).toContain('src="/landing/captures/s1-voice-diagnosis-1440x900-1440w.webp"');
      expect(html).toContain(`alt="${alt.replace(/"/g, "&quot;").replace(/'/g, "&#x27;")}"`);
      expect(html).toContain('loading="lazy"');
      // One scene of six is complete in this manifest: only it draws.
      expect(html.match(/data-scene-captures=""/g)).toHaveLength(1);
    }
    expect(inLang("es", createElement(Walkthrough, { media: { status: "loading" } }))).not.toContain("data-scene-captures");
    const all = inLang("es", createElement(Walkthrough, { media: { status: "ready", manifest: MANIFEST } }));
    expect(all.match(/data-scene-captures=""/g)).toHaveLength(Object.keys(SCENE_ENTRY_IDS).length);
  });

  it("plays the hero over the captured frames once the final frame is a capture, the first one eager, the voice note's words only in its summary", () => {
    expect(heroFrames(mediaWith(["s1-voice-diagnosis", "s3-photo-pass"]))).toBeUndefined();
    expect(heroFrames(mediaWith(["hero-loop"]))?.map(({ id }) => id)).toEqual(["hero-loop"]);
    expect(heroFrames(mediaWith([...HERO_FRAME_IDS]))?.map(({ id }) => id)).toEqual([...HERO_FRAME_IDS]);
    const frames = heroFrames(mediaWith([...HERO_FRAME_IDS])) ?? [];
    const loop = { label: "loop", pauseLabel: LANDING_COPY.es.hero.loop.pause, playLabel: LANDING_COPY.es.hero.loop.play, summary: "summary" };
    const html = renderToStaticMarkup(createElement(HeroFrames, { frames, ...loop }));
    const images = [...html.matchAll(/<img [^>]*>/g)].map((match) => match[0]);
    expect(images).toHaveLength(HERO_FRAME_IDS.length);
    expect(images[0]).toContain('src="/landing/captures/s1-voice-diagnosis-1440x900-1440w.webp"');
    expect(images[0]).toContain('loading="eager"');
    expect(images.at(-1)).toContain('loading="eager"');
    expect(images[1]).toContain('loading="lazy"');
    // The frames are decorative: the summary is the text alternative of the whole loop.
    for (const image of images) expect(image).toContain('alt=""');
    expect(html).toContain('<p class="sr-only">summary</p>');
    expect(html).toContain(LANDING_COPY.es.hero.loop.pause);
    const voice = storyEntry("s1-voice-note");
    const spoken = renderToStaticMarkup(createElement(HeroFrames, { frames, ...loop, summary: LANDING_COPY.es.hero.loop.summary(voice.text) }));
    expect(spoken.split(voice.text).length - 1).toBe(1);
    expect(heroFrames({ status: "ready", manifest: MANIFEST })?.map(({ id }) => id)).toEqual([...HERO_FRAME_IDS]);
  });
});

describe("product video [FL-089]", () => {
  const video = { src: "/landing/video/cuadrilla.mp4", poster: "/landing/video/cuadrilla-poster.webp" };

  it("is not drawn until the manifest names the video and its poster", () => {
    expect(inLang("es", createElement(VideoSection, { media: mediaWith([]) }))).toBe("");
    expect(inLang("es", createElement(VideoSection, { media: { status: "loading" } }))).toBe("");
    expect(LandingManifest.safeParse({ ...MANIFEST, video: { src: video.src } }).success).toBe(false);
    expect(LandingManifest.safeParse({ ...MANIFEST, video: { ...video, src: "https://example.com/v.mp4" } }).success).toBe(false);
    expect(LandingManifest.safeParse({ ...MANIFEST, video }).success).toBe(true);
  });

  it("plays only on demand: controls, no preload, inline, with its poster and a download link, never autoplay", () => {
    for (const lang of ["es", "en"] as const) {
      const html = inLang(lang, createElement(VideoSection, { media: mediaWith([], video) }));
      const tag = /<video[^>]*>/.exec(html)?.[0] ?? "";
      expect(tag).toContain("controls");
      expect(tag).toContain('preload="none"');
      expect(tag).toContain("playsInline");
      expect(tag).toContain(`poster="${video.poster}"`);
      expect(tag).not.toMatch(/autoplay/i);
      expect(html).toContain(`<source src="${video.src}" type="video/mp4"/>`);
      expect(html).toContain(`href="${video.src}"`);
      expect(html).toContain(LANDING_COPY[lang].video.fallback);
      expect(html).toContain('id="video"');
    }
  });
});
