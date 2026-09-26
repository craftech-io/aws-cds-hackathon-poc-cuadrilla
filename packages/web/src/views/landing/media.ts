// Media of the landing, described by public/landing/manifest.json so qa can swap a placeholder for
// the real console capture, or add the demo video, without touching code. Read once per visit,
// parsed with zod; if it cannot be read the landing simply shows no pictures.
import { useEffect, useState } from "react";
import { z } from "zod";
import { fetchWithRetry } from "../../lib/http";

export const MANIFEST_URL = "/landing/manifest.json";

const MediaItem = z.object({
  file: z.string().startsWith("/landing/"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: z.string().min(1),
  status: z.enum(["render", "placeholder", "capture"]),
});
export type MediaItem = z.infer<typeof MediaItem>;

export const LandingManifest = z.object({
  version: z.literal(1),
  video: z.object({ src: z.string().startsWith("/landing/"), poster: z.string().startsWith("/landing/").optional(), caption: z.string().optional() }).nullable(),
  media: z.record(z.string(), MediaItem),
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
