// Pieces every section of the landing shares: the three calls to action (with the language kept on the
// way to the signup and the login), the section heading with its PON status light (M11), the reveal of a
// block as it enters the viewport (M1) and the thin fibre strand of the motif (§2.4). Motion is transform
// and opacity only, finite, and with reduced motion everything is born in its final state.
import { type ReactNode, useRef } from "react";
import { Link } from "../../../lib/router";
import { LOGIN_PATH } from "../../../routes";
import { LANG_PARAM } from "../copy";
import { useLandingCopy, useLandingLang } from "../lang";
import { useInView, useReducedMotion } from "../motion";

export const SIGNUP_PATH = "/signup";
export const CONTACT_URL = "https://craftech.io/contact/";

/** `/signup?lang=es-MX` or `/login?lang=en`: the signup and the login open in the landing's language. */
export function withLang(path: string, lang: keyof typeof LANG_PARAM): string {
  return `${path}?lang=${LANG_PARAM[lang]}`;
}

const PRIMARY = "inline-flex min-h-11 items-center justify-center rounded-md bg-cyan px-5 py-3 text-sm font-semibold text-navy-deep transition duration-150 hover:bg-white active:scale-98 motion-reduce:transition-none";
const SECONDARY_DARK = "inline-flex min-h-11 items-center justify-center rounded-md border border-mist/60 px-5 py-3 text-sm font-semibold text-white transition duration-150 hover:bg-navy-soft active:scale-98 motion-reduce:transition-none";
const SECONDARY_LIGHT = "inline-flex min-h-11 items-center justify-center rounded-md border border-navy/30 bg-white px-5 py-3 text-sm font-semibold text-navy transition duration-150 hover:bg-paper active:scale-98 motion-reduce:transition-none";

/** "Probar la demo" (solid) → `/signup`, "Ingresar" (outline) → `/login`, "Hablemos" (text) → Craftech, new tab. */
export function CtaGroup({ tone }: { readonly tone: "dark" | "light" }) {
  const copy = useLandingCopy();
  const lang = useLandingLang()?.lang ?? "es";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Link to={withLang(SIGNUP_PATH, lang)} className={PRIMARY}>
        {copy.nav.tryDemo}
      </Link>
      <Link to={withLang(LOGIN_PATH, lang)} className={tone === "dark" ? SECONDARY_DARK : SECONDARY_LIGHT}>
        {copy.nav.signIn}
      </Link>
      <a
        href={CONTACT_URL}
        target="_blank"
        rel="noopener"
        className={`inline-flex min-h-11 items-center gap-1 px-2 text-sm font-semibold underline-offset-4 hover:underline ${tone === "dark" ? "text-cyan" : "text-cyan-deep"}`}
      >
        {copy.nav.talk}
        <span aria-hidden="true">→</span>
        <span className="sr-only">({copy.nav.newTab})</span>
      </a>
    </div>
  );
}

/** A status light of the PON kind: blinks for at most 5 s when it enters the viewport, then stays on (M11). */
export function PonDot({ tone = "light" }: { readonly tone?: "light" | "dark" }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true, threshold: 0.5 });
  const reduced = useReducedMotion();
  return (
    <span ref={ref} aria-hidden="true" className="relative inline-flex h-2.5 w-2.5">
      <span className={`absolute inset-0 rounded-full ${tone === "dark" ? "bg-navy-soft" : "bg-mist"}`} />
      <span className={`absolute inset-0 rounded-full bg-info ${seen && !reduced ? "animate-pon-blink" : ""} ${seen || reduced ? "" : "opacity-0"}`} />
    </span>
  );
}

interface SectionHeadingProps {
  readonly id: string;
  readonly title: string;
  readonly lead?: string;
  readonly tone?: "light" | "dark";
}

export function SectionHeading({ id, title, lead, tone = "light" }: SectionHeadingProps) {
  return (
    <div className="max-w-3xl">
      <h2 id={id} className={`flex items-center gap-3 font-display text-h2 font-semibold ${tone === "dark" ? "text-white" : "text-navy"}`}>
        <PonDot tone={tone} />
        {title}
      </h2>
      {lead ? <p className={`mt-3 text-lead ${tone === "dark" ? "text-mist" : "text-slate"}`}>{lead}</p> : null}
    </div>
  );
}

/** Reveals its children when 20 % of it is visible (M1): opacity and a 12 px rise, once, with a stagger. */
export function Reveal({ children, delayMs = 0, className = "" }: { readonly children: ReactNode; readonly delayMs?: number; readonly className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useInView(ref, { once: true, threshold: 0.2 });
  return (
    <div
      ref={ref}
      style={{ transitionDelay: seen ? `${delayMs}ms` : "0ms" }}
      className={`transition duration-400 ease-out motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none ${seen ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"} ${className}`}
    >
      {children}
    </div>
  );
}

/** The fibre strand: a thin vertical line from an OLT at the top to an ONU at the bottom (§2.4). */
export function FiberStrand({ className = "" }: { readonly className?: string }) {
  return (
    <span aria-hidden="true" className={`pointer-events-none absolute flex w-2 flex-col items-center ${className}`}>
      <span className="h-1.5 w-2 rounded-xs bg-navy-soft" />
      <span className="w-0.5 flex-1 bg-navy-soft" />
      <span className="h-2 w-2 rounded-full bg-navy-soft" />
    </span>
  );
}
