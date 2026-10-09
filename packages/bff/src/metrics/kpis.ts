// The metrics view (docs/design-brief.md §8; FL-087): five tabs, every KPI with its N, the source it
// comes from and its label (measured with the real agent, scripted agent, or assumption), p50 and p95
// of the latencies, the day's consumption of the stage's ceiling and the state of the cut. Built from
// rows (the world's `CuadrillaMetrics` KPIs, the latest published `EvalResult` runs, the audit log) and
// never from CloudWatch (docs/architecture.md §12).
//
// The tabs are "Este mundo", "Medición del manual", "Medición de fotos", "Latencia y costo" and
// "Política" (ADR-0023: what the product measures is a "medición"; the internal run ids never show).
// Pure: routers/metrics.ts reads the rows and hands them here.
import type { ConversationKpi } from "../domain/metrics";
import { type PhotoScore, type QuestionScore, type Ratio, PHOTO_TARGETS, QUESTION_TARGETS } from "./eval-score";

export type KpiKind = "MEASURED" | "SCRIPTED" | "ASSUMED";
export type KpiUnit = "RATIO" | "MS" | "USD" | "COUNT";
export type MetricsTabId = "WORLD" | "MANUAL" | "PHOTOS" | "LATENCY_COST" | "POLICY";

export interface Bilingual {
  readonly es: string;
  readonly en: string;
}

export interface Kpi {
  readonly id: string;
  readonly label: Bilingual;
  /** `null`: nothing measured yet, or no verified rate for a cost. */
  readonly value: number | null;
  readonly unit: KpiUnit;
  readonly n: number;
  readonly source: Bilingual;
  readonly kind: KpiKind;
  readonly target?: string;
  readonly note?: Bilingual;
}

export interface MetricsTab {
  readonly tab: MetricsTabId;
  readonly title: Bilingual;
  readonly kpis: readonly Kpi[];
}

export const TAB_TITLES: Readonly<Record<MetricsTabId, Bilingual>> = {
  WORLD: { es: "Este mundo", en: "This world" },
  MANUAL: { es: "Medición del manual", en: "Manual measurement" },
  PHOTOS: { es: "Medición de fotos", en: "Photo measurement" },
  LATENCY_COST: { es: "Latencia y costo", en: "Latency and cost" },
  POLICY: { es: "Política", en: "Policy" },
};

const NO_RATE: Bilingual = { es: "sin tarifa verificada", en: "no verified rate" };
const NOT_RUN: Bilingual = { es: "todavía sin corrida publicada", en: "no published run yet" };

/** Nearest-rank percentile; `null` for no samples. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/** Measured when every conversation ran the real agent; scripted when any ran the scripted one. */
function kindOf(kpis: readonly ConversationKpi[]): KpiKind {
  return kpis.some((kpi) => kpi.agentMode === "SCRIPTED") ? "SCRIPTED" : "MEASURED";
}

const WORLD_SOURCE: Bilingual = { es: "este mundo (CuadrillaMetrics)", en: "this world (CuadrillaMetrics)" };

export interface WorldInput {
  readonly kpis: readonly ConversationKpi[];
  readonly provisionalRates: boolean;
}

function costPerConversation(input: WorldInput): Kpi {
  const priced = input.kpis.filter((kpi) => kpi.costUsd !== undefined);
  const total = priced.reduce((sum, kpi) => sum + (kpi.costUsd ?? 0), 0);
  const value = input.provisionalRates || priced.length === 0 ? null : total / priced.length;
  return {
    id: "costPerConversation",
    label: { es: "Costo por conversación", en: "Cost per conversation" },
    value,
    unit: "USD",
    n: priced.length,
    source: { es: "CuadrillaMetrics × tarifas", en: "CuadrillaMetrics × rate card" },
    kind: input.provisionalRates ? "ASSUMED" : kindOf(input.kpis),
    target: "≤ umbral del piloto",
    ...(input.provisionalRates ? { note: NO_RATE } : {}),
  };
}

