// `/`: the commercial landing of Cuadrilla (docs/landing-spec.md §1): header, hero, the problem, the
// walkthrough of one installation, what it does for each role, the rules it guarantees, the impact goals,
// how it fits in, what is real and what is simulated, the gallery, the final call to action and the
// footer — twelve blocks, in Mexican Spanish or English. The brand line is the stage's (`brand.get`,
// ADR-0018). The visuals are renders built with the product's components and texts until the console
// exists; each one is in public/landing/manifest.json with the real capture that replaces it.
import { VIEWS } from "../../lib/view-registry";
import { useRouter } from "../../lib/router";
import { GalleryProvider } from "./gallery";
import { LandingLangProvider, langFromSearch, useLandingCopy } from "./lang";
import { useLandingMedia } from "./media";
import { FinalCta, Footer, GallerySection } from "./sections/closing";
import { Actors, Problem, Trust } from "./sections/content";
import { Header } from "./sections/Header";
import { Hero } from "./sections/Hero";
import { Impact, Integration, RealAndSimulated } from "./sections/proof";
import { Walkthrough } from "./sections/Walkthrough";
import type { MediaState } from "./media";

function Page({ media }: { readonly media: MediaState }) {
  const copy = useLandingCopy();
  return (
    <div className="min-h-screen bg-paper">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-navy">
        {copy.skipToContent}
      </a>
      <Header />
      <main id="main">
        <Hero />
        <Problem />
        <Walkthrough />
        <Actors />
        <Trust />
        <Impact />
        <Integration />
        <RealAndSimulated viewNames={VIEWS.names} />
        <GallerySection media={media} />
        <FinalCta viewNames={VIEWS.names} />
      </main>
      <Footer />
    </div>
  );
}

export function LandingView() {
  const { search } = useRouter();
  const media = useLandingMedia();
  return (
    <LandingLangProvider initial={langFromSearch(search)}>
      <GalleryProvider media={media}>
        <Page media={media} />
      </GalleryProvider>
    </LandingLangProvider>
  );
}
