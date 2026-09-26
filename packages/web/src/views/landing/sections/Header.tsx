// The landing's fixed header (docs/landing-spec.md §1.2): the brand line of the stage (BrandMark, from
// `brand.get`), the es/en switch and the ways in. From 640 px: "Ingresar" and "Probar la demo" next to
// the switch. Below: the wordmark (and the partner's mark in co-branding), a one-button switch and
// "Probar la demo" only, so nothing overflows at 360 px. It tightens when the page scrolls (M9), without
// animating its layout: only the shadow fades in.
import { useEffect, useState } from "react";
import { CuadrillaWordmark } from "../../../components/brand/Brand";
import { BrandMark } from "../../../components/brand/BrandMark";
import { useDemoBrand } from "../../../context/BrandContext";
import { Link } from "../../../lib/router";
import { LOGIN_PATH } from "../../../routes";
import { useLandingLang } from "../lang";
import { SIGNUP_PATH, withLang } from "./parts";

function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setScrolled(window.scrollY > 8);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
  return scrolled;
}

export function Header() {
  const value = useLandingLang();
  const lang = value?.lang ?? "es";
  const brand = useDemoBrand(lang);
  const scrolled = useScrolled();
  if (!value) return null;
  const { copy, setLang } = value;
  const next = lang === "es" ? "en" : "es";
  return (
    <header id="top" className="sticky top-0 z-30 border-b border-mist bg-white/95 backdrop-blur">
      <span aria-hidden="true" className={`pointer-events-none absolute inset-x-0 -bottom-3 h-3 bg-linear-to-b from-navy/10 to-transparent transition-opacity duration-200 ${scrolled ? "opacity-100" : "opacity-0"}`} />
      <div className={`mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 sm:px-8 ${scrolled ? "py-2" : "py-3"}`}>
        <div className="min-w-0">
          <span className="hidden sm:inline-flex">
            <BrandMark brand={brand} tone="light" size="sm" />
          </span>
          <span className="inline-flex items-center gap-2 sm:hidden">
            <CuadrillaWordmark tone="light" size="md" />
            {brand.mode === "cobrand" ? <span className="truncate text-sm font-semibold text-navy">{brand.partnerDisplayName}</span> : null}
          </span>
        </div>
        <nav aria-label={copy.nav.label} className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            lang={next === "en" ? "en" : "es-MX"}
            title={copy.lang.label}
            onClick={() => setLang(next)}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-mist px-3 text-xs font-semibold text-navy hover:bg-paper"
          >
            <span className="sm:hidden">{copy.lang.short}</span>
            <span className="hidden sm:inline">{copy.lang.switchTo}</span>
          </button>
          <Link to={withLang(LOGIN_PATH, lang)} className="hidden min-h-11 items-center rounded-md px-3 text-sm font-semibold text-navy hover:bg-paper sm:inline-flex">
            {copy.nav.signIn}
          </Link>
          <Link to={withLang(SIGNUP_PATH, lang)} className="inline-flex min-h-11 items-center rounded-md bg-cyan px-4 text-sm font-semibold text-navy-deep hover:bg-navy hover:text-white">
            {copy.nav.tryDemo}
          </Link>
        </nav>
      </div>
    </header>
  );
}
