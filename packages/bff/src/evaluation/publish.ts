// The end of a measurement run (docs/test-plan.md §5, "Publicación de una corrida"): once every item of the
// set has its `EvalResult`, the run becomes the one the console's measurement tabs read
// (`publishEvalRun`, `CuadrillaMetrics` `EVALRUN#LATEST` · `Q|P`). A run with an item missing, or whose
// item could not be run (`ERROR:…`), is not published: the pointer stays on the previous run. Either way
// the run's rows go back to the runner, which builds the report from them.
import type { EvalResult } from "../domain/metrics";
import { type EvalRunKind, publishEvalRun } from "../metrics/eval-runs";
import type { EvalDeps } from "./ports";

export const ERROR_OUTCOME_PREFIX = "ERROR";

export function isErrorOutcome(outcome: string): boolean {
  return outcome === ERROR_OUTCOME_PREFIX || outcome.startsWith(`${ERROR_OUTCOME_PREFIX}:`);
}

/** Items of the set without a usable result in the run. */
export function missingItems(expected: readonly string[], results: readonly EvalResult[]): string[] {
  const done = new Set(results.filter((row) => !isErrorOutcome(row.outcome)).map((row) => row.itemId));
  return expected.filter((itemId) => !done.has(itemId));
}

export interface PublishOutcome {
  readonly published: boolean;
  readonly missing: readonly string[];
  /** Every result of the run of that kind: what the report is built from, the same rows the console reads. */
  readonly results: readonly EvalResult[];
}

/** The run's rows and what is missing; with `publish`, a complete run becomes the latest of its kind. */
export async function closeRun(deps: Pick<EvalDeps, "connector" | "client" | "now" | "log">, kind: EvalRunKind, run: { readonly ispId: string; readonly runId: string }, expected: readonly string[], publish: boolean): Promise<PublishOutcome> {
  const results = await deps.connector.metrics.listEvalResults(run.ispId, run.runId, kind);
  const missing = missingItems(expected, results);
  if (!publish || missing.length > 0) {
    if (publish) deps.log.warn("evaluation.not_published", { kind, runId: run.runId, missing: missing.length });
    return { published: false, missing, results };
  }
  await publishEvalRun(deps.client, kind, { ispId: run.ispId, runId: run.runId, finishedAtReal: deps.now().toISOString() });
  deps.log.info("evaluation.published", { kind, runId: run.runId, items: expected.length });
  return { published: true, missing: [], results };
}
