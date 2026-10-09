// `metrics` router of the console (docs/tool-catalog.md; docs/design-brief.md §8; FL-087).
//
//   summary   the five tabs of metrics/kpis.ts for the principal's world: its conversations, the latest
//             published runs of the manual's and the photos' measurement (the same rows their report
//             reads), latencies p50/p95 and cost, the day's use of the stage's ceiling and the cut, and
//             the policy (violations next to DENY/DEFER per rule)
//   export    the same as CSV ("Exportar CSV")
import { z } from "zod";
import { type PhotoScore, type QuestionScore, scorePhotos, scoreQuestions } from "../metrics/eval-score";
import { type MetricsTab, type MetricsTabId, latencyCostTab, manualTab, metricsCsv, photosTab, policyTab, worldTab } from "../metrics/kpis";
import { globalCapUsage } from "../ops/cost-caps";
import { hasProvisionalRates } from "../services/ratecard/ratecard";
import { byRule } from "./audit";
import { type ConsolePorts, consoleCall, worldToday } from "./console-ports";
import { type IspContext, ispProcedure, router } from "./trpc";

const TabInput = z.object({ tab: z.enum(["WORLD", "MANUAL", "PHOTOS", "LATENCY_COST", "POLICY"]).optional() }).strict().optional();

type Ctx = Pick<IspContext, "deps" | "world" | "principal">;

async function questionScore(ctx: Ctx, ports: ConsolePorts): Promise<{ readonly score?: QuestionScore; readonly runId?: string }> {
  const run = await ports.evalRuns.latest("Q");
  if (run === undefined) return {};
  return { score: scoreQuestions(await ctx.deps.connector.metrics.listEvalResults(run.ispId, run.runId, "Q")), runId: run.runId };
}

async function photoScore(ctx: Ctx, ports: ConsolePorts): Promise<{ readonly score?: PhotoScore; readonly runId?: string }> {
  const run = await ports.evalRuns.latest("P");
  if (run === undefined) return {};
  const [results, labels] = await Promise.all([ctx.deps.connector.metrics.listEvalResults(run.ispId, run.runId, "P"), ctx.deps.connector.reference.listEvalPhotos()]);
  return { score: scorePhotos(results, labels), runId: run.runId };
}

export async function metricsTabs(ctx: Ctx): Promise<{ readonly tabs: MetricsTab[]; readonly runs: { readonly manual: string | null; readonly photos: string | null } }> {
  const { ports } = consoleCall(ctx);
  const data = ctx.deps.connector;
  const month = (await worldToday(ctx)).day.slice(0, 7);
  const [kpis, rates, questions, photos, capUsage, kill, decisions, violations] = await Promise.all([
    data.metrics.listKpis(ctx.world.ispId, "WORLD").then((rows) => rows.filter((row) => row.clockId === ctx.world.clockId)),
    data.reference.listRateCard(),
    questionScore(ctx, ports),
    photoScore(ctx, ports),
    globalCapUsage({ ...ports.costCaps, realClock: ports.services.realClock }),
    ports.kill.status(ctx.world.clockId),
    data.audit.listByMonth(ctx.world.ispId, month).then((rows) => rows.filter((row) => row.clockId === undefined || row.clockId === ctx.world.clockId)),
    data.audit.listByDecision(ctx.world.ispId, "VIOLATION").then((rows) => rows.filter((row) => row.clockId === undefined || row.clockId === ctx.world.clockId)),
  ]);
  const world = { kpis, provisionalRates: provisional(rates) };
  const tabs = [
    worldTab(world),
    manualTab(questions.score),
    photosTab(photos.score),
    latencyCostTab({ ...world, capUsage, killed: { agent: kill.agent || (kill.world?.agent ?? false), simulator: kill.simulator, all: kill.all } }),
    policyTab({ violations: violations.length, rules: byRule(decisions).rules }),
  ];
  // The run ids identify the report a number came from; the console shows them only as a reference.
  return { tabs, runs: { manual: questions.runId ?? null, photos: photos.runId ?? null } };
}

/** A rate card that does not read as verified is provisional: no cost is shown as measured. */
function provisional(rows: readonly unknown[]): boolean {
  try {
    return rows.length === 0 || hasProvisionalRates(rows);
  } catch {
    return true;
  }
}

function pick(tabs: readonly MetricsTab[], tab: MetricsTabId | undefined): MetricsTab[] {
  return tab === undefined ? [...tabs] : tabs.filter((candidate) => candidate.tab === tab);
}

export const metricsRouter = router({
  summary: ispProcedure.input(TabInput).query(async ({ ctx, input }) => {
    const { tabs, runs } = await metricsTabs(ctx);
    return { tabs: pick(tabs, input?.tab), runs };
  }),
  export: ispProcedure.input(TabInput).query(async ({ ctx, input }) => {
    const { tabs } = await metricsTabs(ctx);
    return { fileName: `metricas-${input?.tab?.toLowerCase() ?? "todas"}.csv`, contentType: "text/csv", csv: metricsCsv(pick(tabs, input?.tab)) };
  }),
});
