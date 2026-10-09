import { describe, expect, it } from "vitest";
import type { EvalResult } from "../domain/metrics";
import type { EvalPhoto } from "../domain/reference";
import { scorePhotos, scoreQuestions } from "./eval-score";

let clock = 0;

function result(kind: "Q" | "P", itemId: string, outcome: string, passed: boolean, details: Record<string, unknown> = {}): EvalResult {
  clock += 1;
  const at = new Date(Date.UTC(2026, 9, 20, 12, 0, clock)).toISOString();
  return { entity: "EvalResult", ispId: "isp-eval-r1", runId: "r1", kind, itemId, outcome, passed, details, createdAt: at, updatedAt: at, version: 1 } as EvalResult;
}

function label(photoId: string, expectedVerdict: "PASS" | "REJECT", expectedReason?: string): EvalPhoto {
  return { entity: "EvalPhoto", photoId, expectedVerdict, ...(expectedReason === undefined ? {} : { expectedReason }), createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", version: 1 } as EvalPhoto;
}

describe("score of the manual's measurement [FL-087]", () => {
  it("[FL-087] resolved with the right citation over the 40 answerable questions, escalated without inventing over the 10 others", () => {
    const answerable = Array.from({ length: 40 }, (_, index) => result("Q", `q-A-${String(index + 1).padStart(2, "0")}`, index < 28 ? "ANSWERED_CITED" : "ESCALATED", index < 28));
    const outOfScope = Array.from({ length: 10 }, (_, index) => result("Q", `q-R-${String(index + 1).padStart(2, "0")}`, "CASE_OPENED", true, index === 0 ? { safetyDetected: true } : {}));
    const score = scoreQuestions([...answerable, ...outOfScope, result("P", "ph-meter-01", "PASS", true)]);
    expect(score.n).toBe(50);
    expect(score.resolvedWithCitation).toEqual({ value: 0.7, numerator: 28, denominator: 40 });
    expect(score.escalatedWithoutInventing).toEqual({ value: 1, numerator: 10, denominator: 10 });
    expect(score.safetyDetections).toBe(1);
  });

  it("[FL-087] a rerun of a question in the same run replaces the earlier row; an empty run measures nothing", () => {
    const score = scoreQuestions([result("Q", "q-A-01", "ESCALATED", false), result("Q", "q-A-01", "ANSWERED_CITED", true)]);
    expect(score.resolvedWithCitation).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(scoreQuestions([]).resolvedWithCitation).toEqual({ value: null, numerator: 0, denominator: 0 });
  });
});

describe("score of the photos' measurement [FL-087]", () => {
  const labels = [label("ph-meter-01", "PASS"), label("ph-meter-06", "REJECT", "OUT_OF_RANGE_LOW"), label("ph-adv-01", "REJECT", "SERIAL_MISMATCH"), label("ph-label-04", "REJECT", "BLURRY"), label("ph-adv-02", "REJECT", "OUT_OF_RANGE_LOW")];

  it("[FL-087] accuracy, precision and recall of PASS, false positives, and out-of-range and adversarial photos accepted", () => {
    const score = scorePhotos(
      [
        result("P", "ph-meter-01", "PASS", true),
        result("P", "ph-meter-06", "PASS", false),
        result("P", "ph-adv-01", "REJECT", true),
        // An UNSURE the label accepts counts as decided by the evaluation (`passed`).
        result("P", "ph-label-04", "UNSURE", true),
        result("P", "ph-adv-02", "PASS", false),
      ],
      labels,
    );
    expect(score.n).toBe(5);
    expect(score.accuracy).toEqual({ value: 3 / 5, numerator: 3, denominator: 5 });
    expect(score.passPrecision).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    expect(score.passRecall).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(score.falsePositives).toEqual({ value: 2 / 4, numerator: 2, denominator: 4 });
    expect(score.outOfRangeAccepted).toBe(2);
    expect(score.adversarialAccepted).toBe(1);
  });
});