function latencyKpis(kpis: readonly ConversationKpi[], prefix: string, label: Bilingual, samplesOf: (kpi: ConversationKpi) => readonly number[], target?: string): Kpi[] {
  const samples = kpis.flatMap(samplesOf);
  const kind = kindOf(kpis);
  return [50, 95].map((p) => ({
    id: `${prefix}P${p}`,
    label: { es: `${label.es} p${p}`, en: `${label.en} p${p}` },
    value: percentile(samples, p),
    unit: "MS" as const,
    n: samples.length,
    source: WORLD_SOURCE,
    kind,
    ...(p === 95 && target !== undefined ? { target } : {}),
  }));
}

export function worldTab(input: WorldInput): MetricsTab {
  const { kpis } = input;
  const sum = (field: "turns" | "validations" | "emails" | "whatsappMessages") => kpis.reduce((total, kpi) => total + kpi[field], 0);
  const count = (id: string, label: Bilingual, value: number): Kpi => ({ id, label, value, unit: "COUNT", n: kpis.length, source: WORLD_SOURCE, kind: kindOf(kpis) });
  return {
    tab: "WORLD",
    title: TAB_TITLES.WORLD,
    kpis: [
      count("conversations", { es: "Conversaciones", en: "Conversations" }, kpis.length),
      count("turns", { es: "Turnos del agente", en: "Agent turns" }, sum("turns")),
      count("validations", { es: "Fotos validadas", en: "Photos validated" }, sum("validations")),
      count("whatsappMessages", { es: "Mensajes de WhatsApp", en: "WhatsApp messages" }, sum("whatsappMessages")),
      count("emails", { es: "Emails", en: "Emails" }, sum("emails")),
      ...latencyKpis(kpis, "firstReply", { es: "Tiempo a primera respuesta", en: "Time to first reply" }, (kpi) => kpi.firstReplyLatenciesMs, "< 30 s texto, < 45 s voz"),
      costPerConversation(input),
    ],
  };
}

export interface RunInfo {
  readonly runId: string;
  readonly finishedAtReal?: string;
}

function ratioKpi(id: string, label: Bilingual, value: Ratio, source: Bilingual, target: string): Kpi {
  return { id, label, value: value.value, unit: "RATIO", n: value.denominator, source, kind: "MEASURED", target, ...(value.denominator === 0 ? { note: NOT_RUN } : {}) };
}

export function manualTab(score: QuestionScore | undefined): MetricsTab {
  const source: Bilingual = { es: `medición del manual (N = ${score?.n ?? 0})`, en: `manual measurement (N = ${score?.n ?? 0})` };
  const empty: Ratio = { value: null, numerator: 0, denominator: 0 };
  return {
    tab: "MANUAL",
    title: TAB_TITLES.MANUAL,
    kpis: [
      ratioKpi("resolvedWithCitation", { es: "Resueltas sin escalar con cita correcta", en: "Resolved without escalation, correctly cited" }, score?.resolvedWithCitation ?? empty, source, `≥ ${QUESTION_TARGETS.resolvedWithCitation * 100} %`),
      ratioKpi("escalatedWithoutInventing", { es: "Escaladas sin inventar", en: "Escalated without inventing" }, score?.escalatedWithoutInventing ?? empty, source, "100 %"),
    ],
  };
}

export function photosTab(score: PhotoScore | undefined): MetricsTab {
  const n = score?.n ?? 0;
  const source: Bilingual = { es: `medición de fotos (N = ${n})`, en: `photo measurement (N = ${n})` };
  const empty: Ratio = { value: null, numerator: 0, denominator: 0 };
  const counted = (id: string, label: Bilingual, value: number): Kpi => ({ id, label, value: score === undefined ? null : value, unit: "COUNT", n, source, kind: "MEASURED", target: "0", ...(score === undefined ? { note: NOT_RUN } : {}) });
  return {
    tab: "PHOTOS",
    title: TAB_TITLES.PHOTOS,
    kpis: [
      ratioKpi("accuracy", { es: "Exactitud de validación", en: "Validation accuracy" }, score?.accuracy ?? empty, source, `≥ ${PHOTO_TARGETS.accuracy * 100} %`),
      ratioKpi("passPrecision", { es: "Precisión de PASS", en: "PASS precision" }, score?.passPrecision ?? empty, source, "informada"),
      ratioKpi("passRecall", { es: "Cobertura de PASS", en: "PASS recall" }, score?.passRecall ?? empty, source, "informada"),
      ratioKpi("falsePositives", { es: "Falsos positivos", en: "False positives" }, score?.falsePositives ?? empty, source, "informada"),
      counted("outOfRangeAccepted", { es: "Lecturas fuera de rango aceptadas", en: "Out-of-range readings accepted" }, score?.outOfRangeAccepted ?? 0),
      counted("adversarialAccepted", { es: "Fotos adversarias aceptadas", en: "Adversarial photos accepted" }, score?.adversarialAccepted ?? 0),
    ],
  };
}

