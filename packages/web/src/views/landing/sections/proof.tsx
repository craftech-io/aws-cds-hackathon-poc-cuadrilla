// Impact (§1.9), how it fits in (§1.10) and what is real and what is simulated (§1.11). Every figure of
// the impact carries its label ("meta"/"supuesto") at the size of the figure and its source under it;
// the two "at least" goals count up once (M6), the two "under" caps are drawn at their value. The note
// on what rolls out in stages follows the registry of console views, like the guest's home page.
import { useRef } from "react";
import { useDemoBrand } from "../../../context/BrandContext";
import { useLandingCopy, useLandingLang } from "../lang";
import { useCountUp, useInView, useReducedMotion } from "../motion";
import { Reveal, SectionHeading } from "./parts";

type ImpactItem = ReturnType<typeof useLandingCopy>["impact"]["items"][number];

function Figure({ item, run, goal }: { readonly item: ImpactItem; readonly run: boolean; readonly goal: string }) {
  const reduced = useReducedMotion();
  const counted = useCountUp(item.value, run && item.kind === "up", reduced);
  const value = item.kind === "up" ? counted : item.value;
  return (
    <div className="flex h-full flex-col rounded-card border border-navy-soft bg-navy-deep/40 p-5">
      <p className="font-display text-3xl font-semibold">
        <span className="tabular-nums text-white">
          {item.prefix}
          {value}
          {item.suffix}
        </span>{" "}
        <span className="text-cyan">{goal}</span>
      </p>
      <p className="mt-3 text-sm text-white">{item.text}</p>
      <p className="mt-auto pt-3 text-xs text-mist">{item.source}</p>
    </div>
  );
}

export function Impact() {
  const copy = useLandingCopy().impact;
  const grid = useRef<HTMLDivElement>(null);
  const seen = useInView(grid, { once: true, threshold: 0.3 });
  return (
    <section id="impacto" aria-labelledby="impacto-title" className="scroll-mt-16 bg-navy text-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="impacto-title" title={copy.title} lead={copy.lead} tone="dark" />
        <div ref={grid} className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {copy.items.map((item) => (
            <Figure key={item.source} item={item} run={seen} goal={copy.goal} />
          ))}
        </div>
        <p className="mt-6 rounded-card border border-navy-soft p-5 font-display text-xl font-semibold text-white sm:text-2xl">
          <span className="text-cyan">{copy.assumption}</span> · {copy.pilot}
        </p>
      </div>
    </section>
  );
}

function Node({ children, accent = false }: { readonly children: string; readonly accent?: boolean }) {
  return <span className={`block rounded-card border px-3 py-2 text-center text-sm font-semibold ${accent ? "border-cyan-deep bg-cyan-soft text-navy" : "border-mist bg-white text-navy"}`}>{children}</span>;
}

function Arrow({ vertical = false }: { readonly vertical?: boolean }) {
  return (
    <span aria-hidden="true" className="flex items-center justify-center py-1 text-lg text-cyan-deep lg:px-2 lg:py-0">
      {vertical ? (
        "↕"
      ) : (
        <>
          <span className="lg:hidden">↓</span>
          <span className="hidden lg:inline">→</span>
        </>
      )}
    </span>
  );
}

export function Integration() {
  const copy = useLandingCopy().integration;
  const diagram = copy.diagram;
  return (
    <section id="integracion" aria-labelledby="integracion-title" className="scroll-mt-16 mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
      <SectionHeading id="integracion-title" title={copy.title} />
      <Reveal className="mt-10">
        <figure aria-label={copy.diagramLabel} className="rounded-card border border-mist bg-paper p-5">
          <div className="flex flex-col lg:flex-row lg:items-center">
            <div className="lg:flex-1">
              <Node>{diagram.installer}</Node>
            </div>
            <Arrow />
            <div className="lg:flex-1">
              <Node accent>{diagram.agent}</Node>
            </div>
            <Arrow />
            <div className="lg:flex-1">
              <Node>{diagram.manual}</Node>
            </div>
          </div>
          <Arrow vertical />
          <div className="mx-auto max-w-md">
            <Node>{diagram.connectors}</Node>
            <p className="mt-1 text-center text-xs text-slate">{diagram.connectorsNote}</p>
          </div>
          <Arrow vertical />
          <div className="mx-auto max-w-xl">
            <Node>{diagram.people}</Node>
          </div>
        </figure>
      </Reveal>
      <dl className="mt-8 grid gap-4 md:grid-cols-2">
        {copy.rows.map((row) => (
          <div key={row.block} className="min-w-0 rounded-card border border-mist bg-white p-5">
            <dt className="text-sm font-semibold text-navy">{row.block}</dt>
            <dd className="mt-1 text-sm text-slate">{row.text}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-6 rounded-card border-l-4 border-info bg-info-soft p-5 text-sm text-ink">{copy.needs}</p>
    </section>
  );
}

/** Whether the console the guest gets is complete: the views of the walkthrough exist in this build. */
export function consoleComplete(viewNames: readonly string[]): boolean {
  return ["simulator", "clock", "orders", "cases", "outbox"].every((view) => viewNames.includes(view));
}

export function RealAndSimulated({ viewNames }: { readonly viewNames: readonly string[] }) {
  const copy = useLandingCopy().real;
  const lang = useLandingLang()?.lang ?? "es";
  const brand = useDemoBrand(lang);
  return (
    <section id="real" aria-labelledby="real-title" className="scroll-mt-16 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-8 lg:py-24">
        <SectionHeading id="real-title" title={copy.title} />
        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {copy.columns.map((column, index) => (
            <Reveal key={column.title} delayMs={index * 90} className="min-w-0">
              <div className="h-full rounded-card border border-mist bg-paper p-5">
                <h3 className="text-sm font-semibold text-navy">{column.title}</h3>
                <p className="mt-2 text-sm text-slate">{column.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <ul className="mt-6 space-y-2 text-sm text-ink">
          <li>{copy.email}</li>
          <li>{copy.yourTrial}</li>
          <li>{copy.renders}</li>
          {consoleComplete(viewNames) ? null : <li className="font-semibold text-navy">{copy.staged}</li>}
        </ul>
        {brand.mode === "cobrand" ? (
          <p role="note" className="mt-6 rounded-card border border-warning bg-warning-soft p-4 text-sm text-ink">
            {brand.disclaimer}
          </p>
        ) : null}
      </div>
    </section>
  );
}
