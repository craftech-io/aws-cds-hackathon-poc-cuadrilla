// `/`: the public welcome page of the demo, with the brand line of BrandMark (neutral "Cuadrilla ·
// Powered by Craftech" until WP-44 reads the stage's brand from `brand.get`, ADR-0018), in Spanish or
// English. No login: it tells the story, says what is real and what is simulated, and sends judges
// to the console. A signed-in visitor still lands here, with the call to action pointing to the
// console. WP-44 adds the video, the scenes of the demo and the gallery of real captures.
import { CuadrillaWordmark, PoweredByCraftech } from "../../components/brand/Brand";
import { BrandMark } from "../../components/brand/BrandMark";
import { useSession } from "../../context/SessionContext";
import { Link, useRouter } from "../../lib/router";
import { CONSOLE_HOME, LOGIN_PATH } from "../../routes";
import { GalleryProvider } from "./gallery";
import { LandingLangProvider, langFromSearch, useLandingCopy, useLandingLang } from "./lang";
import { useLandingMedia } from "./media";

function CtaButton() {
  const copy = useLandingCopy();
  const { state } = useSession();
  const authenticated = state.status === "authenticated";
  return (
    <Link
      to={authenticated ? CONSOLE_HOME : LOGIN_PATH}
      className="inline-flex items-center justify-center rounded-md bg-cyan px-5 py-3 text-sm font-semibold text-navy-deep transition-colors hover:bg-white"
    >
      {authenticated ? copy.cta.goToConsole : copy.cta.signIn} →
    </Link>
  );
}

function LangSwitch() {
  const value = useLandingLang();
  if (!value) return null;
  const next = value.lang === "es" ? "en" : "es";
  return (
    <button
      type="button"
      aria-label={value.copy.lang.label}
      onClick={() => value.setLang(next)}
      className="rounded-md border border-mist px-3 py-1.5 text-xs font-semibold text-navy hover:bg-paper"
    >
      {value.copy.lang.switchTo}
    </button>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-mist bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
        <BrandMark tone="light" size="sm" />
        <LangSwitch />
      </div>
    </header>
  );
}

function Hero() {
  const copy = useLandingCopy();
  return (
    <section className="bg-navy text-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <p className="text-sm font-semibold uppercase tracking-widest text-cyan">{copy.hero.eyebrow}</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight sm:text-5xl">{copy.hero.title}</h1>
        <p className="mt-6 max-w-3xl text-base text-mist sm:text-lg">{copy.hero.lead}</p>
        <div className="mt-8">
          <CtaButton />
        </div>
        <p className="mt-6 max-w-3xl text-xs text-cyan-soft">{copy.hero.note}</p>
      </div>
    </section>
  );
}

function RealAndSimulated() {
  const copy = useLandingCopy();
  const columns = Object.entries(copy.real.columns);
  return (
    <section id="real" className="mx-auto max-w-6xl px-4 py-16 sm:px-8">
      <h2 className="text-2xl font-semibold text-navy">{copy.real.title}</h2>
      <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {columns.map(([key, column]) => (
          <div key={key} className="rounded-card border border-mist bg-white p-5 shadow-card">
            <h3 className="text-sm font-semibold text-navy">{column.title}</h3>
            <p className="mt-2 text-sm text-slate">{column.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  const copy = useLandingCopy();
  return (
    <footer className="border-t border-mist bg-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-4 py-8 text-xs text-slate sm:px-8">
        <CuadrillaWordmark tone="light" size="md" />
        <p>{copy.footer.made}</p>
        <PoweredByCraftech tone="light" />
        <nav className="flex gap-4">
          <a className="hover:text-navy hover:underline" href="/legal/privacy.html">
            {copy.footer.privacy}
          </a>
          <a className="hover:text-navy hover:underline" href="/legal/terms.html">
            {copy.footer.terms}
          </a>
        </nav>
      </div>
    </footer>
  );
}

export function LandingView() {
  const { search } = useRouter();
  const media = useLandingMedia();
  return (
    <LandingLangProvider initial={langFromSearch(search)}>
      <GalleryProvider media={media}>
        <div className="min-h-screen bg-paper">
          <Header />
          <main>
            <Hero />
            <RealAndSimulated />
          </main>
          <Footer />
        </div>
      </GalleryProvider>
    </LandingLangProvider>
  );
}
