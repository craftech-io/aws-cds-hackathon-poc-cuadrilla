import { describe, expect, it } from "vitest";
import type { ConversationKpi } from "../domain/metrics";
import { consoleTestWorld } from "../routers/console-testing";
import { DEMO } from "../services/people/testing";
import { createLogger } from "../lib/log";
import { MODEL_RATES, bedrockRateKey } from "../services/ratecard/ratecard";
import { recordTurnKpi } from "../turns/record";
import { publishEvalRun } from "./eval-runs";
import { scorePhotos, scoreQuestions } from "./eval-score";
import { TAB_TITLES, latencyCostTab, manualTab, metricsCsv, percentile, photosTab, policyTab, worldTab } from "./kpis";

function kpi(workOrderId: string, overrides: Partial<ConversationKpi> = {}): ConversationKpi {
  return {
    entity: "ConversationKpi",
    ispId: "isp-demo",
    clockId: "GLOBAL#isp-demo",
    workOrderId,
    source: "WORLD",
    agentMode: "REAL",
    turns: 4,
    firstReplyLatenciesMs: [],
    turnLatenciesMs: [],
    inputTokens: 0,
    outputTokens: 0,
    validations: 3,
    transcribeSec: 0,
    emails: 2,
    whatsappMessages: 9,
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
    version: 1,
    ...overrides,
  } as ConversationKpi;
}

