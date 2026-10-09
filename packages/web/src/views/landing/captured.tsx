// The landing's visuals, captured from the real console by the pipeline (docs/landing-spec.md §5.2 and
// §6.2): a scene of the walkthrough shows its captures, and the hero plays the captured frames of
// Rogelio's phone in turn and rests on the last one. A scene shows its captures only when every entry of
// it is one, so a scene never shows half of itself. Motion is opacity only (the structure and the pinned
// column stay as they are), and with reduced motion the hero is its final frame.
import { useEffect, useRef, useState } from "react";
import { MediaPicture } from "./MediaFigure";
import { type MediaItem, type MediaState, mediaOf } from "./media";
import { useInView, usePageVisible, useReducedMotion } from "./motion";
import { PlayPause } from "./PlayPause";
import type { LandingLang } from "./copy";

export interface CapturedPicture {
  readonly id: string;
  readonly item: Extract<MediaItem, { status: "capture" }>;
}

/** Every entry of `ids` as its capture, or `undefined` while one of them is not a capture yet. */
export function capturesOf(media: MediaState, ids: readonly string[]): CapturedPicture[] | undefined {
  const pictures: CapturedPicture[] = [];
  for (const id of ids) {
    const item = mediaOf(media, id);
    if (item?.status !== "capture") return undefined;
    pictures.push({ id, item });
  }
  return pictures.length > 0 ? pictures : undefined;
}

/** A scene's captures, side by side in the pinned column (≥ 1024 px) or one under the other. */
export function ScenePictures({ pictures, lang, desktop }: { readonly pictures: readonly CapturedPicture[]; readonly lang: LandingLang; readonly desktop: boolean }) {
  return (
    <div data-scene-captures="" className={desktop ? "flex h-full w-full items-center justify-center gap-4" : "flex w-full flex-col items-center gap-4"}>
      {pictures.map(({ id, item }) => (
        <div key={id} className={desktop ? "flex h-full min-w-0 flex-1 items-center justify-center" : "flex w-full justify-center"}>
          <MediaPicture item={item} alt={item.alt[lang]} className={desktop ? "block h-full w-full object-contain" : "block h-auto max-h-scene w-auto max-w-full object-contain"} />
        </div>
      ))}
    </div>
  );
}

/** The phone's frames the hero plays, in the order of the story; the last one is the whole conversation. */
export const HERO_FRAME_IDS = ["s1-voice-diagnosis", "s3-photo-pass", "hero-loop"] as const;
const HERO_FINAL = "hero-loop";

/** The hero's captured frames, once the final one is a capture; `undefined` leaves the loop out. */
export function heroFrames(media: MediaState): CapturedPicture[] | undefined {
  const frames = HERO_FRAME_IDS.map((id) => capturesOf(media, [id])?.[0]).filter((frame): frame is CapturedPicture => frame !== undefined);
  return frames.at(-1)?.id === HERO_FINAL ? frames : undefined;
}

/** Plays this many times, then rests on the final frame (M0: the loop never runs forever). */
const ROUNDS = 2;
const FRAME_MS = 3_500;

interface HeroFramesProps {
  readonly frames: readonly CapturedPicture[];
  readonly label: string;
  readonly pauseLabel: string;
  readonly playLabel: string;
  /** Text alternative of the whole sequence; the frames themselves are decorative here. */
  readonly summary: string;
}

/**
 * The hero's product loop over captures: the frames cross-fade in turn, twice, and rest on the final
 * one. A visible control pauses and plays it; hovering, focus inside it, leaving the viewport and a
 * hidden tab pause it too (WCAG 2.2.2). With reduced motion only the final frame is drawn.
 */
export function HeroFrames({ frames, label, pauseLabel, playLabel, summary }: HeroFramesProps) {
  const reduced = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box, { threshold: 0.25 });
  const pageVisible = usePageVisible();
  const [userPaused, setUserPaused] = useState(false);
  const [held, setHeld] = useState(false);
  const [step, setStep] = useState(0);
  const last = frames.length - 1;
  const finished = step >= ROUNDS * frames.length - 1;
  const playing = !reduced && frames.length > 1 && !finished && !userPaused && !held && inView && pageVisible;
  const shown = reduced || finished ? last : step % frames.length;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setStep((current) => current + 1), FRAME_MS);
    return () => window.clearTimeout(timer);
  }, [playing, step]);

  const toggle = () => {
    if (finished) {
      setStep(0);
      setUserPaused(false);
      return;
    }
    setUserPaused((current) => !current);
  };

  const final = frames[last];
  return (
    <div
      ref={box}
      role="group"
      aria-label={label}
      data-playing={playing ? "true" : "false"}
      data-still={reduced || finished ? "true" : "false"}
      className="flex flex-col items-center gap-3"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
      }}
    >
      <p className="sr-only">{summary}</p>
      <div aria-hidden="true" className="relative h-hero-phone w-hero-phone max-w-full">
        {(reduced && final ? [final] : frames).map(({ id, item }, index) => {
          const at = reduced ? last : index;
          return (
            <div key={id} className={`absolute inset-0 flex items-center justify-center transition-opacity duration-500 ease-out motion-reduce:transition-none ${at === shown ? "opacity-100" : "opacity-0"}`}>
              <MediaPicture item={item} alt="" eager={at === 0 || at === last} className="block h-full w-full object-contain" />
            </div>
          );
        })}
      </div>
      {reduced || frames.length < 2 ? null : <PlayPause paused={userPaused || finished} onToggle={toggle} pauseLabel={pauseLabel} playLabel={playLabel} />}
    </div>
  );
}
