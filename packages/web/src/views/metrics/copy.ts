// Texts of the metrics view (`/app/metrics`, docs/design-brief.md §8; FL-087). Spanish of Mexico. What the
// product measures is a "medición" (ADR-0023): the tab titles and the KPI labels come from the BFF
// (metrics/kpis.ts), which writes them that way, and the internal run ids never show.

export const metricsCopy = {
  tabs: "Pestañas de métricas",
  kinds: {
    MEASURED: "medido",
    SCRIPTED: "agente guionado",
    ASSUMED: "supuesto",
  } as Readonly<Record<string, string>>,
  n: (count: number) => `N = ${count}`,
  source: (source: string) => `fuente: ${source}`,
  target: (target: string) => `meta: ${target}`,
  label: (kind: string) => `rótulo: ${kind}`,
  noValue: "—",
  export: "Exportar CSV",
  exporting: "Preparando el CSV…",
  exported: (file: string) => `Listo: ${file}.`,
  legend: "Cada cifra lleva su N, el mundo o la corrida de la que sale y su rótulo: medido con el agente real, con el agente guionado, o un supuesto.",
  empty: "Esta pestaña todavía no tiene cifras.",
  ceilingTitle: "Techo global del día y corte",
  cutOn: "Corte del agente activo: los turnos nuevos esperan hasta que se apague.",
  cutOff: "Sin corte activo.",
} as const;
