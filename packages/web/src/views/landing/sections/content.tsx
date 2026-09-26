// The problem (§1.4), what the product does for each role (§1.7) and the rules it guarantees in code
// (§1.8): cards that reveal as they enter the viewport (M1), with line icons.
import type { ReactNode } from "react";
import { useLandingCopy } from "../lang";
import { Reveal, SectionHeading } from "./parts";

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-soft text-cyan-deep">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

const PROBLEM_ICONS = [
  <path key="q" d="M12 17h.01M9.1 9a3 3 0 1 1 3.9 2.9c-.6.2-1 .8-1 1.4V14M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />,
  <path key="p" d="M4 8h3l2-2h6l2 2h3v11H4zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />,
  <path key="l" d="M6 20V10M12 20V4M18 20v-7M3 20h18" />,
];

export function Problem() {
  const copy = useLandingCopy().problem;
  return (
    <section id="problema" aria-labelledby="problema-title" className="scroll-mt-16 mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
      <SectionHeading id="problema-title" title={copy.title} lead={copy.lead} />
      <ul className="mt-10 grid gap-5 md:grid-cols-3">
        {copy.items.map((item, index) => (
          <li key={item.title} className="min-w-0">
            <Reveal delayMs={index * 100} className="h-full">
              <article className="flex h-full flex-col rounded-card border border-mist bg-white p-6 shadow-card">
                <Icon>{PROBLEM_ICONS[index]}</Icon>
                <h3 className="mt-4 text-lg font-semibold text-navy">{item.title}</h3>
                <p className="mt-3 text-sm text-slate">
                  <span className="font-semibold text-ink">{copy.before}: </span>
                  {item.before}
                </p>
                <p aria-hidden="true" className="my-2 text-cyan-deep">
                  ↓
                </p>
                <p className="text-sm text-ink">
                  <span className="font-semibold text-info">{copy.after}: </span>
                  {item.after}
                </p>
              </article>
            </Reveal>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Actors() {
  const copy = useLandingCopy().actors;
  return (
    <section id="actores" aria-labelledby="actores-title" className="scroll-mt-16 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="actores-title" title={copy.title} />
        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {copy.groups.map((group, index) => (
            <Reveal key={group.actor} delayMs={index * 90} className="min-w-0">
              <div className="h-full rounded-card border border-mist bg-paper p-5">
                <h3 className="font-display text-lg font-semibold text-navy">{group.actor}</h3>
                <ul className="mt-3 space-y-2">
                  {group.items.map((item) => (
                    <li key={item} className="flex gap-2 text-sm text-ink">
                      <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-deep" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Trust() {
  const copy = useLandingCopy().trust;
  return (
    <section id="confianza" aria-labelledby="confianza-title" className="scroll-mt-16 mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
      <SectionHeading id="confianza-title" title={copy.title} lead={copy.lead} />
      <ul className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
        {copy.items.map((item, index) => (
          <li key={item.title} className="min-w-0">
            <Reveal delayMs={(index % 3) * 90} className="h-full">
              <article className="flex h-full gap-4 rounded-card border border-mist bg-white p-5 shadow-card">
                <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-info-soft text-info">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="11" width="14" height="9" rx="2" />
                    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                  </svg>
                </span>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-navy">{item.title}</h3>
                  <p className="mt-2 text-sm text-slate">{item.text}</p>
                </div>
              </article>
            </Reveal>
          </li>
        ))}
      </ul>
    </section>
  );
}