describe("metrics with labels [FL-087]", () => {
  it("[FL-087] nearest-rank p50 and p95", () => {
    const samples = Array.from({ length: 20 }, (_, index) => (index + 1) * 1_000);
    expect(percentile(samples, 50)).toBe(10_000);
    expect(percentile(samples, 95)).toBe(19_000);
    expect(percentile([], 95)).toBeNull();
  });

  it("[FL-087] every KPI of this world carries N, its source and its label; a scripted conversation labels the world scripted", () => {
    const measured = worldTab({ kpis: [kpi("wo-1", { firstReplyLatenciesMs: [8_000, 12_000] }), kpi("wo-2", { firstReplyLatenciesMs: [20_000] })], provisionalRates: false });
    const latency = measured.kpis.find((item) => item.id === "firstReplyP95");
    expect(latency).toMatchObject({ value: 20_000, n: 3, unit: "MS", kind: "MEASURED", target: "< 30 s texto, < 45 s voz" });
    for (const item of measured.kpis) expect(item.source.es.length).toBeGreaterThan(0);
    expect(worldTab({ kpis: [kpi("wo-1", { agentMode: "SCRIPTED" })], provisionalRates: false }).kpis[0]?.kind).toBe("SCRIPTED");
  });

  it("[FL-087] the cost per conversation says \"sin tarifa verificada\" while the rate card is provisional", () => {
    const priced = [kpi("wo-1", { costUsd: 0.4 }), kpi("wo-2", { costUsd: 0.2 })];
    const provisional = worldTab({ kpis: priced, provisionalRates: true }).kpis.find((item) => item.id === "costPerConversation");
    expect(provisional).toMatchObject({ value: null, kind: "ASSUMED", note: { es: "sin tarifa verificada" } });
    const verified = worldTab({ kpis: priced, provisionalRates: false }).kpis.find((item) => item.id === "costPerConversation");
    expect(verified?.value).toBeCloseTo(0.3);
    expect(verified).toMatchObject({ kind: "MEASURED", n: 2, note: { es: "tokens del agente; fotos, voz y mensajes sin sumar" } });
  });

  it("[W6R1 B1] with verified rates and conversations that carry no cost, the cost stays an assumption with a note, never a measured blank", () => {
    const tabs = [worldTab({ kpis: [kpi("wo-1"), kpi("wo-2")], provisionalRates: false }), latencyCostTab({ kpis: [kpi("wo-1")], provisionalRates: false, capUsage: [], killed: { agent: false, simulator: false, all: false } })];
    for (const tab of tabs) {
      expect(tab.kpis.find((item) => item.id === "costPerConversation")).toMatchObject({ value: null, n: 0, kind: "ASSUMED", note: { es: "sin costo registrado" } });
      expect(tab.kpis.find((item) => item.id === "conversationsOverBudget")).toMatchObject({ value: null, kind: "ASSUMED", note: { es: "sin costo registrado" } });
    }
  });

  it("[W6R1 B1] the operator's threshold flags the priced conversations over it, and says so while it is not set", () => {
    const priced = [kpi("wo-1", { costUsd: 3.4 }), kpi("wo-2", { costUsd: 1.2 }), kpi("wo-3")];
    const over = (budgetUsd?: number) => worldTab({ kpis: priced, provisionalRates: false, ...(budgetUsd === undefined ? {} : { budgetUsd }) }).kpis;
    expect(over(2.9).find((item) => item.id === "conversationsOverBudget")).toMatchObject({ value: 1, n: 2, kind: "MEASURED", target: "0" });
    expect(over(2.9).find((item) => item.id === "costPerConversation")).toMatchObject({ target: "≤ USD 2.90", n: 2 });
    expect(over(5).find((item) => item.id === "conversationsOverBudget")?.value).toBe(0);
    expect(over().find((item) => item.id === "conversationsOverBudget")).toMatchObject({ value: null, note: { es: "sin umbral fijado" } });
    expect(over().find((item) => item.id === "costPerConversation")?.target).toBe("≤ umbral del piloto");
  });

  it("[FL-087] the tabs are called measurements: no internal run id and no word of ADR-0023 in what the console shows", () => {
    const tabs = [worldTab({ kpis: [], provisionalRates: true }), manualTab(undefined), photosTab(undefined), latencyCostTab({ kpis: [], provisionalRates: true, capUsage: [], killed: { agent: false, simulator: false, all: false } }), policyTab({ violations: 0, rules: [] })];
    expect(TAB_TITLES.MANUAL).toEqual({ es: "Medición del manual", en: "Manual measurement" });
    expect(TAB_TITLES.PHOTOS).toEqual({ es: "Medición de fotos", en: "Photo measurement" });
    const shown = JSON.stringify(tabs);
    expect(shown).not.toMatch(/EV-0[12]|evaluaci|evaluador|jurado|judge/i);
    expect(manualTab(undefined).kpis[0]).toMatchObject({ value: null, n: 0, note: { es: "todavía sin corrida publicada" } });
  });

  it("[FL-087] the CSV export has one line per KPI with N, source and label", () => {
    const csv = metricsCsv([policyTab({ violations: 0, rules: [{ ruleId: "CP-OPT-IN", ALLOW: 1, DENY: 2, DEFER: 0 }] })]);
    expect(csv.split("\n")).toEqual(["tab,kpi,label,value,unit,n,source,kind,target,note", "Política,violations,Violaciones de política,0,COUNT,0,bitácora (AuditLog),MEASURED,0,", "Política,rule.CP-OPT-IN,DENY/DEFER CP-OPT-IN,2,COUNT,3,bitácora (AuditLog),MEASURED,,"]);
  });

  it("[FL-087] metrics.summary shows the latest published runs exactly as their report scores them, with the ceiling and the cut", async () => {
    const t = await consoleTestWorld(DEMO);
    const { metrics, reference } = t.memory.connector;
    await reference.put("EvalPhoto", { photoId: "ph-meter-01", expectedVerdict: "PASS" });
    await reference.put("EvalPhoto", { photoId: "ph-meter-06", expectedVerdict: "REJECT", expectedReason: "OUT_OF_RANGE_LOW" });
    const rows = [
      { kind: "Q" as const, itemId: "q-A-01", outcome: "ANSWERED_CITED", passed: true },
      { kind: "Q" as const, itemId: "q-A-02", outcome: "ESCALATED", passed: false },
      { kind: "Q" as const, itemId: "q-R-01", outcome: "CASE_OPENED", passed: true },
      { kind: "P" as const, itemId: "ph-meter-01", outcome: "PASS", passed: true },
      { kind: "P" as const, itemId: "ph-meter-06", outcome: "REJECT", passed: true },
    ];
    for (const row of rows) await metrics.putEvalResult({ ispId: "isp-eval-r7", runId: "r7", ...row });
    for (const kind of ["Q", "P"] as const) await publishEvalRun(t.memory.client, kind, { ispId: "isp-eval-r7", runId: "r7", finishedAtReal: "2026-11-02T17:00:00.000Z" });
    await metrics.putKpi({ ispId: "isp-demo", clockId: t.world.clockId, workOrderId: t.world.ids.order, source: "WORLD", agentMode: "REAL", firstReplyLatenciesMs: [9_000], costUsd: 0.31 });
    const summary = await (await t.as("OPS", "usr-ops")).metrics.summary();
    const report = { questions: scoreQuestions(await metrics.listEvalResults("isp-eval-r7", "r7", "Q")), photos: scorePhotos(await metrics.listEvalResults("isp-eval-r7", "r7", "P"), await reference.listEvalPhotos()) };
    const value = (tab: string, id: string) => summary.tabs.find((candidate) => candidate.tab === tab)?.kpis.find((item) => item.id === id);
    expect(value("MANUAL", "resolvedWithCitation")).toMatchObject({ value: report.questions.resolvedWithCitation.value, n: 2 });
    expect(value("PHOTOS", "accuracy")).toMatchObject({ value: report.photos.accuracy.value, n: 2 });
    expect(value("PHOTOS", "passPrecision")?.value).toBe(1);
    // No rate card loaded: no cost is shown as measured.
    expect(value("WORLD", "costPerConversation")).toMatchObject({ value: null, note: { es: "sin tarifa verificada" } });
    expect(value("LATENCY_COST", "killSwitch")).toMatchObject({ value: 0 });
    expect(value("LATENCY_COST", "globalCap.turns")).toMatchObject({ n: 0, target: "1000 por día" });
    expect(summary.runs).toEqual({ manual: "r7", photos: "r7" });
    // [W4 review B6] the pointer the evaluation publishes and the rows it names never expire.
    const stored = t.memory.client.dump("CuadrillaMetrics").filter((row) => row.PK === "EVALRUN#LATEST" || row.entity === "EvalResult");
    expect(stored.length).toBe(rows.length + 2);
    expect(stored.every((row) => row.expiresAt === undefined)).toBe(true);
    const csv = await (await t.as()).metrics.export({ tab: "PHOTOS" });
    expect(csv).toMatchObject({ contentType: "text/csv", fileName: "metricas-photos.csv" });
    expect(csv.csv.split("\n")[1]).toContain("Medición de fotos,accuracy");
  });

  it("[W6R1 B1] a real turn of this world prices the conversation on metrics.summary, against the world's threshold", async () => {
    const t = await consoleTestWorld(DEMO);
    const { reference, isps } = t.memory.connector;
    for (const kind of ["input", "output"] as const) await reference.put("RateCard", { key: bedrockRateKey(kind), price: MODEL_RATES.prices[kind], unit: "PER_1M_TOKENS", provisional: false, source: MODEL_RATES.source, asOf: MODEL_RATES.asOf });
    await isps.updateSettings(t.world.ispId, { costBudgetUsdPerConversation: 1.5 });
    const deps = { data: t.memory.connector, agentMode: "REAL" as const, log: createLogger({ level: "error", sink: () => undefined }) };
    const turn = { trigger: "INSTALLER_MESSAGE" as const, eventId: "evt-1", clockId: t.world.clockId, ispId: t.world.ispId, installerId: t.world.ids.rogelio, workOrderId: t.world.ids.order, eventAtSim: "2026-10-13T09:15:00-06:00" };
    // 0.2 M input and 0.05 M output tokens: USD 0.9 a turn, USD 1.8 for the conversation.
    for (const latencyMs of [1_200, 1_400]) await recordTurnKpi(deps, turn, { inputTokens: 200_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, latencyMs);
    const summary = await (await t.as("OPS", "usr-ops")).metrics.summary({ tab: "WORLD" });
    const value = (id: string) => summary.tabs[0]?.kpis.find((item) => item.id === id);
    expect(value("costPerConversation")).toMatchObject({ value: 1.8, n: 1, kind: "MEASURED", target: "≤ USD 1.50" });
    expect(value("conversationsOverBudget")).toMatchObject({ value: 1, n: 1, kind: "MEASURED" });
  });
});
