// Draws a render made at a fixed design width (a desktop console view) at the width it is given, scaled
// down with a transform so its layout never changes. `crop` keeps a thumbnail's 4:3 frame: the whole
// render is scaled to fit it (never cut sideways, never a column or a row sliced through); only a render
// so tall that fitting it would leave it unreadably small keeps the width and fades out at the bottom
// edge. The scaled content is an illustration: it is inert (no focus, no clicks).
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

interface FitToWidthProps {
  readonly designWidth: number;
  readonly crop?: boolean;
  /** Never smaller than this (not in a `crop` frame): below it the render keeps this scale and its container scrolls sideways. */
  readonly minScale?: number;
  readonly children: ReactNode;
}

/** Height over width of a thumbnail's frame. */
export const THUMBNAIL_RATIO = 3 / 4;
/** A render fits its thumbnail whole unless that makes it smaller than this share of the width's scale. */
export const MIN_FIT_SHARE = 0.6;

export interface ThumbnailLayout {
  readonly scale: number;
  /** Left offset that centres the scaled render in the frame. */
  readonly left: number;
  /** The render runs past the bottom of the frame, which fades it out. */
  readonly faded: boolean;
}

/**
 * How a render sits in a `width`-wide 4:3 thumbnail: `contentWidth` is how wide it really draws (at least
 * its design width, more when a table or a card runs past it), so nothing is cut at the right edge.
 */
export function thumbnailLayout(width: number, contentWidth: number, contentHeight: number): ThumbnailLayout {
  const widthScale = Math.min(1, width / contentWidth);
  const frame = width * THUMBNAIL_RATIO;
  const fit = contentHeight > 0 ? Math.min(widthScale, frame / contentHeight) : widthScale;
  const scale = fit >= widthScale * MIN_FIT_SHARE ? fit : widthScale;
  return { scale, left: Math.max(0, (width - contentWidth * scale) / 2), faded: contentHeight * scale > frame + 1 };
}

export function FitToWidth({ designWidth, crop = false, minScale = 0, children }: FitToWidthProps) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<ThumbnailLayout>({ scale: 1, left: 0, faded: false });
  const [height, setHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    // The width available is the container's: the box itself takes the scaled width of the render.
    const container = box.parentElement ?? box;
    const measure = () => {
      if (crop) {
        setLayout(thumbnailLayout(box.clientWidth, Math.max(designWidth, content.scrollWidth), content.offsetHeight));
        return;
      }
      const next = Math.max(minScale, Math.min(1, container.clientWidth / designWidth));
      setLayout({ scale: next, left: 0, faded: false });
      setHeight(content.offsetHeight * next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [designWidth, minScale, crop]);

  return (
    <div ref={outer} className={`relative overflow-hidden ${crop ? "aspect-4/3 w-full" : ""}`} style={crop ? undefined : { height, width: designWidth * layout.scale }}>
      <div ref={inner} inert className="absolute top-0 origin-top-left" style={{ left: layout.left, width: designWidth, transform: `scale(${layout.scale})` }}>
        {children}
      </div>
      {layout.faded ? <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-1/4 bg-linear-to-t from-paper to-transparent" /> : null}
    </div>
  );
}
