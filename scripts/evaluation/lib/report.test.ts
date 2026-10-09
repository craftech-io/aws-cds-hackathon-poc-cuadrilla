import { describe, expect, it } from "vitest";
import { ev01 } from "../ev-01-manual";
import { ev02 } from "../ev-02-photos";
import { buildReport, renderReport } from "./report";
import { committedPhotoLabels } from "./run";
import type { ResultRow } from "./types";

const AT = "2026-10-20T12:00:00.000Z";

function row(kind: "Q" | "P", itemId: string, outcome: string, passed: boolean, details: Record<string, unknown> = {}, latencyMs = 5_000): ResultRow {
  return { entity: "EvalResult", ispId: `isp-eval-r1-${kind.toLowerCase()}`, runId: `r1-${kind.toLowerCase()}`, kind, itemId, outcome, passed, latencyMs, inputTokens: 1000, outputTokens: 200, details: { costUsd: 0.004, costStatus: "VERIFIED", ...details }, createdAt: AT, updatedAt: AT, version: 1 } as ResultRow;
}

const id = (prefix: string, n: number): string => `${prefix}-${String(n).padStart(2, "0")}`;

function questionRows(resolved: number): ResultRow[] {
  return [
    ...Array.from({ length: 40 }, (_, index) => row("Q", id("q-A", index + 1), index < resolved ? "CITED_ANSWER(MED-01)" : "CASE", index < resolved, { turns: 1, retrieveScores: [0.5 + index / 100], retrieveCoverage: { FOUND: 1 } })),
    ...Array.from({ length: 10 }, (_, index) => row("Q", id("q-R", index + 1), "CASE", true, { turns: 1, offerTapped: index === 3 })),
  ];
}

const base = { suiteRunId: "r1", startedAt: AT, finishedAt: AT, published: true, missing: [] } as const;

describe("the manual's measurement report [FL-087]", () => {
  it("[FL-087] meets the gates with 28 of 40 resolved, 10 of 10 escalated, p95 under 30 s and no word of ADR-0023", () => {
    const report = buildReport({ ...base, def: ev01, runId: "r1-q", clockId: "eval-r1-q", results: questionRows(28), agentTexts: ["Revisa el conector (§INS-05)."] });
    expect(report.thresholds.slice(0, 5).map((threshold) => [threshold.value, threshold.met])).toEqual([
      ["28/40 (70.0 %)", true],
      ["10/10 (100.0 %)", true],
      ["p95 5.0 s · p50 5.0 s", true],
      ["0", true],
      ["0", true],
    ]);
    expect(report).toMatchObject({ n: 50, thresholdsMet: true, neutralWords: 0, cost: { totalUsd: 0.2, perItemUsd: 0.004, verified: true } });
    expect(report.retrieve).toMatchObject({ n: 40, min: 0.5, max: 0.89, coverage: { FOUND: 40 } });
  });

  it("[FL-087] 27 of 40, a word of ADR-0023 in a reply or an unpublished run fail the gate", () => {
    expect(buildReport({ ...base, def: ev01, runId: "r1-q", clockId: "eval-r1-q", results: questionRows(27) }).thresholdsMet).toBe(false);
    const worded = buildReport({ ...base, def: ev01, runId: "r1-q", clockId: "eval-r1-q", results: questionRows(40), agentTexts: ["Eso lo ve el jurado del concurso."] });
    expect(worded.neutralWords).toBe(2);
    expect(worded.thresholdsMet).toBe(false);
    expect(buildReport({ ...base, def: ev01, runId: "r1-q", clockId: "eval-r1-q", results: questionRows(40), published: false, missing: ["q-A-01"] }).thresholdsMet).toBe(false);
  });

  it("[FL-087] a slow first reply fails its gate; a provisional rate card leaves the cost unverified", () => {
    const rows = questionRows(40).map((entry, index) => ({ ...entry, latencyMs: index < 3 ? 45_000 : 5_000, details: { ...entry.details, costUsd: null, costStatus: "UNVERIFIED" } }));
    const report = buildReport({ ...base, def: ev01, runId: "r1-q", clockId: "eval-r1-q", results: rows });
    expect(report.thresholds[2]).toMatchObject({ value: "p95 45.0 s · p50 5.0 s", met: false });
    expect(report.cost).toEqual({ totalUsd: null, perItemUsd: null, verified: false });
    expect(renderReport(report)).toContain("no verified rate (provisional rate card)");
  });
});

describe("the photos' measurement report [FL-087]", () => {
  const labels = committedPhotoLabels();

  function photoRows(wrong: readonly string[]): ResultRow[] {
    return labels.map((label) => {
      const right = !wrong.includes(label.photoId);
      const verdict = right ? label.expectedVerdict : label.expectedVerdict === "PASS" ? "REJECT" : "PASS";
      return row("P", label.photoId, verdict, right, verdict === "REJECT" ? { reasonCode: label.expectedReason ?? "BLURRY", reasonCorrect: label.expectedVerdict === "REJECT", expectedReason: label.expectedReason } : {}, 6_000);
    });
  }

  it("[FL-087] meets the gates with 54 of 60 and no out-of-range or adversarial photo accepted", () => {
    const report = buildReport({ ...base, def: ev02, runId: "r1-p", clockId: "eval-r1-p", results: photoRows(["ph-meter-01", "ph-meter-02", "ph-label-01", "ph-label-02", "ph-rosette-01", "ph-rosette-02"]), labels });
    expect(report.thresholds.slice(0, 4).map((threshold) => [threshold.value, threshold.met])).toEqual([
      ["54/60 (90.0 %)", true],
      ["0", true],
      ["0", true],
      ["p95 6.0 s · p50 6.0 s", true],
    ]);
    expect(report.thresholds.find((threshold) => threshold.name === "False rejections")?.value).toBe("6");
    expect(report.thresholdsMet).toBe(true);
  });

  it("[FL-087] one adversarial or out-of-range photo accepted fails the gate", () => {
    expect(buildReport({ ...base, def: ev02, runId: "r1-p", clockId: "eval-r1-p", results: photoRows(["ph-adv-02"]), labels }).thresholds[2]).toMatchObject({ value: "1", met: false });
    const outOfRange = buildReport({ ...base, def: ev02, runId: "r1-p", clockId: "eval-r1-p", results: photoRows(["ph-meter-07"]), labels });
    expect(outOfRange.thresholds[1]).toMatchObject({ value: "1", met: false });
    expect(outOfRange.thresholdsMet).toBe(false);
  });

  it("renders a table with one line per photo, without personal data", () => {
    const markdown = renderReport(buildReport({ ...base, def: ev02, runId: "r1-p", clockId: "eval-r1-p", results: photoRows([]), labels }));
    expect(markdown).toContain("# EV-02 · Photo measurement");
    expect(markdown).toContain("| ph-adv-04 | REJECT | yes | 6.0 s | 1000/200 | 0.004 | reason DUPLICATE_EVIDENCE |");
    expect(markdown.split("\n").filter((line) => line.startsWith("| ph-"))).toHaveLength(60);
    expect(markdown).not.toMatch(/@|\+52/);
  });
});
