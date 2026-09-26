// The gallery with zoom (§6.4), the final call to action with "what you can do in your demo today"
// (§1.12) and the footer. The "today" list follows the registry of console views: before the console is
// complete it names only what exists (account, world, home page).
import { CuadrillaWordmark, PoweredByCraftech } from "../../../components/brand/Brand";
import { useDemoBrand } from "../../../context/BrandContext";
import { galleryItems } from "../gallery";
import { useLandingCopy, useLandingLang } from "../lang";
import type { MediaState } from "../media";
import { MediaFigure } from "../MediaFigure";
import { consoleComplete } from "./proof";
import { CONTACT_URL, CtaGroup, Reveal, SectionHeading } from "./parts";

export function GallerySection({ media }: { readonly media: MediaState }) {
  const copy = useLandingCopy().gallery;
  const items = galleryItems(media);
  return (
    <section id="galeria" aria-labelledby="galeria-title" className="scroll-mt-16 mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
      <SectionHeading id="galeria-title" title={copy.title} lead={copy.lead} />
      {media.status === "loading" ? (
        <div aria-hidden="true" className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 wide:grid-cols-5">
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} className="aspect-4/3 rounded-card bg-mist" />
          ))}
        </div>
      ) : (
        <ul className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 wide:grid-cols-5">
          {items.map(({ id, item }, index) => (
            <li key={id} className="min-w-0">
              <Reveal delayMs={(index % 5) * 80}>
                <MediaFigure id={id} item={item} />
              </Reveal>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function FinalCta({ viewNames }: { readonly viewNames: readonly string[] }) {
  const copy = useLandingCopy();
  const final = copy.finalCta;
  const full = consoleComplete(viewNames);
  return (
    <section id="empezar" aria-labelledby="empezar-title" className="scroll-mt-16 bg-navy text-white">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-8 lg:grid-cols-2 lg:py-24">
        <div className="min-w-0">
          <SectionHeading id="empezar-title" title={final.title} lead={final.lead} tone="dark" />
          <div className="mt-8">
            <CtaGroup tone="dark" />
          </div>
          {full ? null : <p className="mt-5 text-sm text-mist">{copy.real.staged}</p>}
        </div>
        <div className="min-w-0 rounded-card border border-navy-soft bg-navy-deep/40 p-6">
          <h3 className="font-display text-lg font-semibold text-cyan">{final.todayTitle}</h3>
          {full ? (
            <p className="mt-3 text-sm text-white">{final.todayFull}</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm text-white">
              {final.todayNow.map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden="true" className="text-cyan">
                    ✓
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  const copy = useLandingCopy().footer;
  const lang = useLandingLang()?.lang ?? "es";
  const brand = useDemoBrand(lang);
  const link = "inline-flex min-h-11 items-center px-2 hover:text-navy hover:underline";
  return (
    <footer id="footer" className="border-t border-mist bg-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-8 text-xs text-slate sm:px-8">
        <CuadrillaWordmark tone="light" size="md" />
        <PoweredByCraftech tone="light" />
        {brand.mode === "cobrand" ? (
          <p role="note" className="max-w-2xl text-center">
            {brand.disclaimer}
          </p>
        ) : null}
        <nav aria-label={copy.label} className="flex flex-wrap justify-center gap-2">
          <a className={link} href="/legal/privacy.html">
            {copy.privacy}
          </a>
          <a className={link} href="/legal/terms.html">
            {copy.terms}
          </a>
          <a className={link} href={CONTACT_URL} target="_blank" rel="noopener">
            {copy.talk}
          </a>
        </nav>
      </div>
    </footer>
  );
}
