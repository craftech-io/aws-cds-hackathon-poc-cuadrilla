// Draws a render made at a fixed design width (a desktop console view) at the width it is given, scaled
// down with a transform so its layout never changes; `crop` keeps a thumbnail's 4:3 frame instead of
// the render's full height. The scaled content is an illustration: it is inert (no focus, no clicks).
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

interface FitToWidthProps {
  readonly designWidth: number;
  readonly crop?: boolean;
  /** Never smaller than this: below it the render keeps this scale and its container scrolls sideways. */
  readonly minScale?: number;
  readonly children: ReactNode;
}

export function FitToWidth({ designWidth, crop = false, minScale = 0, children }: FitToWidthProps) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    // The width available is the container's: the box itself takes the scaled width of the render.
    const container = box.parentElement ?? box;
    const measure = () => {
      const next = Math.max(minScale, Math.min(1, container.clientWidth / designWidth));
      setScale(next);
      setHeight(content.offsetHeight * next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [designWidth, minScale]);

  return (
    <div ref={outer} className={`relative overflow-hidden ${crop ? "aspect-4/3 w-full" : ""}`} style={crop ? undefined : { height, width: designWidth * scale }}>
      <div ref={inner} inert className="absolute left-0 top-0 origin-top-left" style={{ width: designWidth, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
