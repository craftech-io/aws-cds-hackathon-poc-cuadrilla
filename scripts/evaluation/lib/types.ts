// The evaluation as the runner sees it (docs/test-plan.md §2 `SR`, §4.5 `EV-01`/`EV-02`, §5): two
// measurements with numbered steps that declare the flows they prove (what `npm run flows:check` reads in
// `scripts/evaluation/ev-*.ts`), talking to the stage only through the `QaDriver`. The scenario runner of
// WP-45 (`npm run scenarios -- --suite eval`) hands its driver client over; the tests hand a local one.
import { z } from "zod";
import type { EvalKind } from "../../../packages/bff/src/evaluation/world-request";

export type EvalActionName = "world.create" | "eval.runQuestions" | "eval.runPhotos";

/** One action of the `QaDriver`: resolves with the action's result, rejects with the driver's refusal. */
export interface EvalDriver {
  call(action: EvalActionName, input: unknown, idempotencyKey: string): Promise<unknown>;
}

export interface EvalStep {
  /** The number the flows catalog cites (`EV-01/2` is step 2). */
  readonly n: number;
  readonly title: string;
  readonly flows: readonly string[];
}

export interface EvaluationDef {
  readonly id: "EV-01" | "EV-02";
  readonly kind: EvalKind;
  readonly title: string;
  readonly steps: readonly EvalStep[];
}

export function defineEvaluation(evaluation: EvaluationDef): EvaluationDef {
  const numbers = evaluation.steps.map((step) => step.n);
  if (numbers.join(",") !== "1,2,3") throw new RangeError(`${evaluation.id}: the steps are 1 world, 2 run, 3 score and report`);
  return evaluation;
}

export interface EvalRunOptions {
  /** The suite's run id (`<github run id>-<attempt>` or `local-<ULID>`); the worlds are `eval-<id>-q|p`. */
  readonly suiteRunId: string;
  readonly driver: EvalDriver;
  /** `EV-01`: turns of the run (docs/test-plan.md §4.4: 120). */
  readonly maxTurns?: number;
  /** `EV-02`: validations of the run (80). */
  readonly maxValidations?: number;
  /** Stop before a batch once the estimated cost passed this (the threshold fixed with the CTO). */
  readonly maxCostUsd?: number;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

/** One `EvalResult` as the driver returns it (only what the report reads is checked). */
export const ResultRow = z.looseObject({
  itemId: z.string(),
  kind: z.enum(["Q", "P"]),
  outcome: z.string(),
  passed: z.boolean(),
  latencyMs: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type ResultRow = z.infer<typeof ResultRow>;

export const RunOutputShape = z.looseObject({
  runId: z.string(),
  ispId: z.string(),
  ran: z.array(z.looseObject({ result: ResultRow, agentTexts: z.array(z.string()).optional() })),
  skipped: z.array(z.string()).default([]),
  publish: z.looseObject({ published: z.boolean(), missing: z.array(z.string()), results: z.array(ResultRow) }).optional(),
});
export type RunOutputShape = z.infer<typeof RunOutputShape>;
