// Motion primitives of the landing (docs/landing-spec.md §3): the visitor's reduced-motion preference,
// an element entering the viewport (IntersectionObserver), a media query, the page being visible, and
// the frame loop of the counters (M6). The loop runs on requestAnimationFrame and stops on its own; with
// reduced motion it returns its final state at once. No library.
import { type RefObject, useEffect, useState } from "react";

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** Whether a media query matches now, following its changes. */
export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const onChange = () => setValue(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return value;
}

export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** Desktop layout of the walkthrough and the hero (docs/landing-spec.md §4.3). */
export const DESKTOP_QUERY = "(min-width: 1024px)";

interface InViewOptions {
  readonly threshold?: number;
  readonly rootMargin?: string;
  /** Stays true once seen (reveals, counters). */
  readonly once?: boolean;
}

/** Whether the element is in the viewport; true from the start where IntersectionObserver is missing. */
export function useInView(ref: RefObject<Element | null>, { threshold = 0.2, rootMargin = "0px", once = false }: InViewOptions = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          setInView(true);
          if (once) observer.disconnect();
        } else if (!once) setInView(false);
      },
      { threshold, rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold, rootMargin, once]);
  return inView;
}

/** Whether the tab is visible (`visibilitychange`). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/** Eases a counter from 0 to `target` in `durationMs` (M6); straight to the target with reduced motion. */
export function useCountUp(target: number, run: boolean, reduced: boolean, durationMs = 900): number {
  const [value, setValue] = useState(reduced ? target : 0);
  useEffect(() => {
    if (reduced) {
      setValue(target);
      return;
    }
    if (!run) return;
    let frame = 0;
    let start: number | undefined;
    const tick = (now: number) => {
      start ??= now;
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - progress) ** 3;
      setValue(Math.round(target * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, run, reduced, durationMs]);
  return value;
}
