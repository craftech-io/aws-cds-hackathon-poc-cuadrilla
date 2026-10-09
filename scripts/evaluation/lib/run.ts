// Runs one measurement through the `QaDriver` (docs/test-plan.md §4.4, §4.5 and §5):
//
//   1  world.create      the `eval-<suiteRunId>-q|p` world built from the committed `eval` template
//   2  eval.run…         the items of the set in batches (questions: 4 per call, all at once; photos: 12
//                        per call, one after the other), inside the run's budget (turns or validations, and
//                        the estimated cost when a ceiling is given): a batch that would pass it is not
//                        sent and the run stops unpublished; items that failed (`ERROR:…`) get one retry
//   3  score and report  a last call publishes the run if every item has its result and returns the
//                        run's rows; the report is built from them (report.ts)
//
// Every call carries `<suiteRunId>/<EV-nn>/<step>/<label>`, so a retried call replays instead of acting
// twice. Inputs and results are never printed: they name the world's synthetic identities.
import { readFileSync } from "node:fs";
import { EvalPhoto } from "../../../packages/bff/src/domain/reference";
import { MAX_PHOTOS_PER_CALL, MAX_QUESTIONS_PER_CALL } from "../../../packages/bff/src/evaluation/ports";
import { evalClockId, evalWorldRequest } from "../../../packages/bff/src/evaluation/world-request";
import { EvalTemplate } from "../../../packages/bff/src/worlds/templates";
import { type EvalReport, buildReport } from "./report";
import { type EvalRunOptions, type EvaluationDef, type ResultRow, RunOutputShape } from "./types";

const SEED_DATA = new URL("../../seed/data/", import.meta.url);

/** The committed `eval` template: the same bytes `Seed/worlds/eval.json` holds. */
export function committedEvalTemplate(): EvalTemplate {
  return EvalTemplate.parse(JSON.parse(readFileSync(new URL("worlds/eval.json", SEED_DATA), "utf8")));
}

/** The labels of the photos as the `Reference` rows of the seed carry them (what the console scores with). */
export function committedPhotoLabels(): EvalPhoto[] {
  const reference = JSON.parse(readFileSync(new URL("Reference.json", SEED_DATA), "utf8")) as { items: Array<Record<string, unknown>> };
  return reference.items.filter((row) => row.entity === "EvalPhoto").map((row) => EvalPhoto.parse(row));
}

export const DEFAULT_BUDGET = { maxTurns: 120, maxValidations: 80 } as const;
/** Turns one question may take: its own and the tap of an offer. */
const TURNS_PER_QUESTION = 2;

function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

interface Spent {
  turns: number;
  validations: number;
  costUsd: number;
}

function spend(spent: Spent, rows: readonly ResultRow[]): void {
  for (const row of rows) {
    spent.turns += typeof row.details.turns === "number" ? row.details.turns : 0;
    spent.validations += row.kind === "P" && !row.outcome.startsWith("ERROR") ? 1 : 0;
    spent.costUsd += typeof row.details.costUsd === "number" ? row.details.costUsd : 0;
  }
}

/** Why the next batch would pass the budget, if it would. */
function overBudget(def: EvaluationDef, options: EvalRunOptions, spent: Spent, batch: number): string | undefined {
  if (def.kind === "Q") {
    const limit = options.maxTurns ?? DEFAULT_BUDGET.maxTurns;
    if (spent.turns + batch * TURNS_PER_QUESTION > limit) return `turn budget: ${spent.turns} used, ${limit} allowed`;
  } else {
    const limit = options.maxValidations ?? DEFAULT_BUDGET.maxValidations;
    if (spent.validations + batch > limit) return `validation budget: ${spent.validations} used, ${limit} allowed`;
  }
  if (options.maxCostUsd !== undefined && spent.costUsd >= options.maxCostUsd) return `cost ceiling: USD ${spent.costUsd.toFixed(4)} of ${options.maxCostUsd}`;
  return undefined;
}

export async function runEvaluation(def: EvaluationDef, options: EvalRunOptions): Promise<EvalReport> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const startedAt = now().toISOString();
  const template = committedEvalTemplate();
  const clockId = evalClockId(options.suiteRunId, def.kind);
  const key = (step: number, label: string): string => `${options.suiteRunId}/${def.id}/${step}/${label}`;
  const action = def.kind === "Q" ? "eval.runQuestions" : "eval.runPhotos";
  const field = def.kind === "Q" ? "questionIds" : "photoIds";
  const items = (def.kind === "Q" ? template.questions.map((question) => question.questionId) : template.photos.map((photo) => photo.photoId)).sort();
  const size = def.kind === "Q" ? MAX_QUESTIONS_PER_CALL : MAX_PHOTOS_PER_CALL;

  await options.driver.call("world.create", evalWorldRequest(template, options.suiteRunId, def.kind), key(1, "m1"));
  log(`${def.id}/1 world ${clockId} ready`);

  const spent: Spent = { turns: 0, validations: 0, costUsd: 0 };
  const agentTexts: string[] = [];
  let aborted: string | undefined;
  let calls = 0;
  const runBatches = async (ids: readonly string[], pass: string): Promise<string[]> => {
    const failed: string[] = [];
    for (const batch of chunks(ids, size)) {
      aborted = overBudget(def, options, spent, batch.length);
      if (aborted !== undefined) return failed;
      calls += 1;
      const out = RunOutputShape.parse(await options.driver.call(action, { clockId, [field]: batch }, key(2, `${pass}${calls}`)));
      const rows = out.ran.map((entry) => entry.result);
      spend(spent, rows);
      for (const entry of out.ran) agentTexts.push(...(entry.agentTexts ?? []));
      failed.push(...rows.filter((row) => row.outcome.startsWith("ERROR")).map((row) => row.itemId));
      log(`${def.id}/2 ${batch.length} item(s), ${rows.filter((row) => row.passed).length} passed, ${failed.length} failed so far`);
    }
    return failed;
  };
  const failed = await runBatches(items, "m");
  if (aborted === undefined && failed.length > 0) await runBatches(failed, "r");

  // Step 3: publish only a run that went through; the rows come back either way for the report.
  const final = RunOutputShape.parse(await options.driver.call(action, { clockId, [field]: [], publish: aborted === undefined, collect: true }, key(3, "m1")));
  const publish = final.publish ?? { published: false, missing: items, results: [] };
  const report = buildReport({
    def,
    suiteRunId: options.suiteRunId,
    runId: final.runId,
    clockId,
    startedAt,
    finishedAt: now().toISOString(),
    results: publish.results,
    published: publish.published,
    missing: publish.missing,
    ...(aborted === undefined ? {} : { aborted }),
    ...(def.kind === "Q" ? { agentTexts } : { labels: committedPhotoLabels() }),
  });
  log(`${def.id}/3 ${report.thresholdsMet ? "thresholds met" : "thresholds not met"} · published ${report.published}`);
  return report;
}
