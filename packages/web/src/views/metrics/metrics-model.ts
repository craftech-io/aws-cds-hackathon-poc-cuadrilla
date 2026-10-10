// How the metrics view shows a KPI of `metrics.summary` (packages/bff/src/metrics/kpis.ts): the value in
// its unit (a ratio as a percentage, milliseconds as seconds, dollars, counts), and its N, source, target
// and label ("medido", "agente guionado", "supuesto") in one line. Pure: tested without a browser.
import type { StatTone } from "../../components/StatTile";
import type { RouterOutputs } from "../../lib/trpc-router";
import { metricsCopy as copy } from "./copy";

export type MetricsTab = RouterOutputs["metrics"]["summary"]["tabs"][number];
export type Kpi = MetricsTab["kpis"][number];
export type TabId = MetricsTab["tab"];

export const TAB_ORDER: readonly TabId[] = ["WORLD", "MANUAL", "PHOTOS", "LATENCY_COST", "POLICY"];

/** `12.5` → "12,5": one decimal at most, with the comma of es-MX's console. */
function decimal(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  const trimmed = digits > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
  return trimmed.replace(".", ",");
}

export function formatValue(kpi: Pick<Kpi, "value" | "unit">): string {
  if (kpi.value === null) return copy.noValue;
  switch (kpi.unit) {
    case "RATIO":
      return `${decimal(kpi.value * 100, 1)} %`;
    case "MS":
      return `${decimal(kpi.value / 1000, 1)} s`;
    case "USD":
      return `US$ ${decimal(kpi.value, 4)}`;
    case "COUNT":
      return String(Math.round(kpi.value));
  }
}

/** "N = 12 · fuente: … · meta: … · rótulo: medido", plus the KPI's note ("sin tarifa verificada"). */
export function kpiHint(kpi: Kpi): string {
  const parts = [copy.n(kpi.n), copy.source(kpi.source.es)];
  if (kpi.target !== undefined) parts.push(copy.target(kpi.target));
  parts.push(copy.label(copy.kinds[kpi.kind] ?? kpi.kind));
  if (kpi.note !== undefined) parts.push(kpi.note.es);
  return parts.join(" · ");
}

const MUST_READ_ZERO: readonly string[] = ["violations", "killSwitch", "outOfRangeAccepted", "adversarialAccepted", "conversationsOverBudget"];

/** Policy violations, an active cut and conversations over the cost threshold are the figures that must read 0; anything else is neutral. */
export function kpiTone(kpi: Kpi): StatTone {
  if (MUST_READ_ZERO.includes(kpi.id)) {
    if (kpi.value === null) return "neutral";
    return kpi.value === 0 ? "success" : "danger";
  }
  if (kpi.unit === "RATIO" && kpi.id.startsWith("globalCap.") && kpi.value !== null) return kpi.value >= 0.9 ? "danger" : kpi.value >= 0.7 ? "warning" : "neutral";
  return "neutral";
}

/** The tabs in the view's order (whatever order the BFF answers in). */
export function orderedTabs(tabs: readonly MetricsTab[]): MetricsTab[] {
  return [...tabs].sort((a, b) => TAB_ORDER.indexOf(a.tab) - TAB_ORDER.indexOf(b.tab));
}
