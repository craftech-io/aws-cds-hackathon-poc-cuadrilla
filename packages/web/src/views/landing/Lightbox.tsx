// Viewer of the landing gallery: a native <dialog> (Escape, focus and the backdrop come from the
// browser) showing one view at up to the size of the viewport — a render drawn live and scaled to fit,
// or a capture. Previous and next by the arrow buttons, the ← and → keys or a horizontal swipe; a click
// outside the view, the close button or Escape closes it. No library and no inline script.
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { GalleryItem } from "./gallery";
import { useLandingCopy, useLandingLang } from "./lang";
import { MediaPicture, RenderView } from "./MediaFigure";

interface LightboxProps {
  readonly items: readonly GalleryItem[];
  readonly index: number | undefined;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
}

const SWIPE_PX = 48;
// Beside the view from 640 px; under it, next to the caption, on a phone (never over the view).
const NAV = "flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-lg font-semibold text-navy shadow-card hover:bg-white sm:absolute sm:top-1/2 sm:-translate-y-1/2";

export function Lightbox({ items, index, onIndex, onClose }: LightboxProps) {
  const landingCopy = useLandingCopy();
  const lang = useLandingLang()?.lang ?? "es";
  const dialog = useRef<HTMLDialogElement>(null);
  const swipeFrom = useRef<number | undefined>(undefined);
  const current = index === undefined ? undefined : items[index];
  const open = current !== undefined;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const step = (delta: number) => {
    if (index === undefined || items.length === 0) return;
    onIndex((index + delta + items.length) % items.length);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "ArrowRight") step(1);
    if (event.key === "ArrowLeft") step(-1);
    // Handled here too: the dialog's own Escape only closes it for trusted key presses.
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  // Swipes are for touch; a mouse drag over the view must not also count as a click.
  const onPointerDown = (event: PointerEvent) => {
    swipeFrom.current = event.pointerType === "mouse" ? undefined : event.clientX;
  };
  const onPointerUp = (event: PointerEvent) => {
    const from = swipeFrom.current;
    swipeFrom.current = undefined;
    if (from === undefined) return;
    const delta = event.clientX - from;
    if (Math.abs(delta) >= SWIPE_PX) step(delta < 0 ? 1 : -1);
  };
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  const alt = current?.item.alt[lang];

  return (
    <dialog
      ref={dialog}
      aria-label={alt ?? landingCopy.zoom.open}
      onClose={onClose}
      onClick={onClose}
      onKeyDown={onKeyDown}
      className="m-auto max-h-none max-w-none bg-transparent p-0 backdrop:bg-navy-deep/90"
    >
      {current ? (
        <div className="relative flex h-dvh w-dvw flex-col items-center justify-center gap-3 px-3 py-16 sm:px-20">
          <div onClick={stop} onPointerDown={onPointerDown} onPointerUp={onPointerUp} className="min-h-0 w-full max-w-240 touch-pan-y overflow-auto rounded-card bg-white shadow-float">
            {current.item.status === "render" ? <RenderView id={current.id} minScale={0.6} /> : <MediaPicture item={current.item} alt={alt ?? ""} eager />}
          </div>
          <p onClick={stop} className="max-w-3xl text-center text-sm text-white">
            {alt} <span className="ml-2 text-mist">{landingCopy.zoom.counter((index ?? 0) + 1, items.length)}</span>
          </p>
          {items.length > 1 ? (
            <div className="flex gap-4">
              <button type="button" aria-label={landingCopy.zoom.previous} onClick={(event) => (stop(event), step(-1))} className={`${NAV} sm:left-4`}>
                ‹
              </button>
              <button type="button" aria-label={landingCopy.zoom.next} onClick={(event) => (stop(event), step(1))} className={`${NAV} sm:right-4`}>
                ›
              </button>
            </div>
          ) : null}
          <button
            type="button"
            aria-label={landingCopy.zoom.close}
            title={landingCopy.zoom.close}
            onClick={onClose}
            className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full bg-white/90 text-navy shadow-card hover:bg-white"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ) : null}
    </dialog>
  );
}
