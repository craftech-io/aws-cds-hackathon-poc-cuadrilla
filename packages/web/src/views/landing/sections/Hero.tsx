// The hero (docs/landing-spec.md §1.3): what it is, for whom and that it works, with the three calls to
// action and the product loop (the captured frames of the installer's phone). From 1024 px two columns
// (text 55, loop 45); below, the text and the primary call to action come first, above the fold at
// 360×640, and the loop follows at 320 px or more.
// The note under the calls to action says the demo is synthetic: the operator is "fictitious" in the
// neutral mode, or the co-branding disclaimer of the stage is shown (ADR-0018).
import { enGloss } from "@cuadrilla/bff/copy/en-gloss";
import { esMX } from "@cuadrilla/bff/copy/es-MX";
import { useDemoBrand } from "../../../context/BrandContext";
import { HeroFrames, heroFrames } from "../captured";
import { useLandingCopy, useLandingLang } from "../lang";
import type { MediaState } from "../media";
import { storyEntry } from "../story";
import { CtaGroup, FiberStrand } from "./parts";

const VOICE_NOTE = storyEntry("s1-voice-note");

export function Hero({ media }: { readonly media: MediaState }) {
  const copy = useLandingCopy();
  const lang = useLandingLang()?.lang ?? "es";
  const brand = useDemoBrand(lang);
  const notice = brand.mode === "cobrand" ? brand.disclaimer : lang === "en" ? enGloss.fictitiousOperatorNotice : esMX.fictitiousOperatorNotice;
  const voiceText = lang === "en" ? VOICE_NOTE.glossEn : VOICE_NOTE.text;
  const loop = { label: copy.hero.loop.label, pauseLabel: copy.hero.loop.pause, playLabel: copy.hero.loop.play, summary: copy.hero.loop.summary(voiceText) };
  const frames = heroFrames(media);
  return (
    <section id="hero" aria-labelledby="hero-title" className="scroll-mt-16 relative overflow-hidden bg-navy text-white">
      <FiberStrand className="bottom-10 left-1 top-10 lg:hidden" />
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-8 lg:grid-cols-20 lg:items-center lg:py-20">
        <div className="min-w-0 lg:col-span-11">
          <p className="font-display text-xs font-semibold uppercase tracking-widest text-cyan">{copy.hero.eyebrow}</p>
          <h1 id="hero-title" className="mt-4 font-display text-hero font-semibold text-white">
            {copy.hero.title}
          </h1>
          <p className="mt-5 text-lead text-mist">{copy.hero.lead}</p>
          <div className="mt-7">
            <CtaGroup tone="dark" />
          </div>
          <p className="mt-5 max-w-xl text-sm text-cyan-soft">{copy.hero.note}</p>
          <p role="note" className="mt-2 max-w-xl text-sm text-mist">
            {notice}
          </p>
        </div>
        <div className="flex min-w-0 justify-center lg:col-span-9">
          {frames ? <HeroFrames frames={frames} {...loop} /> : null}
        </div>
      </div>
    </section>
  );
}
