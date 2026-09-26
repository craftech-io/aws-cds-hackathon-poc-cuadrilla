// The captures of the landing (FL-089, docs/landing-spec.md §6.2): the definitions in captures.json, the
// files each picture makes, the ledger that keeps a picture with the same pixels from making new files,
// the manifest entry a capture becomes and what a frame may never show.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTerms } from "../lint/forbidden-terms";
import { LandingManifest } from "../../packages/web/src/views/landing/media";
import {
  CapturesFile,
  type LedgerEntry,
  capturedEntry,
  formatJson,
  frameProblems,
  isCobrandAnswer,
  planPicture,
  pngSize,
  sha256,
  srcsetOf,
  srcsetPaths,
  variantsOf,
  withCaptures,
} from "./captures";
import { SCENES, TOKENS_KEY } from "./scenes";
import { CARD_TOKENS, themeTokens } from "./render-visuals";

const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const capturesText = read("scripts/landing/captures.json");
const captures = CapturesFile.parse(JSON.parse(capturesText));
const manifestRaw: unknown = JSON.parse(read("packages/web/public/landing/manifest.json"));
const manifest = LandingManifest.parse(manifestRaw);

const HASH = (char: string) => char.repeat(64);

describe("the captures of the landing [FL-089]", () => {
  it("[FL-089] gives every capture of captures.json a scene, and no scene without its capture", () => {
    expect(Object.keys(captures.captures).sort()).toEqual(Object.keys(SCENES).sort());
  });

  it("[FL-089] points every capture that replaces a render to an entry of the manifest, in one of its viewports", () => {
    const replacing = Object.values(captures.captures).flatMap((spec) => (spec.manifest ? [spec.manifest] : []));
    expect(replacing.length).toBeGreaterThan(0);
    for (const target of replacing) {
      const entry = manifest.media[target.id];
      expect(entry, target.id).toBeDefined();
      expect(entry?.replacement.viewports, target.id).toContain(target.viewport);
    }
  });

  it("[FL-089] keeps captures.json in the pipeline's own format, so a run only changes what it captured", () => {
    expect(formatJson(captures)).toBe(capturesText);
  });

  it("[FL-089] plants the session under the key the console reads (packages/web/src/lib/auth/tokens.ts)", () => {
    expect(read("packages/web/src/lib/auth/tokens.ts")).toContain(`TOKENS_KEY = ${JSON.stringify(TOKENS_KEY)}`);
  });

  it("[FL-089] finds every token of the card in the web's theme", () => {
    const theme = themeTokens(read("packages/web/src/index.css"));
    for (const token of CARD_TOKENS) expect(theme[token], token).toBeTruthy();
    expect(themeTokens(":root { --x: 1px; }")).toEqual({});
  });
});

describe("the files of a picture [FL-089]", () => {
  it("[FL-089] serves AVIF and WebP at 1x and 2x of the size the picture has on the page", () => {
    const variants = variantsOf("signup-form", "1440x900", { width: 2880, height: 1800 });
    expect(variants.map((variant) => variant.path)).toEqual([
      "/landing/captures/signup-form-1440x900-1440w.avif",
      "/landing/captures/signup-form-1440x900-2880w.avif",
      "/landing/captures/signup-form-1440x900-1440w.webp",
      "/landing/captures/signup-form-1440x900-2880w.webp",
    ]);
    expect(variants.map((variant) => `${variant.width}x${variant.height}`)).toEqual(["1440x900", "2880x1800", "1440x900", "2880x1800"]);
    expect(srcsetOf(variants, "webp")).toBe("/landing/captures/signup-form-1440x900-1440w.webp 1440w, /landing/captures/signup-form-1440x900-2880w.webp 2880w");
    expect(srcsetPaths(srcsetOf(variants, "avif"))).toEqual(["/landing/captures/signup-form-1440x900-1440w.avif", "/landing/captures/signup-form-1440x900-2880w.avif"]);
  });

  it("[FL-089] keeps the proportions of a cropped picture", () => {
    const variants = variantsOf("guest-home", "390x844", { width: 701, height: 433 });
    expect(variants.filter((variant) => variant.format === "avif").map((variant) => [variant.width, variant.height])).toEqual([
      [351, 217],
      [701, 433],
    ]);
  });

  it("[FL-089] reads the size of a PNG from its header and refuses what is not one", () => {
    const header = Buffer.from("89504e470d0a1a0a0000000d49484452000002d0000001c2", "hex");
    expect(pngSize(header)).toEqual({ width: 720, height: 450 });
    expect(() => pngSize(Buffer.from("not a png at all, not at all"))).toThrow(/not a PNG/);
  });
});

