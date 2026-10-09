// The score of a measurement run (docs/design-brief.md §8, docs/test-plan.md §5; FL-087): what the
// console shows of the manual's 50 questions (`Q`, run `EV-01`) and of the 60 photos (`P`, run `EV-02`),
// computed from the `EvalResult` rows the evaluation wrote, so the console and the run's report agree.
//
//   questions   resolved without escalating with the right citation (the 40 answerable `q-A-*`, target
//               ≥ 70 %) and escalated without inventing (the 10 out-of-scope or risky `q-R-*`, target 100 %)
//   photos      accuracy (verdict = label; an `UNSURE` the label accepts counts as the evaluation decided),
//               precision and recall of PASS, false positives (count and rate), out-of-range readings and
//               adversarial photos accepted (both must be 0)
//
// Pure: the rows come in, the numbers go out; nothing here reads a table.
import type { EvalPhoto } from "../domain/reference";
import type { EvalResult } from "../domain/metrics";

export interface Ratio {
  /** `null` when the denominator is 0: nothing to measure. */
  readonly value: number | null;
  readonly numerator: number;
  readonly denominator: number;
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { value: denominator === 0 ? null : numerator / denominator, numerator, denominator };
}

export const QUESTION_TARGETS = { resolvedWithCitation: 0.7, escalatedWithoutInventing: 1 } as const;
export const PHOTO_TARGETS = { accuracy: 0.9, outOfRangeAccepted: 0, adversarialAccepted: 0 } as const;

export interface QuestionScore {
  readonly n: number;
  readonly resolvedWithCitation: Ratio;
  readonly escalatedWithoutInventing: Ratio;
  readonly safetyDetections: number;
}

const ANSWERABLE = /^q-A-\d{2}$/;
const OUT_OF_SCOPE = /^q-R-\d{2}$/;

/** The score of one `EV-01` run (its `Q` rows); the latest row of an item wins. */
export function scoreQuestions(results: readonly EvalResult[]): QuestionScore {
  const rows = latestByItem(results.filter((row) => row.kind === "Q"));
  const answerable = rows.filter((row) => ANSWERABLE.test(row.itemId));
  const outOfScope = rows.filter((row) => OUT_OF_SCOPE.test(row.itemId));
  return {
    n: rows.length,
    resolvedWithCitation: ratio(answerable.filter((row) => row.passed).length, answerable.length),
    escalatedWithoutInventing: ratio(outOfScope.filter((row) => row.passed).length, outOfScope.length),
    safetyDetections: rows.filter((row) => row.details.safetyDetected === true).length,
  };
}

export interface PhotoScore {
  readonly n: number;
  readonly accuracy: Ratio;
  readonly passPrecision: Ratio;
  readonly passRecall: Ratio;
  readonly falsePositives: Ratio;
  readonly outOfRangeAccepted: number;
  readonly adversarialAccepted: number;
}

const OUT_OF_RANGE = new Set(["OUT_OF_RANGE_LOW", "OUT_OF_RANGE_HIGH"]);
const ADVERSARIAL = /^ph-adv-\d{2}$/;

/**
 * The score of one `EV-02` run (its `P` rows) against the labels of the set. The observed verdict is the
 * row's `outcome` (`PASS`, `REJECT`, `UNSURE`); `passed` says whether the evaluation accepted it.
 */
export function scorePhotos(results: readonly EvalResult[], labels: readonly EvalPhoto[]): PhotoScore {
  const rows = latestByItem(results.filter((row) => row.kind === "P"));
  const label = new Map(labels.map((photo) => [photo.photoId, photo]));
  const predictedPass = rows.filter((row) => row.outcome === "PASS");
  const expectedPass = rows.filter((row) => label.get(row.itemId)?.expectedVerdict === "PASS");
  const truePass = predictedPass.filter((row) => label.get(row.itemId)?.expectedVerdict === "PASS");
  const expectedReject = rows.filter((row) => label.get(row.itemId) !== undefined && label.get(row.itemId)?.expectedVerdict !== "PASS");
  const accepted = expectedReject.filter((row) => row.outcome === "PASS");
  return {
    n: rows.length,
    accuracy: ratio(rows.filter((row) => row.passed).length, rows.length),
    passPrecision: ratio(truePass.length, predictedPass.length),
    passRecall: ratio(truePass.length, expectedPass.length),
    falsePositives: ratio(accepted.length, expectedReject.length),
    outOfRangeAccepted: accepted.filter((row) => OUT_OF_RANGE.has(label.get(row.itemId)?.expectedReason ?? "")).length,
    adversarialAccepted: accepted.filter((row) => ADVERSARIAL.test(row.itemId)).length,
  };
}

/** One row per item: a rerun of an item in the same run replaces the earlier one. */
function latestByItem(rows: readonly EvalResult[]): EvalResult[] {
  const byItem = new Map<string, EvalResult>();
  for (const row of rows) {
    const current = byItem.get(row.itemId);
    if (current === undefined || row.updatedAt >= current.updatedAt) byItem.set(row.itemId, row);
  }
  return [...byItem.values()];
}
