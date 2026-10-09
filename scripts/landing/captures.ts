// What a capture of the landing is (scripts/landing/captures.json) and the bookkeeping that keeps the
// images under packages/web/public in step with it (docs/landing-spec.md §6.2).
//
// A capture is one screen of the product (a route, the state of its world, the moment of its scene) in
// one or both viewports of the landing. Each viewport gives one picture, taken at twice its CSS size
// and served as AVIF and WebP at 1x and 2x with a `srcset`. The ledger (`images`) records, per picture,
// the hash of its pixels and the hash of every file written: a run whose pixels did not move writes no
// file, and a file that was edited or removed by hand is written again.
//
// A capture that replaces a render of the landing names its manifest entry; the picture of the
// viewport it names becomes that entry (`status: "capture"`), keeping its texts and its replacement.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { findTerms, type ForbiddenTerm } from "../lint/forbidden-terms";
import { findNeutralTerms } from "../lint/neutral-terms";
import { CaptureViewport, LandingManifest, type MediaItem } from "../../packages/web/src/views/landing/media";

export { CaptureViewport };

/** CSS size of each viewport of the landing (the same two QA uses, docs/landing-spec.md §9.1). */
export const VIEWPORT_SIZE: Readonly<Record<CaptureViewport, { readonly width: number; readonly height: number }>> = {
  "1440x900": { width: 1440, height: 900 },
  "390x844": { width: 390, height: 844 },
};

/** Every picture is taken at this device scale: its 2x file is the screenshot itself. */
export const DEVICE_SCALE = 2;

/** Where the pictures are served from (under packages/web/public). */
export const CAPTURES_DIR = "/landing/captures";

const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const PublicFile = z.string().regex(/^\/landing\/captures\/[a-z0-9._-]+\.(?:avif|webp)$/);
const Procedure = z.string().regex(/^[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)+$/);

/** The state of the world a capture opens on (scripts/landing/console-world.ts). */
export const WorldState = z.enum(["visitor", "guest-ready", "guest-scene"]);
export type WorldState = z.infer<typeof WorldState>;

/** People of the main story, by the id the `guest` template clones (story/types.ts `StoryPerson`). */
export const StoryPersonId = z.enum(["inst-rogelio", "sup-adriana", "sup-hector", "zc-marisol"]);
export type StoryPersonId = z.infer<typeof StoryPersonId>;

/**
 * The moment of the main story a `guest-scene` capture shows: the world loaded in a scene of the `guest`
 * template ("Saltar a escena", WP-39), its conversations holding the story up to one entry
 * (story/main-story.ts; `null` adds nothing to what the scene seeds), and the person whose phone the
 * simulator shows (`null` off the simulator).
 */
export const SceneSetup = z
  .object({
    jump: Slug,
    through: Slug.nullable(),
    as: StoryPersonId.nullable(),
  })
  .strict();
export type SceneSetup = z.infer<typeof SceneSetup>;

/** A route of the console, with `{order:24817}` or `{case:24818}` for the ids of the capture world. */
const CaptureRoute = z.string().regex(/^\/(?:[A-Za-z0-9/._-]|\{(?:order|case):\d{5}\})*$/);

/**
 * How the screenshot becomes the picture (scripts/landing/render-visuals.ts): the whole viewport, the
 * box of one element, or that box set on a card of the landing's theme; `phone` is the simulator's
 * phone of the scene's person, cropped with its own frame.
 */
export const Visual = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("full") }).strict(),
  z.object({ kind: z.literal("phone") }).strict(),
  z.object({ kind: z.enum(["crop", "card"]), selector: z.string().min(1), margin: z.int().min(0).max(64).default(24) }).strict(),
]);
export type Visual = z.infer<typeof Visual>;

/** A visual whose element is known: the simulator's phone is turned into the crop of its own frame first (scenes.ts `framed`). */
export type FramedVisual = Exclude<Visual, { kind: "phone" }>;

/** A second view of the same moment drawn beside the first one (a phone and the console's view of it). */
export const BesideShot = z.object({ route: CaptureRoute, as: StoryPersonId.nullable(), visual: Visual }).strict();
export type BesideShot = z.infer<typeof BesideShot>;

