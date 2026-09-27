// One visual of the landing's gallery, from the manifest: a render of a console view drawn live and
// scaled into its thumbnail, or a capture as a <picture> (AVIF/WebP, lazy, sized up front). A
// placeholder says so ("capture pending"). The thumbnail is a button that opens the viewer.
import { useReducedMotion } from "./motion";
import { useGallery } from "./gallery";
import { useLandingCopy, useLandingLang } from "./lang";
import { type MediaItem, type PictureItem, isPicture } from "./media";
import { CONSOLE_PAGE_WIDTHS, ConsolePageWidthProvider } from "./renders/console-views";
import { FitToWidth } from "./renders/FitToWidth";
import { RENDERS, isRenderId } from "./renders/registry";

/** Width the console views are drawn at before scaling (a desktop console's content column). */
export const CONSOLE_DESIGN_WIDTH = CONSOLE_PAGE_WIDTHS.page;

/**
 * A render of the registry, in its final state, fitted to the width it gets. As a thumbnail (`crop`) a
 * console view draws in the narrower thumbnail column, so it reflows into its frame and is scaled whole.
 */
export function RenderView({ id, crop = false, minScale }: { readonly id: string; readonly crop?: boolean; readonly minScale?: number }) {
  const reduced = useReducedMotion();
  if (!isRenderId(id)) return null;
  const Render = RENDERS[id];
  const width = crop ? "thumbnail" : "page";
  return (
    <ConsolePageWidthProvider value={width}>
      <FitToWidth designWidth={CONSOLE_PAGE_WIDTHS[width]} crop={crop} minScale={minScale}>
        <Render run={false} still reduced={reduced} />
      </FitToWidth>
    </ConsolePageWidthProvider>
  );
}

export function MediaPicture({ item, alt, eager = false }: { readonly item: PictureItem; readonly alt: string; readonly eager?: boolean }) {
  return (
    <picture>
      {item.sources.map((source) => (
        <source key={source.type} type={source.type} srcSet={source.srcset} />
      ))}
      <img src={item.file} alt={alt} width={item.width} height={item.height} loading={eager ? "eager" : "lazy"} decoding="async" className="block h-auto w-full" />
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
  // A thumbnail fits the whole view into its 4:3 frame; the viewer shows it at a reading size.
  const visual = isPicture(item) ? <MediaPicture item={item} alt={gallery ? "" : alt} /> : <RenderView id={id} crop />;
  return (
    <figure className="min-w-0">
      <div className="group relative overflow-hidden rounded-card border border-mist bg-paper shadow-card">
        <div className="transition-transform duration-150 group-active:scale-98 motion-reduce:transition-none">{visual}</div>
        {gallery ? (
          // Over the visual, not around it: a render may draw the console's own buttons, and a button never nests in another.
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
