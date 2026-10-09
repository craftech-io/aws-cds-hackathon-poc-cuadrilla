// The product video (ADR-0028, docs/landing-spec.md), before "Cómo se integra": served by the site
// itself from public/landing/video/, with its poster, its controls and a download link for a browser
// that cannot play it. It never plays by itself and downloads nothing until the visitor presses play
// (`preload="none"`), so it costs the first screen nothing. While the manifest has no video (the MP4
// and its poster are not delivered yet) the section is not drawn at all.
import { useLandingCopy, useLandingLang } from "../lang";
import type { LandingVideo, MediaState } from "../media";
import { SectionHeading } from "./parts";

/** The manifest's video, once it is read and names one. */
export function videoOf(media: MediaState): LandingVideo | undefined {
  return media.status === "ready" ? (media.manifest.video ?? undefined) : undefined;
}

export function VideoSection({ media }: { readonly media: MediaState }) {
  const copy = useLandingCopy().video;
  const lang = useLandingLang()?.lang ?? "es";
  const video = videoOf(media);
  if (!video) return null;
  return (
    <section id="video" aria-labelledby="video-title" className="scroll-mt-16 bg-paper">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="video-title" title={copy.title} lead={copy.lead} />
        <figure className="mx-auto mt-10 max-w-4xl">
          <video
            controls
            preload="none"
            playsInline
            poster={video.poster}
            aria-label={copy.label}
            aria-describedby="video-note"
            className="aspect-video w-full rounded-card border border-mist bg-navy-deep shadow-float"
          >
            <source src={video.src} type="video/mp4" />
            <a href={video.src}>{copy.fallback}</a>
          </video>
          <figcaption id="video-note" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate">
            <span>{video.caption?.[lang] ?? copy.note}</span>
            <a href={video.src} download className="inline-flex min-h-11 items-center font-semibold text-cyan-deep underline-offset-4 hover:underline">
              {copy.fallback}
            </a>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
