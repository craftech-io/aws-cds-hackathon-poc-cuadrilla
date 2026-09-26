// `CuadrillaMetrics` repository: one KPI row per conversation (order) with bounded latency samples
// for p50/p95, and one row per evaluation item. KPI deltas are read-modify-write on the version,
// retried on races (turns of one installer are serialized by the FIFO queue anyway).
import { ConversationKpi, EvalResult, KPI_SAMPLE_LIMIT, type KpiCounter } from "../../domain/metrics";
import { evalResultPrefix, metricsPartition } from "../keys";
import type { KpiDelta, MetricsPort } from "../ports-runtime";
import { createEntity, getEntity, parseRows, patchEntity, retryOnConflict, upsertEntity, type RepoContext } from "./repo";

const TABLE = "CuadrillaMetrics";

function applyDelta(kpi: Pick<ConversationKpi, KpiCounter | "firstReplyLatenciesMs" | "turnLatenciesMs" | "costUsd">, delta: KpiDelta) {
  const counters = Object.fromEntries(Object.entries(delta.counters ?? {}).map(([name, value]) => [name, kpi[name as KpiCounter] + (value ?? 0)]));
  const sample = (samples: readonly number[], value: number | undefined) => (value === undefined ? undefined : [...samples, Math.round(value)].slice(-KPI_SAMPLE_LIMIT));
  return {
    ...counters,
    firstReplyLatenciesMs: sample(kpi.firstReplyLatenciesMs, delta.firstReplyLatencyMs),
    turnLatenciesMs: sample(kpi.turnLatenciesMs, delta.turnLatencyMs),
    costUsd: delta.costUsd === undefined ? undefined : (kpi.costUsd ?? 0) + delta.costUsd,
  };
}

const emptyKpi = () => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  validations: 0,
  transcribeSec: 0,
  emails: 0,
  whatsappMessages: 0,
  firstReplyLatenciesMs: [] as number[],
  turnLatenciesMs: [] as number[],
});

export function metricsRepo(ctx: RepoContext): MetricsPort {
  return {
    getKpi: (ref) => getEntity(ctx, ConversationKpi, "ConversationKpi", ref),
    putKpi: (kpi) => upsertEntity(ctx, ConversationKpi, "ConversationKpi", kpi),
    addToKpi: (ref, delta) =>
      retryOnConflict(3, async () => {
        const current = await getEntity(ctx, ConversationKpi, "ConversationKpi", ref);
        if (current !== undefined) return patchEntity(ctx, ConversationKpi, "ConversationKpi", current, applyDelta(current, delta));
        const empty = emptyKpi();
        const changes = Object.fromEntries(Object.entries(applyDelta(empty, delta)).filter(([, value]) => value !== undefined));
        return createEntity(ctx, ConversationKpi, "ConversationKpi", { ...ref, ...empty, ...changes });
      }),
    // KPI rows of source EVAL and evaluation results share the `EVAL#` prefix: filter by entity.
    async listKpis(ispId, source) {
      const rows = await ctx.client.query(TABLE, { hashValue: metricsPartition(ispId), ...(source === undefined ? {} : { range: { prefix: `${source}#` } }) });
      return parseRows(ConversationKpi, rows.filter((row) => row.entity === "ConversationKpi"), TABLE);
    },
    putEvalResult: (result) => upsertEntity(ctx, EvalResult, "EvalResult", result),
    async listEvalResults(ispId, runId, kind) {
      const rows = await ctx.client.query(TABLE, { hashValue: metricsPartition(ispId), range: { prefix: evalResultPrefix(runId, kind) } });
      return parseRows(EvalResult, rows.filter((row) => row.entity === "EvalResult"), TABLE);
    },
  };
}
