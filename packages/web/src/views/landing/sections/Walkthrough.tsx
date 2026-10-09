// The heart of the landing (docs/landing-spec.md §1.5, §1.6, §4): six scenes of one installation.
//
// From 1024 px the narrative scrolls on the left and the visual stays pinned on the right; the scene
// whose block crosses the middle of the viewport is the active one, its captures of the real console
// cross-fade in (M5), the progress bar follows the visitor's scroll (M7) and the fibre pulse moves to its
// marker (M10). Never scroll-jacking: the page scrolls at its normal speed. Below 1024 px every scene is
// a card with its own captures (at most 70 % of the screen's height), no snap and no carousel. With
// reduced motion nothing moves.
import { type RefObject, useEffect, useRef, useState } from "react";
import { STORY_SCENE_IDS, type StorySceneId } from "@cuadrilla/bff/story/types";
import { ScenePictures, capturesOf } from "../captured";
import { useLandingCopy, useLandingLang } from "../lang";
import type { MediaState } from "../media";
import { DESKTOP_QUERY, useMediaQuery, useReducedMotion } from "../motion";
import { SCENE_ENTRY_IDS, sceneCaption, sceneStart } from "../story";
import { SectionHeading } from "./parts";

const TOTAL = STORY_SCENE_IDS.length;

function useSceneText(scene: StorySceneId) {
  const copy = useLandingCopy().walkthrough;
  const lang = useLandingLang()?.lang ?? "es";
  const start = sceneStart(scene);
  return {
    copy,
    scene: copy.scenes[scene],
    when: `${start.time} · ${copy.order(start.workOrderNumber)}`,
    caption: lang === "en" ? sceneCaption(scene) : undefined,
  };
}

function Caption({ text }: { readonly text: string | undefined }) {
  if (!text) return null;
  return (
    <p lang="en" className="mt-3 max-w-md border-l-2 border-info pl-3 text-sm italic text-slate">
      “{text}”
    </p>
  );
}

function SceneText({ scene, index, active }: { readonly scene: StorySceneId; readonly index: number; readonly active: boolean }) {
  const { copy, scene: text, when } = useSceneText(scene);
  return (
    <>
      <p className="font-display text-xs font-semibold uppercase tracking-widest text-cyan-deep">
        {copy.stepOf(index + 1, TOTAL)} · {when}
      </p>
      <h3 id={`scene-${scene}`} className={`mt-2 font-display text-2xl font-semibold ${active ? "text-navy" : "text-slate"}`}>
        {text.title}
      </h3>
      {text.lines.map((line) => (
        <p key={line} className="mt-3 text-base text-ink">
          {line}
        </p>
      ))}
      <p className="mt-3 text-xs text-slate">
        <span className="font-semibold text-navy">{copy.realLabel}:</span> {text.real}
      </p>
    </>
  );
}

/** A scene's visual: its captures of the real console, once the manifest is read. */
function SceneVisual({ scene, media, desktop }: { readonly scene: StorySceneId; readonly media: MediaState; readonly desktop: boolean }) {
  const lang = useLandingLang()?.lang ?? "es";
  const pictures = capturesOf(media, SCENE_ENTRY_IDS[scene]);
  return pictures ? <ScenePictures pictures={pictures} lang={lang} desktop={desktop} /> : null;
}

// ---- Desktop: pinned visual, narrative scrolling -------------------------------------------------------

function useActiveScene(blocks: RefObject<(HTMLElement | null)[]>): { readonly active: number; readonly progress: number } {
  const [state, setState] = useState({ active: 0, progress: 0 });
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const middle = window.innerHeight / 2;
      const elements = blocks.current ?? [];
      let active = 0;
      elements.forEach((element, index) => {
        if (element && element.getBoundingClientRect().top <= middle) active = index;
      });
      const rect = elements[active]?.getBoundingClientRect();
      const progress = rect ? Math.min(1, Math.max(0, (middle - rect.top) / rect.height)) : 0;
      setState((current) => (current.active === active && Math.abs(current.progress - progress) < 0.01 ? current : { active, progress }));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [blocks]);
  return state;
}

