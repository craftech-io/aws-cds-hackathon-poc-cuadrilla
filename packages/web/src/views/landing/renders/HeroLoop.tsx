// The hero's product loop (`hero-loop`, M0 of docs/landing-spec.md §3): in one phone, the heart of the
// walkthrough compressed — the voice note (waveform, duration and ticks, never its transcription), the
// cited reply, the rejected photo with 🔁 and its reason, the next photo with ✅ and the certificate.
// It plays twice and rests on the final frame, with everything on screen at once. A visible control
// pauses and plays it; hover, focus inside it, leaving the viewport and a hidden tab pause it too
// (WCAG 2.2.2). With reduced motion it is a still poster of the final frame. The phone is hidden from
// assistive technology: the summary the hero passes in is its text alternative.
import { useEffect, useRef, useState } from "react";
import { useInView, usePageVisible, useReducedMotion } from "../motion";
import { PhoneFrame } from "./PhoneFrame";
import { phoneMessages } from "./sources";

export const HERO_LOOP_ENTRIES = ["s1-voice-note", "s1-diagnosis-reply", "s3-label-glare-photo", "s3-glare-reason", "s3-label-photo", "s4-certificate"] as const;
const MESSAGES = phoneMessages("inst-rogelio", HERO_LOOP_ENTRIES);

/** Plays this many times, then rests on the final frame. */
export const HERO_LOOPS = 2;
/** Rest on the complete conversation before the next time round (a round lasts 14-18 s). */
const HOLD_MS = 4_000;

interface HeroLoopProps {
  readonly label: string;
  readonly pauseLabel: string;
  readonly playLabel: string;
  /** Text alternative of the whole loop; the only place the voice note's words may appear. */
  readonly summary: string;
}

export function HeroLoop({ label, pauseLabel, playLabel, summary }: HeroLoopProps) {
  const reduced = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const inView = useInView(box, { threshold: 0.25 });
  const pageVisible = usePageVisible();
  const [userPaused, setUserPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [round, setRound] = useState(0);
  const [holding, setHolding] = useState(false);
  const [finished, setFinished] = useState(false);

  const playing = !reduced && !finished && !userPaused && !hovered && !focused && inView && pageVisible;

  useEffect(() => {
    if (!holding || !playing) return;
    const timer = window.setTimeout(() => {
      setHolding(false);
      if ((round + 1) % HERO_LOOPS === 0) setFinished(true);
      else setRound((current) => current + 1);
    }, HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [holding, playing, round]);

  const toggle = () => {
    if (finished) {
      setFinished(false);
      setUserPaused(false);
      setRound((current) => current + 1);
      return;
    }
    setUserPaused((current) => !current);
  };

  const still = reduced || finished;
  return (
    <div
      ref={box}
      role="group"
      aria-label={label}
      data-playing={playing ? "true" : "false"}
      data-still={still ? "true" : "false"}
      className="flex flex-col items-center gap-3"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <p className="sr-only">{summary}</p>
      <div aria-hidden="true">
        <PhoneFrame owner="inst-rogelio" messages={MESSAGES} run={playing} still={still} reduced={reduced} runKey={round} size="hero" onDone={() => setHolding(true)} />
      </div>
      {reduced ? null : (
        <button
          type="button"
          onClick={toggle}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-navy-soft bg-navy-deep/60 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-navy-soft"
        >
          <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center">
            {userPaused || finished ? (
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
                <path d="M3 1.5v9l7-4.5z" />
              </svg>
            ) : (
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
                <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" />
              </svg>
            )}
          </span>
          {userPaused || finished ? playLabel : pauseLabel}
        </button>
      )}
    </div>
  );
}
