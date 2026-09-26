// The frame the sign-in and the sign-up share (docs/landing-spec.md §7.1 and §7.9): the brand panel on
// the left from `lg` (the stage's BrandMark, the tagline, the product in three lines, "Powered by
// Craftech"), and the white card on the right with the es/en switch above it. Below `lg` the panel
// shrinks to the brand line on top. A change of background or of the panel's copy is made here once.
import type { ReactNode } from "react";
import { PoweredByCraftech } from "../../components/brand/Brand";
import { BrandMark } from "../../components/brand/BrandMark";
import { useDemoBrand } from "../../context/BrandContext";
import { AuthLangSwitch, useAuthLang, useLoginCopy } from "./auth-lang";

function BrandPanel() {
  const { lang } = useAuthLang();
  const copy = useLoginCopy();
  const brand = useDemoBrand(lang);
  return (
    <section className="relative flex flex-col justify-between gap-10 overflow-hidden bg-navy px-6 py-8 text-white sm:px-10 lg:min-h-screen lg:py-12">
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-navy-soft/60" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-cyan/10" />
      <div className="relative">
        <BrandMark brand={brand} tone="dark" size="xl" withPoweredBy={false} />
        <p className="mt-3 text-sm text-cyan-soft">{copy.panel.tagline}</p>
      </div>
      <div className="relative hidden max-w-md lg:block">
        <p className="text-4xl font-semibold leading-tight">{copy.panel.title}</p>
        <p className="mt-4 text-base text-mist">{copy.panel.lead}</p>
        <ul className="mt-6 space-y-2 text-sm text-cyan-soft">
          {copy.panel.points.map((point) => (
            <li key={point} className="flex items-center gap-2">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-cyan" />
              {point}
            </li>
          ))}
        </ul>
      </div>
      <div className="relative hidden lg:block">
        <PoweredByCraftech tone="dark" />
      </div>
    </section>
  );
}

interface AuthShellProps {
  /** The card: the step on screen. */
  readonly children: ReactNode;
  /** Lines under the card (the invitation hint, the way to the other form). */
  readonly below?: ReactNode;
}

export function AuthShell({ children, below }: AuthShellProps) {
  const copy = useLoginCopy();
  return (
    <div className="min-h-screen bg-paper lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <BrandPanel />
      <main className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-3 flex justify-end">
            <AuthLangSwitch />
          </div>
          <div className="rounded-card bg-white p-6 shadow-card sm:p-8">{children}</div>
          {below ? <div className="mt-4 space-y-2 text-center text-xs text-slate">{below}</div> : null}
          <footer className="mt-8 flex flex-col items-center gap-3 text-xs text-slate">
            <PoweredByCraftech tone="light" className="lg:hidden" />
            <nav className="flex gap-4">
              <a className="inline-flex min-h-11 items-center hover:text-navy hover:underline" href="/legal/privacy.html">
                {copy.legal.privacy}
              </a>
              <a className="inline-flex min-h-11 items-center hover:text-navy hover:underline" href="/legal/terms.html">
                {copy.legal.terms}
              </a>
            </nav>
          </footer>
        </div>
      </main>
    </div>
  );
}