function DesktopWalkthrough({ reduced, media }: { readonly reduced: boolean; readonly media: MediaState }) {
  const copy = useLandingCopy().walkthrough;
  const lang = useLandingLang()?.lang ?? "es";
  const blocks = useRef<(HTMLElement | null)[]>([]);
  const { active, progress } = useActiveScene(blocks);
  const [plays, setPlays] = useState<Record<string, number>>({});
  useEffect(() => {
    const scene = STORY_SCENE_IDS[active];
    if (scene) setPlays((current) => ({ ...current, [scene]: (current[scene] ?? 0) + 1 }));
  }, [active]);
  const activeScene = STORY_SCENE_IDS[active] ?? "S1";
  return (
    <div className="relative mt-12 grid grid-cols-20 gap-10">
      <div className="relative col-span-9 border-l-2 border-navy-soft/30 pl-8">
        <span aria-hidden="true" className="absolute -left-2 -top-3 h-3 w-4.5 rounded-sm border-2 border-navy-soft bg-paper" />
        <span aria-hidden="true" className="absolute -bottom-3 -left-1.25 h-3 w-3 rounded-full border-2 border-navy-soft bg-paper" />
        <ol>
        {STORY_SCENE_IDS.map((scene, index) => (
          <li
            key={scene}
            ref={(element) => {
              blocks.current[index] = element;
            }}
            aria-labelledby={`scene-${scene}`}
            className={`relative flex min-h-scene-block flex-col justify-center transition-opacity duration-300 motion-reduce:transition-none ${index === active ? "opacity-100" : "opacity-60"}`}
          >
            <span aria-hidden="true" className={`absolute -left-8.75 top-1/2 h-24 w-1 -translate-y-1/2 rounded-full bg-cyan transition duration-300 motion-reduce:transition-none ${index === active ? "scale-y-100 opacity-100" : "scale-y-0 opacity-0"}`} />
            <span
              aria-hidden="true"
              key={index === active ? `pulse-${plays[scene] ?? 0}` : "idle"}
              className={`absolute -left-10.25 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-white ${index === active ? `bg-cyan ${reduced ? "" : "animate-fiber-pulse"}` : "bg-mist"}`}
            />
            <SceneText scene={scene} index={index} active={index === active} />
          </li>
        ))}
        </ol>
      </div>
      <div className="col-span-11">
        <div className="sticky top-24 flex flex-col items-center">
          <div className="relative flex h-phone w-full items-center justify-center">
            {STORY_SCENE_IDS.map((scene, index) => {
              const shown = index === active;
              const side = index < active ? "-translate-x-4" : "translate-x-4";
              return (
                <div
                  key={scene}
                  aria-hidden={shown ? undefined : true}
                  inert={!shown}
                  aria-labelledby={shown ? `scene-${scene}` : undefined}
                  role={shown ? "group" : undefined}
                  className={`absolute inset-0 flex items-center justify-center transition duration-220 ease-out motion-reduce:transition-none ${shown ? "translate-x-0 opacity-100" : `${side} pointer-events-none opacity-0`}`}
                >
                  <SceneVisual scene={scene} media={media} desktop />
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex w-full max-w-md items-center gap-3">
            {reduced ? null : (
              <span role="progressbar" aria-label={copy.progress} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} className="h-1 flex-1 overflow-hidden rounded-full bg-mist">
                <span className="block h-full w-full origin-left bg-cyan-deep" style={{ transform: `scaleX(${progress})` }} />
              </span>
            )}
            <span className="font-display text-sm font-semibold tabular-nums text-navy">{copy.stepOf(active + 1, TOTAL)}</span>
          </div>
          <Caption text={lang === "en" ? sceneCaption(activeScene) : undefined} />
        </div>
      </div>
    </div>
  );
}

// ---- Mobile and tablet: stacked cards -----------------------------------------------------------------

function SceneCard({ scene, index, media }: { readonly scene: StorySceneId; readonly index: number; readonly media: MediaState }) {
  const { caption } = useSceneText(scene);
  return (
    <li aria-labelledby={`scene-${scene}`} className="rounded-card border border-mist bg-white p-5 shadow-card sm:p-6">
      <span aria-hidden="true" className="mb-3 flex gap-1.5">
        {STORY_SCENE_IDS.map((dot, at) => (
          <span key={dot} className={`h-2 w-2 rounded-full ${at === index ? "bg-cyan-deep" : "bg-mist"}`} />
        ))}
      </span>
      <SceneText scene={scene} index={index} active />
      <div role="group" aria-labelledby={`scene-${scene}`} className="mt-5 flex justify-center">
        <SceneVisual scene={scene} media={media} desktop={false} />
      </div>
      <Caption text={caption} />
    </li>
  );
}

export function Walkthrough({ media }: { readonly media: MediaState }) {
  const copy = useLandingCopy().walkthrough;
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const reduced = useReducedMotion();
  return (
    <section id="recorrido" aria-labelledby="recorrido-title" className="scroll-mt-16 bg-paper">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="recorrido-title" title={copy.title} lead={copy.lead} />
        {desktop ? (
          <DesktopWalkthrough reduced={reduced} media={media} />
        ) : (
          <ol className="mt-10 space-y-6">
            {STORY_SCENE_IDS.map((scene, index) => (
              <SceneCard key={scene} scene={scene} index={index} media={media} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
