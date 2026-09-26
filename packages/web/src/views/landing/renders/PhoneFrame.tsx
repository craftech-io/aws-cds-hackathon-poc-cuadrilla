// The phone frame of the landing's renders: a WhatsApp chat with the product as the contact, the first
// name of whose phone it is, and the story's messages. It belongs to the landing only (not the console's
// phone simulator, which WP-43 builds); WP-44 deletes it with the last render a real capture replaces.
//
// Every message is laid out from the start and revealed in order with opacity and a small translate,
// so the frame never changes size; when the conversation outgrows the screen, the list slides up with a
// transform. `still` shows the final state at once (reduced motion, posters, the gallery).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bubble, TypingDots } from "./bubbles";
import { CONTACT_NAME, type PhoneMessage, type PhoneOwner, firstNameOf } from "./sources";
import { typingDelay } from "../motion";

/** How long each message holds the stage before the next one, in ms. */
export function stepDuration(message: PhoneMessage): number {
  const entry = message.entry;
  if (message.typed) return Math.round(entry.text.length * typingDelay(entry.text.length)) + 500;
  if (entry.kind === "PHOTO") return 1300;
  if (entry.kind === "VOICE") return 1600;
  return message.direction === "out" ? 800 : 1100;
}

/** The typing dots come before an incoming message the other side "writes". */
const DOTS_MS = 700;

export interface Sequence {
  readonly visible: number;
  /** Index of the message whose typing dots show, if any. */
  readonly dotsAt: number | undefined;
  readonly done: boolean;
}

/** Reveals `messages` one by one while `run` holds; `still` jumps to the end. Restarts when `runKey` changes. */
export function usePhoneSequence(messages: readonly PhoneMessage[], run: boolean, still: boolean, runKey = 0, onDone?: () => void): Sequence {
  const [state, setState] = useState<Sequence>(() => (still ? { visible: messages.length, dotsAt: undefined, done: true } : { visible: 0, dotsAt: undefined, done: false }));
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (still) {
      setState({ visible: messages.length, dotsAt: undefined, done: true });
      return;
    }
    setState({ visible: 0, dotsAt: undefined, done: false });
  }, [still, messages, runKey]);

  useEffect(() => {
    if (still || !run || state.done) return;
    const index = state.visible;
    const message = messages[index];
    if (!message) {
      setState({ visible: index, dotsAt: undefined, done: true });
      doneRef.current?.();
      return;
    }
    const previous = messages[index - 1];
    const before = previous ? stepDuration(previous) : 300;
    const withDots = message.direction === "in" && message.typed;
    const dotsShowing = state.dotsAt === index;
    const timer = window.setTimeout(
      () => setState(withDots && !dotsShowing ? { visible: index, dotsAt: index, done: false } : { visible: index + 1, dotsAt: undefined, done: false }),
      dotsShowing ? DOTS_MS : before,
    );
    return () => window.clearTimeout(timer);
  }, [messages, run, still, state]);

  return state;
}

interface PhoneFrameProps {
  readonly owner: PhoneOwner;
  readonly messages: readonly PhoneMessage[];
  readonly run: boolean;
  readonly still: boolean;
  readonly reduced: boolean;
  /** Changing it replays the conversation from the first message. */
  readonly runKey?: number;
  readonly onDone?: () => void;
  readonly size?: PhoneSize;
}

/**
 * How big the frame is: alone in a scene, one of two side by side, the top crop of a secondary phone
 * with a short conversation, the hero's, or a still one (gallery, checks). The width follows the proportions.
 */
export type PhoneSize = "solo" | "pair" | "short" | "hero" | "still";

const SIZES: Readonly<Record<PhoneSize, string>> = {
  solo: "aspect-9/19 h-phone max-h-scene lg:max-h-none",
  pair: "aspect-9/19 h-phone max-h-scene lg:h-phone-pair lg:max-h-none",
  short: "aspect-3/4 w-64",
  hero: "aspect-9/19 h-hero-phone min-h-80",
  still: "aspect-9/19 h-phone",
};

export function PhoneFrame({ owner, messages, run, still, reduced, runKey = 0, onDone, size = "solo" }: PhoneFrameProps) {
  const compact = size === "hero";
  const sequence = usePhoneSequence(messages, run, still, runKey, onDone);
  const viewport = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  // Playing, the list slides up to keep the latest message in sight; still, it shrinks to show them all.
  const [fit, setFit] = useState({ offset: 0, scale: 1 });

  useLayoutEffect(() => {
    const box = viewport.current;
    const items = list.current;
    if (!box || !items) return;
    const measure = () => {
      if (still) {
        const scale = Math.min(1, box.clientHeight / Math.max(1, items.offsetHeight));
        setFit({ offset: 0, scale });
        return;
      }
      const last = items.children[Math.max(0, sequence.visible - 1)] as HTMLElement | undefined;
      const bottom = last ? last.offsetTop + last.offsetHeight : 0;
      setFit({ offset: Math.max(0, bottom - box.clientHeight + 12), scale: 1 });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(items);
    return () => observer.disconnect();
  }, [sequence.visible, still]);

  return (
    <div className={`flex max-w-full flex-col overflow-hidden rounded-4xl border-8 border-navy-deep bg-paper shadow-float ${SIZES[size]}`}>
      <div className="flex items-center gap-2 bg-navy px-3 py-2 text-white">
        <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan text-xs font-bold text-navy-deep">
          {CONTACT_NAME.charAt(0)}
        </span>
        <span className="flex-1 truncate text-sm font-semibold">{CONTACT_NAME}</span>
        <span className="rounded-full bg-navy-soft px-2 py-0.5 text-2xs font-semibold text-cyan-soft">{firstNameOf(owner)}</span>
      </div>
      <div ref={viewport} className="relative flex-1 overflow-hidden">
        <ol
          ref={list}
          className="flex origin-top flex-col gap-2 p-3 transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={{ transform: fit.scale < 1 ? `scale(${fit.scale})` : `translateY(${-fit.offset}px)` }}
        >
          {messages.map((message, index) => {
            const shown = index < sequence.visible;
            const out = message.direction === "out";
            return (
              <li
                key={message.entry.id}
                aria-hidden={shown ? undefined : true}
                className={`relative flex flex-col transition duration-300 ease-out motion-reduce:transition-none ${out ? "items-end" : "items-start"} ${shown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"}`}
              >
                {sequence.dotsAt === index && !shown ? (
                  <span className="absolute left-0 top-0 opacity-100">
                    <TypingDots />
                  </span>
                ) : null}
                <Bubble message={message} shown={shown} playing={shown && run && !still} reduced={reduced || still} read={still || sequence.done || index < sequence.visible - 1} compact={compact} />
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
