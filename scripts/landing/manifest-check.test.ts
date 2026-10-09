// `npm run landing:check` (FL-089, docs/landing-spec.md §6): the landing's media manifest against the
// capture ledger and the files under public/. The repository's own manifest passes; each rule fails
// on a manifest built to break it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CapturesFile, hashUnder, sha256, variantsOf } from "./captures";
import { CAPTURES_FILE, MANIFEST_FILE, PUBLIC_DIR, checkManifest } from "./manifest-check";

const ALT = { es: "El formulario de alta.", en: "The signup form." };
const REPLACEMENT = { routes: ["/signup"], viewports: ["1440x900", "390x844"], worldState: "Paso signUp del alta", by: "WP-63" };
const variants = variantsOf("signup-form", "1440x900", { width: 2880, height: 1800 });
const bytes = Object.fromEntries(variants.map((variant) => [variant.path, `bytes of ${variant.path}`]));
const hashes = Object.fromEntries(Object.entries(bytes).map(([path, content]) => [path, sha256(content)]));
const picture = variants.find((variant) => variant.format === "webp" && variant.width === 1440)?.path ?? "";

function srcset(format: "avif" | "webp"): string {
  return variants
    .filter((variant) => variant.format === format)
    .map((variant) => `${variant.path} ${variant.width}w`)
    .join(", ");
}

const captureEntry = {
  status: "capture",
  alt: ALT,
  file: picture,
  width: 1440,
  height: 900,
  sources: [
    { type: "image/avif", srcset: srcset("avif") },
    { type: "image/webp", srcset: srcset("webp") },
  ],
  sha256: hashes[picture],
  replacement: REPLACEMENT,
};

function ledger(files: Record<string, string> = hashes): CapturesFile {
  return {
    _readme: "test",
    captures: {
      "signup-form": {
        route: "/signup",
        world: "visitor",
        locale: "es-MX",
        viewports: ["1440x900"],
        visual: { kind: "full" },
        manifest: { id: "signup-form", viewport: "1440x900" },
        requires: { views: ["signup"], procedures: [] },
        moment: "the form",
      },
    },
    images: { "signup-form/1440x900": { pixels: "a".repeat(64), width: 2880, height: 1800, files } },
  };
}

const manifestWith = (media: Record<string, unknown>) => ({ version: 2, video: null, media });
const onDisk = (files: Record<string, string>) => (path: string) => files[path];

describe("landing:check [FL-089]", () => {
  it("[FL-089] passes on the repository's manifest, ledger and files", () => {
    const captures = CapturesFile.parse(JSON.parse(readFileSync(CAPTURES_FILE, "utf8")));
    const manifest: unknown = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
    expect(checkManifest({ manifest, captures, fileHash: hashUnder(PUBLIC_DIR) })).toEqual([]);
  });

  it("[FL-089] passes a capture whose files are all in place with the hash of the ledger", () => {
    expect(checkManifest({ manifest: manifestWith({ "signup-form": captureEntry }), captures: ledger(), fileHash: onDisk(hashes) })).toEqual([]);
  });

  it("[FL-089] refuses a render, and an entry without the capture that replaces it or without its work package", () => {
    const { by: _by, ...withoutPackage } = REPLACEMENT;
    const problems = checkManifest({
      manifest: manifestWith({ "signup-form": { status: "render", alt: ALT }, "signup-code": { status: "render", alt: ALT, replacement: withoutPackage } }),
      captures: ledger(),
      fileHash: onDisk(hashes),
    });
    expect(problems).toContain("signup-form: a render; every visual is a capture of the real console or a dated placeholder");
    expect(problems).toContain("signup-form: no complete replacement (routes, viewports, world state and the work package that captures it)");
    expect(problems).toContain("signup-code: no complete replacement (routes, viewports, world state and the work package that captures it)");
  });

  it("[FL-089] refuses a placeholder without its replacement date, and accepts one with it", () => {
    const placeholder = { status: "placeholder", alt: ALT, replacement: REPLACEMENT, file: picture, width: 1440, height: 900 };
    const without = checkManifest({ manifest: manifestWith({ "signup-form": placeholder }), captures: ledger(), fileHash: onDisk(hashes) });
    expect(without).toContain("signup-form: a placeholder without its replacement date (replaceBy)");
    const dated = checkManifest({ manifest: manifestWith({ "signup-form": { ...placeholder, replaceBy: "2026-10-20" } }), captures: ledger(), fileHash: onDisk(hashes) });
    expect(dated).toEqual([]);
  });

  it("[FL-089] refuses a capture whose picture or a source of its srcset is not under public/", () => {
    const { [variants[1]?.path ?? ""]: _gone, ...missingSource } = hashes;
    const problems = checkManifest({ manifest: manifestWith({ "signup-form": captureEntry }), captures: ledger(), fileHash: onDisk(missingSource) });
    expect(problems).toEqual([`signup-form: ${variants[1]?.path} is not under public/`]);
  });

  it("[FL-089] refuses a file that is not in the ledger, or whose bytes are not the ones the ledger recorded", () => {
    const { [picture]: _unrecorded, ...partial } = hashes;
    expect(checkManifest({ manifest: manifestWith({ "signup-form": captureEntry }), captures: ledger(partial), fileHash: onDisk(hashes) })).toEqual([
      `signup-form: ${picture} is not in the capture ledger (scripts/landing/captures.json)`,
    ]);
    const edited = { ...hashes, [picture]: sha256("edited by hand") };
    expect(checkManifest({ manifest: manifestWith({ "signup-form": captureEntry }), captures: ledger(), fileHash: onDisk(edited) })).toEqual([
      `signup-form: ${picture} does not have the hash the ledger recorded`,
      `signup-form: sha256 is not the hash of ${picture}`,
    ]);
  });

  it("[FL-089] refuses a capture of the ledger that points to an entry the manifest does not have", () => {
    const problems = checkManifest({ manifest: manifestWith({ "signup-code": captureEntry }), captures: ledger(), fileHash: onDisk(hashes) });
    expect(problems).toEqual(["capture signup-form: the manifest has no entry signup-form"]);
  });

  it("[FL-089] reports a manifest the page cannot read, by field", () => {
    const problems = checkManifest({ manifest: { version: 1, video: null, media: {} }, captures: ledger(), fileHash: onDisk(hashes) });
    expect(problems.some((problem) => problem.startsWith("manifest version:"))).toBe(true);
  });
});
