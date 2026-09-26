// Which component draws each `render` entry of the manifest, and which entries each scene of the
// walkthrough shows. The two signup entries are drawn by the signup view itself (WP-57) and captured
// straight from it (WP-63), so they have no component here.
import type { ComponentType } from "react";
import { GALLERY_RENDERS } from "./console-views";
import { HERO_LOOP_ENTRIES } from "./HeroLoop";
import { PhoneFrame } from "./PhoneFrame";
import { type RenderProps, SCENE_RENDERS } from "./scenes";
import { type StorySceneId, phoneMessages } from "./sources";

const HERO_MESSAGES = phoneMessages("inst-rogelio", HERO_LOOP_ENTRIES);

/** The loop's final frame, as its poster and the gallery show it. */
function HeroLoopPoster({ reduced }: RenderProps) {
  return <PhoneFrame owner="inst-rogelio" messages={HERO_MESSAGES} run={false} still reduced={reduced} size="still" />;
}

export const RENDERS = { "hero-loop": HeroLoopPoster, ...SCENE_RENDERS, ...GALLERY_RENDERS } satisfies Record<string, ComponentType<RenderProps>>;

export type RenderId = keyof typeof RENDERS;

/** Entries of the manifest that another view draws and captures directly. */
export const EXTERNAL_RENDERS = ["signup-form", "signup-code"] as const;

export function isRenderId(id: string): id is RenderId {
  return Object.hasOwn(RENDERS, id);
}

/** The manifest entries each scene of the walkthrough shows, in the order of docs/landing-spec.md §6.3. */
export const SCENE_RENDER_IDS: Readonly<Record<StorySceneId, readonly RenderId[]>> = {
  S1: ["s1-voice-diagnosis"],
  S2: ["s2-policy-cite"],
  S3: ["s3-photo-reject", "s3-photo-pass"],
  S4: ["s4-checklist-complete", "s4-certificate-pdf", "s4-outbox"],
  S5: ["s5-escalation-template", "s5-escalation-take"],
  S6: ["s6-safety-hazard", "s6-safety-alerts"],
};

/** The gallery's entries, in manifest order. */
export const GALLERY_IDS = Object.keys(GALLERY_RENDERS) as ReadonlyArray<keyof typeof GALLERY_RENDERS>;
