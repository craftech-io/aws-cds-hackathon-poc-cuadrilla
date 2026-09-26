// A picture of the landing, from the manifest: lazy-loaded, sized up front (no layout shift), and
// marked when it is still a placeholder of a console capture. Nothing renders while the manifest
// loads or if it cannot be read.
import { type MediaState, mediaOf } from "./media";
import { useGallery } from "./gallery";
import { useLandingCopy } from "./lang";

interface MediaFigureProps {
  readonly media: MediaState;
  readonly id: string;
  readonly caption?: string;
  readonly className?: string;
  readonly framed?: boolean;
}

export function MediaFigure({
  media,
  id,
  caption,
  className = "",
  framed = true,
}: MediaFigureProps) {
  const landingCopy = useLandingCopy();
  const gallery = useGallery();
  const item = mediaOf(media, id);
  if (!item)
    return media.status === "loading" ? (
      <div
        aria-hidden="true"
        className={`animate-pulse rounded-card bg-mist ${className}`}
      />
    ) : null;
  const placeholder = item.status === "placeholder";
  return (
    <figure className={className}>
      <div
        className={`relative overflow-hidden ${framed ? "rounded-card border border-mist bg-white shadow-card" : ""}`}
      >
        {gallery ? (
          <button
            type="button"
            onClick={() => gallery.open(id)}
            aria-label={`${landingCopy.zoom.open}: ${item.alt}`}
            className="group block w-full cursor-zoom-in"
          >
            <img
              src={item.file}
              alt={item.alt}
              width={item.width}
              height={item.height}
              loading="lazy"
              decoding="async"
              className="block h-auto w-full transition group-hover:opacity-95"
            />
          </button>
        ) : (
          <img
            src={item.file}
            alt={item.alt}
            width={item.width}
            height={item.height}
            loading="lazy"
            decoding="async"
            className="block h-auto w-full"
          />
        )}
        {placeholder ? (
          <span
            title={landingCopy.media.placeholderTitle}
            className="absolute bottom-2 right-2 rounded-full bg-navy/85 px-2 py-0.5 text-xs font-medium text-white"
          >
            {landingCopy.media.placeholderNote}
          </span>
        ) : null}
      </div>
      {caption ? (
        <figcaption className="mt-2 text-xs text-slate">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
