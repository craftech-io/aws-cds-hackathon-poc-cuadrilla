// The phone frame of the landing's renders: a WhatsApp chat with the product as the contact, the first
// name of whose phone it is, and the story's messages. It belongs to the landing only (not the console's
// phone simulator, which WP-43 builds); WP-44 deletes it with the last render a real capture replaces.
//
// Every message is laid out from the start and revealed in order with opacity and a small translate,
// so the frame never changes size; when the conversation outgrows the screen, the list slides up with a
// transform. `still` shows the final state at once (reduced motion, posters, the gallery), always at
// its reading size, never shrinking the text (a still frame is how the walkthrough reads without motion,
// docs/landing-spec.md §4): a scene's phone keeps the height of its stage and, only when its conversation
// does not fit, scrolls inside it like a phone (focusable), opening on the last message as the motion
// version ends; the wheel or the finger goes on to the page at either end, and a phone whose
// conversation fits never takes the page's scroll. The hero's poster, a gallery render and a short
// phone keep their width and grow to the whole conversation.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bubble, TypingDots } from "./bubbles";
import { CONTACT_NAME, type PhoneMessage, type PhoneOwner, firstNameOf } from "./sources";
import { typingDelay, useScrollReveal } from "../motion";

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

/**
 * Reveals `messages` one by one while `run` holds; `still` jumps to the end. Restarts when `runKey`
 * changes. `floor` is how many must be on screen whatever the clock says: the walkthrough raises it as
 * the visitor scrolls, so a scene never waits on how long someone stays (the timed reveal only runs
 * ahead of it). Reaching the end, by time or by floor, calls `onDone` once per run.
 */
export function usePhoneSequence(messages: readonly PhoneMessage[], run: boolean, still: boolean, runKey = 0, onDone?: () => void, floor = 0): Sequence {
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

  const target = Math.min(messages.length, Math.max(0, Math.floor(floor)));
  const visible = still ? messages.length : Math.max(state.visible, target);

  // The end, however it was reached.
  useEffect(() => {
    if (still || state.done || visible < messages.length) return;
    setState({ visible: messages.length, dotsAt: undefined, done: true });
    doneRef.current?.();
  }, [still, state.done, visible, messages.length]);

  useEffect(() => {
    if (still || !run || state.done) return;
    // Catch up with the floor first, then go on from there.
    if (visible > state.visible) {
      setState({ visible, dotsAt: undefined, done: false });
      return;
    }
    const index = state.visible;
    const message = messages[index];
    if (!message) return;
    const previous = messages[index - 1];
    const before = previous ? stepDuration(previous) : 300;
    const withDots = message.direction === "in" && message.typed;
    const dotsShowing = state.dotsAt === index;
    const timer = window.setTimeout(
      () => setState(withDots && !dotsShowing ? { visible: index, dotsAt: index, done: false } : { visible: index + 1, dotsAt: undefined, done: false }),
      dotsShowing ? DOTS_MS : before,
    );
    return () => window.clearTimeout(timer);
  }, [messages, run, still, state, visible]);

  return { visible, dotsAt: visible > state.visible ? undefined : state.dotsAt, done: still || state.done || visible >= messages.length };
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
  /** How many messages are on screen at least, whole (see usePhoneSequence). */
  readonly floor?: number;
  /** The frame raises its own floor as it scrolls into view (the stacked walkthrough). */
  readonly scrollReveal?: boolean;
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

/** Still, the sizes that grow with the conversation: their width, and a height that follows it. */
const GROWING: Readonly<Partial<Record<PhoneSize, string>>> = {
  short: "w-64",
  hero: "w-hero-phone min-h-80",
  still: "w-phone min-h-80",
};

function edgesOf(box: HTMLElement): { above: boolean; below: boolean } {
  const hidden = box.scrollHeight - box.clientHeight;
  return { above: box.scrollTop >= 2, below: hidden - box.scrollTop >= 2 };
}

export function PhoneFrame({ owner, messages, run, still, reduced, runKey = 0, onDone, size = "solo", floor: given = 0, scrollReveal = false }: PhoneFrameProps) {
  const compact = size === "hero";
  const frame = useRef<HTMLDivElement>(null);
  const scrolled = useScrollReveal(frame, scrollReveal && !still);
  const floor = Math.max(given, Math.ceil(scrolled * messages.length));
  const sequence = usePhoneSequence(messages, run, still, runKey, onDone, floor);
  const viewport = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  // Playing, the list slides up to keep the latest message in sight; still, it scrolls or the frame grows.
  const [offset, setOffset] = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  // Where a scrolling still conversation is: more above it, more below it.
  const [edges, setEdges] = useState({ above: false, below: false });
  const grown = still ? GROWING[size] : undefined;
  const scrolls = still && grown === undefined;

  useLayoutEffect(() => {
    const box = viewport.current;
    const items = list.current;
    if (!box || !items) return;
    const measure = () => {
      if (still) {
        setOffset(0);
        setOverflowing(scrolls && items.offsetHeight > box.clientHeight + 1);
        return;
      }
      const last = items.children[Math.max(0, sequence.visible - 1)] as HTMLElement | undefined;
      const bottom = last ? last.offsetTop + last.offsetHeight : 0;
      setOffset(Math.max(0, bottom - box.clientHeight + 12));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(items);
    return () => observer.disconnect();
  }, [sequence.visible, still, scrolls]);

  // A conversation that does not fit opens on its last message: the same final state the motion version ends on.
  useLayoutEffect(() => {
    const box = viewport.current;
    if (!box || !overflowing) return;
    box.scrollTop = box.scrollHeight;
    setEdges(edgesOf(box));
  }, [overflowing]);

  return (
    <div ref={frame} data-phone-frame={still ? "still" : "playing"} className={`relative flex max-w-full flex-col overflow-hidden rounded-4xl border-8 border-navy-deep bg-paper shadow-float ${grown ?? SIZES[size]}`}>
      <div className="flex items-center gap-2 bg-navy px-3 py-2 text-white">
        <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan text-xs font-bold text-navy-deep">
          {CONTACT_NAME.charAt(0)}
        </span>
        <span className="flex-1 truncate text-sm font-semibold">{CONTACT_NAME}</span>
        <span className="rounded-full bg-navy-soft px-2 py-0.5 text-2xs font-semibold text-cyan-soft">{firstNameOf(owner)}</span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewport}
          className={`relative min-h-0 flex-1 ${overflowing ? "overflow-y-auto" : "overflow-hidden"}`}
          {...(overflowing ? { tabIndex: 0, role: "region", "aria-label": `${CONTACT_NAME} · ${firstNameOf(owner)}` } : {})}
          onScroll={overflowing ? (event) => setEdges(edgesOf(event.currentTarget)) : undefined}
        >
          <ol
            ref={list}
            className="flex origin-top flex-col gap-2 p-3 transition-transform duration-300 ease-out motion-reduce:transition-none"
            style={offset > 0 ? { transform: `translateY(${-offset}px)` } : undefined}
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
                  <Bubble
                    message={message}
                    shown={shown}
                    playing={shown && run && !still}
                    reduced={reduced || still}
                    complete={index < floor || index < sequence.visible - 1}
                    read={still || sequence.done || index < sequence.visible - 1}
                    compact={compact}
                  />
                </li>
              );
            })}
          </ol>
        </div>
        {/* More of the conversation above or below: a fade over the edge line until it is scrolled there. */}
        {overflowing && edges.above ? <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-linear-to-b from-paper to-transparent" /> : null}
        {overflowing && edges.below ? <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-paper to-transparent" /> : null}
      </div>
    </div>
  );
}