export interface CapUsage {
  readonly resource: string;
  readonly used: number;
  readonly limit: number;
  readonly resetsAtReal: string;
}

export interface LatencyCostInput extends WorldInput {
  readonly capUsage: readonly CapUsage[];
  readonly killed: { readonly agent: boolean; readonly simulator: boolean; readonly all: boolean };
}

export function latencyCostTab(input: LatencyCostInput): MetricsTab {
  const ceiling: Bilingual = { es: "techo global del día (Runtime)", en: "the day's global ceiling (Runtime)" };
  return {
    tab: "LATENCY_COST",
    title: TAB_TITLES.LATENCY_COST,
    kpis: [
      ...latencyKpis(input.kpis, "firstReply", { es: "Tiempo a primera respuesta", en: "Time to first reply" }, (kpi) => kpi.firstReplyLatenciesMs, "< 30 s texto, < 45 s voz"),
      ...latencyKpis(input.kpis, "turn", { es: "Duración del turno", en: "Turn duration" }, (kpi) => kpi.turnLatenciesMs),
      costPerConversation(input),
      ...input.capUsage.map((usage): Kpi => ({
        id: `globalCap.${usage.resource}`,
        label: { es: `Consumo del techo global (${usage.resource})`, en: `Global ceiling usage (${usage.resource})` },
        value: usage.limit === 0 ? null : usage.used / usage.limit,
        unit: "RATIO",
        n: usage.used,
        source: ceiling,
        kind: "MEASURED",
        target: `${usage.limit} por día`,
      })),
      {
        id: "killSwitch",
        label: { es: "Corte del agente activo", en: "Agent cut active" },
        value: input.killed.all || input.killed.agent ? 1 : 0,
        unit: "COUNT",
        n: 1,
        source: { es: "Runtime/KILL#", en: "Runtime/KILL#" },
        kind: "MEASURED",
        target: "0",
      },
    ],
  };
}

export interface PolicyInput {
  readonly violations: number;
  readonly rules: ReadonlyArray<{ readonly ruleId: string; readonly ALLOW: number; readonly DENY: number; readonly DEFER: number }>;
}

export function policyTab(input: PolicyInput): MetricsTab {
  const source: Bilingual = { es: "bitácora (AuditLog)", en: "audit log (AuditLog)" };
  return {
    tab: "POLICY",
    title: TAB_TITLES.POLICY,
    kpis: [
      { id: "violations", label: { es: "Violaciones de política", en: "Policy violations" }, value: input.violations, unit: "COUNT", n: input.violations, source, kind: "MEASURED", target: "0" },
      ...input.rules
        .filter((rule) => rule.DENY + rule.DEFER > 0)
        .map((rule): Kpi => ({ id: `rule.${rule.ruleId}`, label: { es: `DENY/DEFER ${rule.ruleId}`, en: `DENY/DEFER ${rule.ruleId}` }, value: rule.DENY + rule.DEFER, unit: "COUNT", n: rule.ALLOW + rule.DENY + rule.DEFER, source, kind: "MEASURED" })),
    ],
  };
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** "Exportar CSV": one line per KPI of the tabs, in Spanish (the console's language), with N, source and label. */
export function metricsCsv(tabs: readonly MetricsTab[]): string {
  const header = ["tab", "kpi", "label", "value", "unit", "n", "source", "kind", "target", "note"];
  const lines = tabs.flatMap((tab) => tab.kpis.map((kpi) => [tab.title.es, kpi.id, kpi.label.es, kpi.value, kpi.unit, kpi.n, kpi.source.es, kpi.kind, kpi.target ?? null, kpi.note?.es ?? null].map(csvCell).join(",")));
  return [header.join(","), ...lines].join("\n");
}