export const CaptureSpec = z
  .object({
    route: CaptureRoute,
    world: WorldState,
    scene: SceneSetup.optional(),
    /** A button of the view a person presses before the frame (a tab of the metrics), by its visible name. */
    press: z.string().trim().min(1).optional(),
    /** A second view of the same world beside the first one, on one card. */
    beside: BesideShot.optional(),
    locale: z.enum(["es-MX", "en"]),
    viewports: z.array(CaptureViewport).min(1),
    visual: Visual,
    /** The manifest entry this capture replaces, and the viewport whose picture becomes it. */
    manifest: z.object({ id: Slug, viewport: CaptureViewport }).strict().nullable(),
    /** What must exist in the tree before the capture can be taken: web views and BFF procedures. */
    requires: z.object({ views: z.array(Slug), procedures: z.array(Procedure) }).strict(),
    moment: z.string().trim().min(1),
  })
  .strict()
  .refine((spec) => spec.manifest === null || spec.viewports.includes(spec.manifest.viewport), { message: "the manifest viewport is not one of the capture's viewports" })
  .refine((spec) => (spec.world === "guest-scene") === (spec.scene !== undefined), { message: "a guest-scene capture, and only it, names its scene" })
  .refine((spec) => spec.world === "guest-scene" || !/\{/.test(spec.route), { message: "only a guest-scene capture names ids of its world in the route" })
  .refine((spec) => spec.world === "guest-scene" || (spec.visual.kind !== "phone" && spec.beside === undefined), { message: "only a guest-scene capture shows a phone or a view beside another" })
  .refine((spec) => spec.visual.kind !== "phone" || (spec.scene?.as ?? null) !== null, { message: "a phone capture names whose phone it is (scene.as)" });
export type CaptureSpec = z.infer<typeof CaptureSpec>;

/** One picture of the ledger: its pixels and every file written from them. */
export const LedgerEntry = z
  .object({
    pixels: Sha256,
    width: z.int().positive(),
    height: z.int().positive(),
    files: z.record(PublicFile, Sha256),
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntry>;

const PictureKey = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/(?:1440x900|390x844)$/);

export const CapturesFile = z
  .object({
    _readme: z.string().min(1),
    captures: z.record(Slug, CaptureSpec),
    images: z.record(PictureKey, LedgerEntry),
  })
  .strict();
export type CapturesFile = z.infer<typeof CapturesFile>;

/** Key of a picture in the ledger. */
export function pictureKey(captureId: string, viewport: CaptureViewport): string {
  return `${captureId}/${viewport}`;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Hash of a file by its public path under `root`; `undefined` when it does not exist. */
export function hashUnder(root: string): (path: string) => string | undefined {
  return (path) => {
    const file = join(root, path);
    return existsSync(file) ? sha256(readFileSync(file)) : undefined;
  };
}

export const FORMATS = ["avif", "webp"] as const;
export type Format = (typeof FORMATS)[number];

const MIME: Readonly<Record<Format, "image/avif" | "image/webp">> = { avif: "image/avif", webp: "image/webp" };

export interface Variant {
  readonly format: Format;
  readonly width: number;
  readonly height: number;
  /** Public path, as the page asks for it. */
  readonly path: string;
}

/** The files of one picture: AVIF and WebP at 1x and 2x of the size it has on the page. */
export function variantsOf(captureId: string, viewport: CaptureViewport, pixels: { readonly width: number; readonly height: number }): Variant[] {
  const widths = [...new Set([Math.round(pixels.width / DEVICE_SCALE), pixels.width])];
  return FORMATS.flatMap((format) =>
    widths.map((width) => ({
      format,
      width,
      height: Math.round((pixels.height * width) / pixels.width),
      path: `${CAPTURES_DIR}/${captureId}-${viewport}-${width}w.${format}`,
    })),
  );
}

/** `srcset` of one format, narrowest first. */
export function srcsetOf(variants: readonly Variant[], format: Format): string {
  return variants
    .filter((variant) => variant.format === format)
    .sort((a, b) => a.width - b.width)
    .map((variant) => `${variant.path} ${variant.width}w`)
    .join(", ");
}

/** The paths of a `srcset`, in order. */
export function srcsetPaths(srcset: string): string[] {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((path) => path !== "");
}

export type PicturePlan = { readonly action: "keep" } | { readonly action: "write"; readonly reason: string };

/**
 * Whether a picture needs its files written: not when the ledger holds the same pixels and every file
 * it expects is on disk with the hash the ledger recorded. `fileHash` answers `undefined` for a file
 * that does not exist.
 */
export function planPicture(previous: LedgerEntry | undefined, pixels: string, expected: readonly string[], fileHash: (path: string) => string | undefined): PicturePlan {
  if (previous === undefined) return { action: "write", reason: "new picture" };
  if (previous.pixels !== pixels) return { action: "write", reason: "the pixels changed" };
  const recorded = Object.keys(previous.files).sort();
  if (recorded.join("\n") !== [...expected].sort().join("\n")) return { action: "write", reason: "the set of files changed" };
  for (const [path, hash] of Object.entries(previous.files)) {
    const found = fileHash(path);
    if (found === undefined) return { action: "write", reason: `${path} is missing` };
    if (found !== hash) return { action: "write", reason: `${path} differs from the ledger` };
  }
  return { action: "keep" };
}

export type CapturePicture = Extract<MediaItem, { status: "capture" }>;

/**
 * The manifest entry of a picture: the 1x WebP as the `<img>` (every browser that runs the landing
 * decodes it), both formats as `<source>`, and the hash of the `<img>` file. The entry keeps the texts
 * and the replacement it had.
 */
export function capturedEntry(previous: MediaItem, variants: readonly Variant[], files: Readonly<Record<string, string>>): CapturePicture {
  const fallback = variants.filter((variant) => variant.format === "webp").sort((a, b) => a.width - b.width)[0];
  if (fallback === undefined) throw new Error("a picture without its WebP files");
  const hash = files[fallback.path];
  if (hash === undefined) throw new Error(`${fallback.path} was not written`);
  return {
    status: "capture",
    alt: previous.alt,
    file: fallback.path,
    width: fallback.width,
    height: fallback.height,
    sources: FORMATS.map((format) => ({ type: MIME[format], srcset: srcsetOf(variants, format) })),
    sha256: hash,
    replacement: previous.replacement,
  };
}

/**
 * The manifest as written (its key order and every field kept) with the captured entries in place,
 * checked with the page's own schema before and after.
 */
export function withCaptures(manifest: unknown, captured: Readonly<Record<string, CapturePicture>>): Record<string, unknown> {
  const parsed = LandingManifest.parse(manifest);
  for (const id of Object.keys(captured)) {
    if (parsed.media[id] === undefined) throw new Error(`the manifest has no entry ${id}`);
  }
  const raw = manifest as Record<string, unknown> & { media: Record<string, unknown> };
  const next = { ...raw, media: Object.fromEntries(Object.entries(raw.media).map(([id, item]) => [id, captured[id] ?? item])) };
  LandingManifest.parse(next);
  return next;
}

/**
 * JSON as the landing's data files are written: two spaces, and an object or an array on one line
 * when that line fits in `width` characters (so a short entry reads at a glance and a diff stays small).
 */
export function formatJson(value: unknown, width = 160): string {
  return `${formatValue(value, "", width)}\n`;
}

function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length === 0 ? "{}" : `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

function formatValue(value: unknown, indent: string, width: number, prefix = ""): string {
  const flat = inline(value);
  if (value === null || typeof value !== "object" || indent.length + prefix.length + flat.length <= width) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((item) => `${inner}${formatValue(item, inner, width)}`).join(",\n")}\n${indent}]`;
  const lines = Object.entries(value).map(([key, item]) => {
    const head = `${JSON.stringify(key)}: `;
    return `${inner}${head}${formatValue(item, inner, width, head)}`;
  });
  return `{\n${lines.join(",\n")}\n${indent}}`;
}

/** Width and height of a PNG, from its header. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || signature.some((byte, index) => png[index] !== byte)) throw new Error("not a PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const TOKEN = /\beyJ[\w-]{10,}\.[\w-]{10,}/;

export interface FrameRules {
  /** The only addresses the frame may show: the synthetic ones of the capture world. */
  readonly allowedEmails: readonly string[];
  /** The operator's forbidden list (lint:forbidden), when it is in the environment. */
  readonly forbidden: readonly ForbiddenTerm[];
}

/**
 * Why a frame cannot be kept, from the text on the page: a word no visible surface uses (ADR-0023), a
 * term of the operator's forbidden list (reported by its position, never by the term), an address
 * that is not one of the world's synthetic ones, or something that looks like a token. The frame's
 * own text is never quoted, except the neutral word, which is not secret.
 */
export function frameProblems(text: string, rules: FrameRules): string[] {
  const problems = findNeutralTerms("frame", text).map((finding) => `shows the word "${finding.term}" (ADR-0023)`);
  for (const finding of findTerms("frame", text, rules.forbidden)) problems.push(`shows term #${finding.term} of the forbidden list`);
  const allowed = new Set(rules.allowedEmails.map((address) => address.toLowerCase()));
  if ([...text.matchAll(EMAIL)].some((match) => !allowed.has(match[0].toLowerCase()))) problems.push("shows an email address that is not the capture world's");
  if (TOKEN.test(text)) problems.push("shows something that looks like a token");
  return problems;
}

/**
 * Whether a `brand.get` answer leaves the neutral brand: a capture is versioned in the repository,
 * which never holds the design partner's name or logo (ADR-0018).
 */
export function isCobrandAnswer(body: string): boolean {
  return /"mode"\s*:\s*"cobrand"/.test(body);
}
