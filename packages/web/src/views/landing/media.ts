// Media of the landing, described by public/landing/manifest.json (docs/landing-spec.md §6.3): one entry
// per visual, keyed by its id, with what it is today and the real capture that replaces it.
//
//   render       drawn live by the landing with the product's components and texts (renders/)
//   capture      a capture of the real console by the capture pipeline (scripts/landing/), with its file
//   placeholder  a provisional picture, always labelled "capture pending" and with its replacement date
//
// Every entry names its replacement: the console route(s), the viewports, the state of the world and the
// work package that captures it. The manifest is read once per visit and parsed with zod; if it cannot
// be read, the renders still draw (they need no file) and the captures are left out.
import { useEffect, useState } from "react";
import { z } from "zod";
import { fetchWithRetry } from "../../lib/http";

export const MANIFEST_URL = "/landing/manifest.json";

/** The two viewports every capture is taken in. */
export const CaptureViewport = z.enum(["1440x900", "390x844"]);
export type CaptureViewport = z.infer<typeof CaptureViewport>;

/** Work packages that replace the entries: the signup's own capture, and the console's. */
export const ReplacingPackage = z.enum(["WP-63", "WP-44"]);

const Text = z.string().trim().min(1);

export const Replacement = z.object({
  /** Console or public routes the capture is taken on (`/app/simulator`, `/app/orders/:workOrderId`). */
  routes: z.array(z.string().regex(/^\/[A-Za-z0-9/:_-]*$/)).min(1),
  viewports: z.array(CaptureViewport).min(1),
  /** State of the world the capture shows (the "Saltar a escena" preset or the step of the flow). */
  worldState: Text,
  by: ReplacingPackage,
});
export type Replacement = z.infer<typeof Replacement>;

const Common = {
  /** What the visual shows, in both languages of the landing. */
  alt: z.object({ es: Text, en: Text }),
  replacement: Replacement,
};

const File = z.string().regex(/^\/landing\/[a-z0-9/._-]+\.(?:avif|webp|png|jpg|mp4)$/);

const Picture = {
  file: File,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Other formats and densities (`<picture>`), best first. */
  sources: z.array(z.object({ type: z.enum(["image/avif", "image/webp"]), srcset: Text })).default([]),
};

export const RenderItem = z.object({ ...Common, status: z.literal("render") });
export const CaptureItem = z.object({ ...Common, ...Picture, status: z.literal("capture"), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() });
export const PlaceholderItem = z.object({ ...Common, ...Picture, status: z.literal("placeholder"), replaceBy: z.iso.date() });

export const MediaItem = z.discriminatedUnion("status", [RenderItem, CaptureItem, PlaceholderItem]);
export type MediaItem = z.infer<typeof MediaItem>;
export type PictureItem = Extract<MediaItem, { status: "capture" | "placeholder" }>;

export const LandingManifest = z.object({
  version: z.literal(2),
  video: z.object({ src: File, poster: File.optional(), caption: z.object({ es: Text, en: Text }).optional() }).nullable(),
  media: z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), MediaItem),
});
export type LandingManifest = z.infer<typeof LandingManifest>;

export type MediaState = { readonly status: "loading" } | { readonly status: "ready"; readonly manifest: LandingManifest } | { readonly status: "unavailable" };

let cached: Promise<LandingManifest> | undefined;

function loadManifest(): Promise<LandingManifest> {
  cached ??= fetchWithRetry(MANIFEST_URL, { headers: { accept: "application/json" } }, { attempts: 2, timeoutMs: 8_000 })
    .then(async (response) => {
      if (!response.ok) throw new Error(`manifest answered ${response.status}`);
      return LandingManifest.parse(await response.json());
    })
    .catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
  return cached;
}

export function useLandingMedia(): MediaState {
  const [state, setState] = useState<MediaState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    loadManifest().then(
      (manifest) => active && setState({ status: "ready", manifest }),
      () => active && setState({ status: "unavailable" }),
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

export function mediaOf(state: MediaState, id: string): MediaItem | undefined {
  return state.status === "ready" ? state.manifest.media[id] : undefined;
}

export function isPicture(item: MediaItem): item is PictureItem {
  return item.status !== "render";
}
