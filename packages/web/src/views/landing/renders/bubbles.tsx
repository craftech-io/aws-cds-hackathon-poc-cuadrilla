// The messages inside the landing's phone frame, one per kind of story entry: text (typed out or whole),
// voice note (waveform, duration and ticks, never its transcription: ADR-0023 §6), photo with the
// validator's reaction, document, and the quick-reply buttons of a message. Every text arrives from
// sources.ts; motion is transform and opacity only, and with reduced motion each bubble is born in its
// final state.
import type { ReactNode } from "react";
import { useTypewriter } from "../motion";
import { type PhoneMessage, fileTypeOf, photoSource } from "./sources";

const BUBBLE = "relative max-w-5/6 rounded-bubble px-3 py-2 text-xs leading-snug shadow-card sm:text-sm";
const IN = "self-start rounded-tl-sm bg-white text-ink";
const OUT = "self-end rounded-tr-sm bg-cyan-soft text-ink";

/** The two states of the ticks cross-fade (sent → read): only opacity changes, never the colour. */
export function Ticks({ read }: { readonly read: boolean }) {
  const path = "M1 8.5l3 3 6-7M6.5 11.5l1 1 6-8";
  return (
    <span aria-hidden="true" className="relative inline-block h-3 w-4 align-middle">
      <svg viewBox="0 0 15 15" className={`absolute inset-0 h-3 w-4 text-slate transition-opacity duration-300 ${read ? "opacity-0" : "opacity-100"}`} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
      <svg viewBox="0 0 15 15" className={`absolute inset-0 h-3 w-4 text-info transition-opacity duration-300 ${read ? "opacity-100" : "opacity-0"}`} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </span>
  );
}

function Meta({ time, out, read }: { readonly time: string; readonly out: boolean; readonly read: boolean }) {
  return (
    <span className="ml-2 inline-flex translate-y-0.5 items-center gap-1 whitespace-nowrap text-2xs text-slate">
      {time}
      {out ? <Ticks read={read} /> : null}
    </span>
  );
}

/** Three dots while the other side writes (M2): no text, only opacity and a small lift. */
export function TypingDots() {
  return (
    <span aria-hidden="true" className={`${BUBBLE} ${IN} inline-flex w-14 items-center justify-center gap-1 py-3`}>
      {[0, 1, 2].map((dot) => (
        <span key={dot} className="h-1.5 w-1.5 rounded-full bg-slate motion-safe:animate-typing-dot" style={{ animationDelay: `${dot * 160}ms` }} />
      ))}
    </span>
  );
}

/**
 * A text that types itself out without moving the layout: the whole text reserves the space (and is
 * what assistive technology reads), the typed part is drawn over it.
 */
function TypedText({ text, run, reduced }: { readonly text: string; readonly run: boolean; readonly reduced: boolean }) {
  const { shown, typing } = useTypewriter(text, run, reduced);
  if (!typing && shown >= text.length) return <span className="whitespace-pre-line">{text}</span>;
  return (
    <span className="relative block">
      <span className="whitespace-pre-line opacity-0">{text}</span>
      <span aria-hidden="true" className="absolute inset-0 whitespace-pre-line">
        {text.slice(0, shown)}
        <span className="ml-px inline-block h-3 w-0.5 translate-y-0.5 bg-ink motion-safe:animate-caret" />
      </span>
    </span>
  );
}

function QuickReplies({ labels }: { readonly labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="mt-1 flex w-full max-w-5/6 flex-col gap-1 self-start">
      {labels.map((label) => (
        <span key={label} className="rounded-lg bg-white px-3 py-1.5 text-center text-xs font-semibold text-info shadow-card sm:text-sm">
          {label}
        </span>
      ))}
    </span>
  );
}

function Wave({ play, reduced }: { readonly play: boolean; readonly reduced: boolean }) {
  // A fixed silhouette of 22 bars; with reduced motion every bar rests at the middle (0.6).
  const bars = [0.4, 0.7, 0.5, 0.9, 0.6, 1, 0.7, 0.45, 0.8, 0.55, 0.95, 0.6, 0.35, 0.75, 0.5, 0.85, 0.4, 0.65, 0.9, 0.5, 0.3, 0.6];
  return (
    <span aria-hidden="true" className="flex h-6 min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
      {bars.map((scale, index) => (
        <span
          key={index}
          className={`h-full w-0.75 shrink-0 origin-center rounded-full bg-slate ${play && !reduced ? "animate-wave" : ""}`}
          style={{ transform: `scaleY(${reduced ? 0.6 : scale})`, animationDelay: `${(index % 5) * 90}ms` }}
        />
      ))}
    </span>
  );
}

