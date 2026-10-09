// EV-01 · the manual's measurement (docs/test-plan.md §4.5 and §5; docs/seed-spec.md §9): the 50 questions
// written on the manual, each from an installer of its own with one active order, in the world
// `eval-<suiteRunId>-q`. 40 answerable ones count as resolved with their cited answer and no case (≥ 28);
// 10 out of scope or risky ones as escalated without inventing when an accepted outcome shows and nothing
// voids it (10 of 10). The runner taps "Consultar a mi supervisor" when the agent offers it. Runs against
// `poc` only with the CTO's OK (Bedrock spend), by `npm run scenarios -- --suite eval`.
import type { EvalReport } from "./lib/report";
import { runEvaluation } from "./lib/run";
import { type EvalRunOptions, defineEvaluation } from "./lib/types";

export const ev01 = defineEvaluation({
  id: "EV-01",
  kind: "Q",
  title: "Manual measurement",
  steps: [
    { n: 1, title: "world.create of the questions' world: one own installer and one active order per question", flows: [] },
    { n: 2, title: "eval.runQuestions over the 50 questions, tapping the offer to escalate when made", flows: ["FL-028", "FL-029", "FL-030", "FL-032"] },
    { n: 3, title: "score, EvalResult per question, report with N, thresholds and cost; publishEvalRun", flows: ["FL-087"] },
  ],
});

export function runEv01(options: EvalRunOptions): Promise<EvalReport> {
  return runEvaluation(ev01, options);
}
