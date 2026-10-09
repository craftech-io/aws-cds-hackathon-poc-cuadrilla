// One visual of the landing's gallery, from the manifest: a capture of the real console as a <picture>
// (AVIF/WebP, lazy, sized up front). A placeholder says so ("capture pending"). The thumbnail is a
// button that opens the viewer.
import { useGallery } from "./gallery";
import { useLandingCopy, useLandingLang } from "./lang";
import type { MediaItem } from "./media";

interface MediaPictureProps {
  readonly item: MediaItem;
  readonly alt: string;
  /** Above the fold: loaded at once and first (the hero's frame); the rest wait for the viewport. */
  readonly eager?: boolean;
  /** Size of the image in its slot; by default it takes the slot's width. */
  readonly className?: string;
}

export function MediaPicture({ item, alt, eager = false, className = "block h-auto w-full" }: MediaPictureProps) {
  return (
    <picture>
      {item.sources.map((source) => (
        <source key={source.type} type={source.type} srcSet={source.srcset} />
      ))}
      <img
        src={item.file}
        alt={alt}
        width={item.width}
        height={item.height}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
        decoding="async"
        className={className}
      />
    </picture>
  );
}

interface MediaFigureProps {
  readonly id: string;
  readonly item: MediaItem;
}

export function MediaFigure({ id, item }: MediaFigureProps) {
  const copy = useLandingCopy();
  const lang = useLandingLang()?.lang ?? "es";
  const gallery = useGallery();
  const alt = item.alt[lang];
  const visual = <MediaPicture item={item} alt={gallery ? "" : alt} />;
  return (
    <figure className="min-w-0">
      <div className="group relative overflow-hidden rounded-card border border-mist bg-paper shadow-card">
        {/* Under the zoom button the thumbnail is decorative: the button carries its description. */}
        <div aria-hidden={gallery ? true : undefined} className="transition-transform duration-150 group-active:scale-98 motion-reduce:transition-none">
          {visual}
        </div>
        {gallery ? (
          // Over the visual, not around it: the zoom button covers the whole thumbnail.
          <button
            type="button"
            onClick={(event) => gallery.open(id, event.currentTarget)}
            aria-label={`${copy.zoom.open}: ${alt}`}
            className="absolute inset-0 cursor-zoom-in rounded-card hover:bg-navy/5"
          />
        ) : null}
        {item.status === "placeholder" ? (
          <span title={copy.media.placeholderTitle} className="absolute bottom-2 right-2 rounded-full bg-navy/85 px-2 py-0.5 text-xs font-medium text-white">
            {copy.media.placeholderNote}
          </span>
        ) : null}
      </div>
      <figcaption className="mt-2 text-xs text-slate">{alt}</figcaption>
    </figure>
  );
}
