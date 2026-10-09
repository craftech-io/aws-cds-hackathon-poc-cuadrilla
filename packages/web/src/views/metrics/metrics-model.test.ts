import { describe, expect, it } from "vitest";
import { type Kpi, type MetricsTab, formatValue, kpiHint, kpiTone, orderedTabs } from "./metrics-model";

const kpi = (overrides: Partial<Kpi>): Kpi =>
  ({ id: "x", label: { es: "X", en: "X" }, value: 1, unit: "COUNT", n: 1, source: { es: "este mundo (CuadrillaMetrics)", en: "this world" }, kind: "MEASURED", ...overrides }) as Kpi;

describe("metrics model [FL-087]", () => {
  it("formats each unit: a ratio as a percentage, milliseconds as seconds, dollars and counts; nothing measured is a dash", () => {
    expect(formatValue(kpi({ unit: "RATIO", value: 0.925 }))).toBe("92,5 %");
    expect(formatValue(kpi({ unit: "RATIO", value: 1 }))).toBe("100 %");
    expect(formatValue(kpi({ unit: "MS", value: 28_400 }))).toBe("28,4 s");
    expect(formatValue(kpi({ unit: "USD", value: 0.0123 }))).toBe("US$ 0,0123");
    expect(formatValue(kpi({ unit: "COUNT", value: 0 }))).toBe("0");
    expect(formatValue(kpi({ unit: "RATIO", value: null }))).toBe("—");
  });

  it("gives every KPI its N, source, target and label, plus its note", () => {
    expect(kpiHint(kpi({ n: 50, source: { es: "medición del manual (N = 50)", en: "" }, target: "≥ 70 %" }))).toBe("N = 50 · fuente: medición del manual (N = 50) · meta: ≥ 70 % · rótulo: medido");
    expect(kpiHint(kpi({ kind: "ASSUMED", note: { es: "sin tarifa verificada", en: "" } }))).toBe("N = 1 · fuente: este mundo (CuadrillaMetrics) · rótulo: supuesto · sin tarifa verificada");
    expect(kpiHint(kpi({ kind: "SCRIPTED" }))).toContain("rótulo: agente guionado");
  });

  it("marks the figures that must be zero and the use of the global ceiling", () => {
    expect(kpiTone(kpi({ id: "violations", value: 0 }))).toBe("success");
    expect(kpiTone(kpi({ id: "violations", value: 2 }))).toBe("danger");
    expect(kpiTone(kpi({ id: "killSwitch", value: 1 }))).toBe("danger");
    expect(kpiTone(kpi({ id: "globalCap.turns", unit: "RATIO", value: 0.95 }))).toBe("danger");
    expect(kpiTone(kpi({ id: "globalCap.turns", unit: "RATIO", value: 0.75 }))).toBe("warning");
    expect(kpiTone(kpi({ id: "turns", value: 9 }))).toBe("neutral");
  });

  it("orders the tabs as the view shows them", () => {
    const tabs = ["POLICY", "WORLD", "PHOTOS", "MANUAL", "LATENCY_COST"].map((tab) => ({ tab, title: { es: tab, en: tab }, kpis: [] }) as unknown as MetricsTab);
    expect(orderedTabs(tabs).map((tab) => tab.tab)).toEqual(["WORLD", "MANUAL", "PHOTOS", "LATENCY_COST", "POLICY"]);
  });
});
