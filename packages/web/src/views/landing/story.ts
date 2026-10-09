// What the landing reads of the main story (packages/bff/src/story/main-story.ts, docs/landing-spec.md
// §6.1): the instant and order each scene starts with, the one English caption of each scene (the gloss
// of one of its entries) and the voice note the hero's text alternative quotes. The visuals themselves
// are captures of the real console (public/landing/manifest.json).
import { sceneEntries, storyEntry } from "@cuadrilla/bff/story/main-story";
import type { StorySceneId } from "@cuadrilla/bff/story/types";
import { simTimeParts } from "../../lib/world-clock";

export { storyEntry };

/** The entry whose English gloss is the one caption of each scene in the English landing (§6.1). */
export const SCENE_CAPTION_ENTRY: Readonly<Record<StorySceneId, string>> = {
  S1: "s1-diagnosis-reply",
  S2: "s2-uncovered-reply",
  S3: "s3-glare-reason",
  S4: "s4-certificate",
  S5: "s5-case-escalated",
  S6: "s6-safety-instruction",
};

export function sceneCaption(scene: StorySceneId): string {
  return storyEntry(SCENE_CAPTION_ENTRY[scene]).glossEn;
}

/** First instant of a scene and its work order: the narrative's "09:20 · Orden 24817". */
export function sceneStart(scene: StorySceneId): { readonly time: string; readonly workOrderNumber: string } {
  const first = sceneEntries(scene)[0];
  if (!first) throw new RangeError(`scene ${scene} has no entries`);
  return { time: simTimeParts(first.atSim).time, workOrderNumber: first.workOrderNumber };
}

/** The manifest entries each scene of the walkthrough shows, in the order of docs/landing-spec.md §6.3. */
export const SCENE_ENTRY_IDS: Readonly<Record<StorySceneId, readonly string[]>> = {
  S1: ["s1-voice-diagnosis"],
  S2: ["s2-policy-cite"],
  S3: ["s3-photo-reject", "s3-photo-pass"],
  S4: ["s4-checklist-complete", "s4-certificate-pdf", "s4-outbox"],
  S5: ["s5-escalation-template", "s5-escalation-take"],
  S6: ["s6-safety-hazard", "s6-safety-alerts"],
};

/** The gallery's entries: the console views, in manifest order. */
export const GALLERY_IDS = ["gallery-orders", "gallery-order-detail", "gallery-manual", "gallery-metrics", "gallery-audit", "gallery-clock"] as const;

/** The entries the signup view draws and captures itself (WP-63); the rest are the console's (WP-44). */
export const SIGNUP_ENTRY_IDS = ["signup-form", "signup-code"] as const;