function durationText(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

interface BubbleProps {
  readonly message: PhoneMessage;
  /** The bubble has appeared (its reaction lands). */
  readonly shown: boolean;
  /** Its own motion (typing, waveform) may run now; a pause keeps where it was. */
  readonly playing: boolean;
  readonly reduced: boolean;
  /** Outgoing messages turn read a moment after they appear. */
  readonly read: boolean;
  /** Smaller photos, for the hero's phone where the whole conversation has to fit. */
  readonly compact?: boolean;
}

function Shell({ out, children }: { readonly out: boolean; readonly children: ReactNode }) {
  return <span className={`${BUBBLE} ${out ? OUT : IN} block`}>{children}</span>;
}

function PhotoBubble({ message, shown, reduced, read, compact = false }: BubbleProps) {
  const entry = message.entry;
  if (entry.kind !== "PHOTO") return null;
  const src = photoSource(entry);
  const out = message.direction === "out";
  return (
    <span className={`${BUBBLE} ${out ? OUT : IN} block p-1 ${compact ? "w-32" : "w-40 sm:w-48"}`}>
      <span className="relative block">
        {src ? (
          <img src={src} alt={entry.text} width={480} height={360} loading="lazy" decoding="async" className="block aspect-4/3 w-full rounded-xl object-cover" />
        ) : (
          <span role="img" aria-label={entry.text} className="flex aspect-4/3 w-full items-center justify-center rounded-xl bg-mist">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-8 w-8 text-slate" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8h3l2-2h6l2 2h3v11H4z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
          </span>
        )}
        <span
          aria-hidden="true"
          className={`absolute -bottom-2 -left-2 flex h-7 w-7 items-center justify-center rounded-full bg-white text-sm shadow-card transition duration-250 ease-overshoot ${
            shown || reduced ? "scale-100 opacity-100 delay-600 motion-reduce:delay-0" : "scale-60 opacity-0"
          }`}
        >
          {entry.reaction}
        </span>
      </span>
      <span className="flex justify-end px-1 pt-1">
        <Meta time={message.time} out={out} read={read} />
      </span>
    </span>
  );
}

function VoiceBubble({ message, playing, reduced, read }: BubbleProps) {
  const entry = message.entry;
  if (entry.kind !== "VOICE") return null;
  return (
    <span className={`${BUBBLE} ${OUT} flex w-60 items-center gap-2 sm:w-64`}>
      <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-info text-white">
        <svg viewBox="0 0 12 12" className="ml-0.5 h-3 w-3" fill="currentColor">
          <path d="M3 1.5v9l7-4.5z" />
        </svg>
      </span>
      <Wave play={playing} reduced={reduced} />
      <span className="text-2xs tabular-nums text-slate">{durationText(entry.durationSec)}</span>
      <Meta time={message.time} out read={read} />
    </span>
  );
}

function DocumentBubble({ message, read }: BubbleProps) {
  const entry = message.entry;
  const out = message.direction === "out";
  return (
    <span className={`${BUBBLE} ${out ? OUT : IN} flex w-56 items-center gap-2 sm:w-64`}>
      <span aria-hidden="true" className="flex h-9 w-8 shrink-0 items-center justify-center rounded-md bg-danger text-2xs font-bold text-white">
        {fileTypeOf(entry.text)}
      </span>
      <span className="min-w-0 flex-1 break-all font-semibold">{entry.text}</span>
      <Meta time={message.time} out={out} read={read} />
    </span>
  );
}

/** One message of a phone, of any kind. */
export function Bubble(props: BubbleProps) {
  const { message, playing, reduced, read } = props;
  const entry = message.entry;
  const out = message.direction === "out";
  if (entry.kind === "VOICE") return <VoiceBubble {...props} />;
  if (entry.kind === "PHOTO") return <PhotoBubble {...props} />;
  if (entry.kind === "DOCUMENT") return <DocumentBubble {...props} />;
  return (
    <>
      <Shell out={out}>
        {message.typed ? <TypedText text={entry.text} run={playing} reduced={reduced} /> : <span className="whitespace-pre-line">{entry.text}</span>}
        <span className="float-right">
          <Meta time={message.time} out={out} read={read} />
        </span>
      </Shell>
      <QuickReplies labels={message.buttons} />
    </>
  );
}
