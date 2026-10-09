// EV-02 · the photos' measurement (docs/test-plan.md §4.5 and §5; docs/seed-spec.md §10): the 60 labelled
// synthetic photos, each validated by `tool.invoke(validate_install_photo)` on an order of its own with the
// class and serial its label asks for and the label's orchestrator reading, in the world
// `eval-<suiteRunId>-p`; `ph-adv-04` runs against the PASS evidence of `ph-meter-01` seeded on another
// order, so the adversarial gate never depends on the order of the run nor on the model. Accuracy ≥ 54 of
// 60, no out-of-range reading and no adversarial photo accepted. Runs against `poc` only with the CTO's OK.
import type { EvalReport } from "./lib/report";
import { runEvaluation } from "./lib/run";
import { type EvalRunOptions, defineEvaluation } from "./lib/types";

export const ev02 = defineEvaluation({
  id: "EV-02",
  kind: "P",
  title: "Photo measurement",
  steps: [
    { n: 1, title: "world.create of the photos' world: one order per photo, its candidate and the seeded PASS evidence", flows: [] },
    { n: 2, title: "eval.runPhotos over the 60 photos through tool.invoke(validate_install_photo)", flows: ["FL-036", "FL-037", "FL-038", "FL-039", "FL-040", "FL-041", "FL-043", "FL-097"] },
    { n: 3, title: "accuracy, precision and recall of PASS, false positives; report and publishEvalRun", flows: ["FL-087"] },
  ],
});

export function runEv02(options: EvalRunOptions): Promise<EvalReport> {
  return runEvaluation(ev02, options);
}