describe("the ledger: a pixel that did not move makes no new file [FL-089]", () => {
  const paths = ["/landing/captures/a-390x844-390w.avif", "/landing/captures/a-390x844-390w.webp"];
  const previous: LedgerEntry = { pixels: HASH("a"), width: 780, height: 1688, files: { [paths[0] as string]: HASH("1"), [paths[1] as string]: HASH("2") } };
  const onDisk = (files: Record<string, string>) => (path: string) => files[path];

  it("[FL-089] keeps a picture whose pixels and files are what the ledger says", () => {
    expect(planPicture(previous, HASH("a"), paths, onDisk(previous.files))).toEqual({ action: "keep" });
  });

  it("[FL-089] writes a new picture, one whose pixels changed, and one whose files are missing, edited or renamed", () => {
    expect(planPicture(undefined, HASH("a"), paths, onDisk({}))).toMatchObject({ action: "write", reason: "new picture" });
    expect(planPicture(previous, HASH("b"), paths, onDisk(previous.files))).toMatchObject({ action: "write", reason: "the pixels changed" });
    expect(planPicture(previous, HASH("a"), paths, onDisk({ [paths[0] as string]: HASH("1") }))).toMatchObject({ action: "write", reason: expect.stringMatching(/missing/) });
    expect(planPicture(previous, HASH("a"), paths, onDisk({ ...previous.files, [paths[1] as string]: HASH("3") }))).toMatchObject({ action: "write", reason: expect.stringMatching(/differs/) });
    expect(planPicture(previous, HASH("a"), [...paths, "/landing/captures/a-390x844-780w.avif"], onDisk(previous.files))).toMatchObject({ action: "write", reason: "the set of files changed" });
  });

  it("[FL-089] hashes bytes with SHA-256", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("the manifest entry a capture becomes [FL-089]", () => {
  const id = "signup-form";
  const variants = variantsOf(id, "1440x900", { width: 2880, height: 1800 });
  const files = Object.fromEntries(variants.map((variant, index) => [variant.path, HASH(String(index))]));
  const previous = manifest.media[id];

  it("[FL-089] serves the 1x WebP as the picture, both formats as sources, and keeps the texts and the replacement", () => {
    if (!previous) throw new Error(`the manifest has no ${id}`);
    const entry = capturedEntry(previous, variants, files);
    expect(entry).toMatchObject({ status: "capture", file: "/landing/captures/signup-form-1440x900-1440w.webp", width: 1440, height: 900, sha256: HASH("2") });
    expect(entry.alt).toEqual(previous.alt);
    expect(entry.replacement).toEqual(previous.replacement);
    expect(entry.sources.map((source) => source.type)).toEqual(["image/avif", "image/webp"]);
    const next = LandingManifest.parse(withCaptures(manifestRaw, { [id]: entry }));
    expect(next.media[id]?.status).toBe("capture");
    for (const [other, item] of Object.entries(manifest.media)) if (other !== id) expect(next.media[other], other).toEqual(item);
  });

  it("[FL-089] refuses to replace an entry the manifest does not have", () => {
    if (!previous) throw new Error(`the manifest has no ${id}`);
    expect(() => withCaptures(manifestRaw, { "no-such-entry": capturedEntry(previous, variants, files) })).toThrow(/no entry no-such-entry/);
  });

  it("[FL-089] writes an object on one line when it fits, and opens it when it does not", () => {
    expect(formatJson({ a: { b: [1, 2] }, c: "x".repeat(10) }, 60)).toBe('{ "a": { "b": [1, 2] }, "c": "xxxxxxxxxx" }\n');
    expect(formatJson({ a: { b: "y".repeat(30) }, c: [] }, 30)).toBe(`{\n  "a": {\n    "b": "${"y".repeat(30)}"\n  },\n  "c": []\n}\n`);
  });
});

describe("what a frame never shows [FL-089]", () => {
  const rules = { allowedEmails: ["prueba@example.com"], forbidden: [] };

  it("[FL-089] refuses a word of ADR-0023, naming the word", () => {
    expect(frameProblems("Resultados de la Evaluación", rules)).toEqual(['shows the word "evaluacion" (ADR-0023)']);
    expect(frameProblems("Medición del manual", rules)).toEqual([]);
  });

  it("[FL-089] refuses a term of the operator's list by its position, never by the term", () => {
    const problems = frameProblems("Una marca Ejemplar Zeta en pantalla", { ...rules, forbidden: parseTerms("otra\nejemplar zeta|ia\n") });
    expect(problems).toEqual(["shows term #2 of the forbidden list"]);
    expect(problems.join(" ")).not.toMatch(/ejemplar/i);
  });

  it("[FL-089] allows only the world's synthetic address, and never quotes another", () => {
    expect(frameProblems("Te enviamos un código a prueba@example.com.", rules)).toEqual([]);
    const problems = frameProblems("Escríbele a alguien@correo.mx", rules);
    expect(problems).toEqual(["shows an email address that is not the capture world's"]);
    expect(problems.join(" ")).not.toContain("alguien");
  });

  it("[FL-089] refuses something that looks like a token", () => {
    expect(frameProblems("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig", rules)).toEqual(["shows something that looks like a token"]);
  });

  it("[FL-089] tells a co-branding answer of brand.get from the neutral one", () => {
    expect(isCobrandAnswer('[{"result":{"data":{"mode":"cobrand","displayName":"X"}}}]')).toBe(true);
    expect(isCobrandAnswer('{"result":{"data":{"mode": "neutral"}}}')).toBe(false);
  });
});
