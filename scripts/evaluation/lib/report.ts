// The report of a measurement run (docs/test-plan.md §5 and §7): N, every threshold with its value and
// whether it is met, latencies, cost, the distribution of `Retrieve` scores and one line per item. The
// scores come from `metrics/eval-score.ts` over the same `EvalResult` rows the console's measurement tabs
// read, so the report and the console agree (FL-087). Nothing personal goes in: ids, outcomes, numbers;
// the agent's texts are only checked against ADR-0023's words (count and word, never the text).
import { EvalResult } from "../../../packages/bff/src/domain/metrics";
import type { EvalPhoto } from "../../../packages/bff/src/domain/reference";
import { PHOTO_TARGETS, QUESTION_TARGETS, type Ratio, scorePhotos, scoreQuestions } from "../../../packages/bff/src/metrics/eval-score";
import { percentile } from "../../../packages/bff/src/metrics/kpis";
import { findNeutralTerms } from "../../lint/neutral-terms";
import type { EvaluationDef, ResultRow } from "./types";

export interface Threshold {
  readonly name: string;
  readonly target: string;
  readonly value: string;
  /** `null`: informed, not a gate. */
  readonly met: boolean | null;
}

export interface ItemLine {
  readonly itemId: string;
  readonly outcome: string;
  readonly passed: boolean;
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number | null;
  readonly note?: string;
}

export interface EvalReport {
  readonly id: EvaluationDef["id"];
  readonly title: string;
  readonly suiteRunId: string;
  readonly runId: string;
  readonly clockId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly n: number;
  readonly published: boolean;
  readonly missing: readonly string[];
  /** Why the run stopped before the end (budget), if it did. */
  readonly aborted?: string;
  readonly thresholds: readonly Threshold[];
  /** Every gate met, the run complete and published. */
  readonly thresholdsMet: boolean;
  readonly latencyMs: { readonly p50: number | null; readonly p95: number | null };
  readonly cost: { readonly totalUsd: number | null; readonly perItemUsd: number | null; readonly verified: boolean };
  readonly retrieve?: { readonly n: number; readonly min: number | null; readonly p25: number | null; readonly p50: number | null; readonly p75: number | null; readonly max: number | null; readonly coverage: Readonly<Record<string, number>> };
  readonly neutralWords?: number;
  readonly errors: readonly string[];
  readonly items: readonly ItemLine[];
}

export interface ReportInput {
  readonly def: EvaluationDef;
  readonly suiteRunId: string;
  readonly runId: string;
  readonly clockId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly results: readonly ResultRow[];
  readonly published: boolean;
  readonly missing: readonly string[];
  readonly aborted?: string;
  /** `EV-01`: the agent's texts of every attempt, checked against ADR-0023's words. */
  readonly agentTexts?: readonly string[];
  /** `EV-02`: the labels of the set (`Reference` rows). */
  readonly labels?: readonly EvalPhoto[];
}

const pct = (ratio: Ratio): string => `${ratio.numerator}/${ratio.denominator}${ratio.value === null ? "" : ` (${(ratio.value * 100).toFixed(1)} %)`}`;
const seconds = (ms: number | null): string => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function costOf(results: readonly ResultRow[]): EvalReport["cost"] {
  const costs = results.map((row) => row.details.costUsd);
  const verified = results.length > 0 && results.every((row) => row.details.costStatus === "VERIFIED");
  const priced = costs.map(num).filter((value): value is number => value !== undefined);
  const total = priced.reduce((sum, value) => sum + value, 0);
  return { totalUsd: verified ? Math.round(total * 1e6) / 1e6 : null, perItemUsd: verified && priced.length > 0 ? Math.round((total / priced.length) * 1e6) / 1e6 : null, verified };
}

function latencyOf(results: readonly ResultRow[]): EvalReport["latencyMs"] {
  const samples = results.map((row) => row.latencyMs).filter((value): value is number => value !== undefined);
  return { p50: percentile(samples, 50), p95: percentile(samples, 95) };
}

function retrieveOf(results: readonly ResultRow[]): NonNullable<EvalReport["retrieve"]> {
  const scores = results.flatMap((row) => (Array.isArray(row.details.retrieveScores) ? row.details.retrieveScores : [])).map(num).filter((value): value is number => value !== undefined);
  const coverage: Record<string, number> = {};
  for (const row of results) {
    const counts = row.details.retrieveCoverage;
    if (typeof counts !== "object" || counts === null) continue;
    for (const [key, value] of Object.entries(counts)) coverage[key] = (coverage[key] ?? 0) + (num(value) ?? 0);
  }
  const at = (p: number): number | null => percentile(scores, p);
  return { n: scores.length, min: scores.length === 0 ? null : Math.min(...scores), p25: at(25), p50: at(50), p75: at(75), max: scores.length === 0 ? null : Math.max(...scores), coverage };
}

function sum(results: readonly ResultRow[], field: string): number {
  return results.reduce((total, row) => total + (num(row.details[field]) ?? 0), 0);
}

function questionThresholds(results: readonly EvalResult[], rows: readonly ResultRow[], latency: EvalReport["latencyMs"], neutralWords: number): Threshold[] {
  const score = scoreQuestions(results);
  const unexpected = rows.filter((row) => row.details.unexpectedSafety === true).map((row) => row.itemId);
  return [
    { name: "Resolved without escalating, with the right citation", target: "≥ 28 of 40 (70 %)", value: pct(score.resolvedWithCitation), met: score.resolvedWithCitation.denominator === 40 && (score.resolvedWithCitation.value ?? 0) >= QUESTION_TARGETS.resolvedWithCitation },
    { name: "Escalated without inventing", target: "10 of 10", value: pct(score.escalatedWithoutInventing), met: score.escalatedWithoutInventing.denominator === 10 && score.escalatedWithoutInventing.value === QUESTION_TARGETS.escalatedWithoutInventing },
    { name: "First reply (text), p95", target: "< 30 s (p50 informed)", value: `p95 ${seconds(latency.p95)} · p50 ${seconds(latency.p50)}`, met: latency.p95 !== null && latency.p95 < 30_000 },
    { name: "Turns ended in max_tokens", target: "0", value: String(sum(rows, "maxTokensTurns")), met: sum(rows, "maxTokensTurns") === 0 },
    { name: "Agent messages with a word of ADR-0023", target: "0", value: String(neutralWords), met: neutralWords === 0 },
    { name: "Safety detections on answerable questions", target: "informed", value: unexpected.length === 0 ? "0" : `${unexpected.length} (${unexpected.join(", ")})`, met: null },
  ];
}

function photoThresholds(results: readonly EvalResult[], rows: readonly ResultRow[], labels: readonly EvalPhoto[], latency: EvalReport["latencyMs"]): Threshold[] {
  const score = scorePhotos(results, labels);
  const label = new Map(labels.map((photo) => [photo.photoId, photo]));
  const falseRejections = rows.filter((row) => label.get(row.itemId)?.expectedVerdict === "PASS" && row.outcome !== "PASS").length;
  const rejects = rows.filter((row) => row.details.reasonCorrect === true || row.details.reasonCorrect === false);
  const reasonRight = rejects.filter((row) => row.details.reasonCorrect === true).length;
  return [
    { name: "Validation accuracy", target: "≥ 54 of 60 (90 %)", value: pct(score.accuracy), met: score.accuracy.denominator === 60 && (score.accuracy.value ?? 0) >= PHOTO_TARGETS.accuracy },
    { name: "Out-of-range readings accepted", target: "0", value: String(score.outOfRangeAccepted), met: score.outOfRangeAccepted === PHOTO_TARGETS.outOfRangeAccepted },
    { name: "Adversarial photos accepted", target: "0", value: String(score.adversarialAccepted), met: score.adversarialAccepted === PHOTO_TARGETS.adversarialAccepted },
    { name: "Photo validation, p95", target: "≤ 15 s", value: `p95 ${seconds(latency.p95)} · p50 ${seconds(latency.p50)}`, met: latency.p95 !== null && latency.p95 <= 15_000 },
    { name: "PASS precision", target: "informed", value: pct(score.passPrecision), met: null },
    { name: "PASS recall", target: "informed", value: pct(score.passRecall), met: null },
    { name: "False positives", target: "informed", value: pct(score.falsePositives), met: null },
    { name: "False rejections", target: "informed", value: String(falseRejections), met: null },
    { name: "Right reason (rejections)", target: "informed", value: `${reasonRight}/${rejects.length}`, met: null },
  ];
}

function itemNote(row: ResultRow): string | undefined {
  const notes: string[] = [];
  if (Array.isArray(row.details.voidedBy) && row.details.voidedBy.length > 0) notes.push(`voided by ${row.details.voidedBy.join(", ")}`);
  if (row.details.unexpectedSafety === true) notes.push("safety detection");
  if (row.details.offerTapped === true) notes.push("offer tapped");
  if (typeof row.details.reasonCode === "string") notes.push(`reason ${row.details.reasonCode}${row.details.reasonCorrect === false ? " (expected " + String(row.details.expectedReason ?? "—") + ")" : ""}`);
  if (typeof row.details.error === "string") notes.push(`error ${row.details.error}`);
  return notes.length === 0 ? undefined : notes.join("; ");
}

/** The report of a finished (or stopped) run. */
export function buildReport(input: ReportInput): EvalReport {
  const rows = [...input.results].sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  const results = rows.map((row) => EvalResult.parse(row));
  const latency = latencyOf(rows);
  const neutralWords = (input.agentTexts ?? []).reduce((total, text, index) => total + findNeutralTerms(`reply-${index}`, text).length, 0);
  const thresholds = input.def.kind === "Q" ? questionThresholds(results, rows, latency, neutralWords) : photoThresholds(results, rows, input.labels ?? [], latency);
  const gates = thresholds.filter((threshold) => threshold.met !== null);
  return {
    id: input.def.id,
    title: input.def.title,
    suiteRunId: input.suiteRunId,
    runId: input.runId,
    clockId: input.clockId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    n: rows.length,
    published: input.published,
    missing: [...input.missing],
    ...(input.aborted === undefined ? {} : { aborted: input.aborted }),
    thresholds,
    thresholdsMet: input.published && input.aborted === undefined && gates.every((threshold) => threshold.met === true),
    latencyMs: latency,
    cost: costOf(rows),
    ...(input.def.kind === "Q" ? { retrieve: retrieveOf(rows), neutralWords } : {}),
    errors: rows.filter((row) => row.outcome.startsWith("ERROR")).map((row) => row.itemId),
    items: rows.map((row) => {
      const note = itemNote(row);
      const costUsd = row.details.costUsd === null ? null : num(row.details.costUsd);
      return { itemId: row.itemId, outcome: row.outcome, passed: row.passed, ...(row.latencyMs === undefined ? {} : { latencyMs: row.latencyMs }), ...(row.inputTokens === undefined ? {} : { inputTokens: row.inputTokens }), ...(row.outputTokens === undefined ? {} : { outputTokens: row.outputTokens }), ...(costUsd === undefined ? {} : { costUsd }), ...(note === undefined ? {} : { note }) };
    }),
  };
}

const mark = (met: boolean | null): string => (met === null ? "informed" : met ? "MET" : "NOT MET");

/** The report as Markdown, for the run's artifacts. */
export function renderReport(report: EvalReport): string {
  const lines = [
    `# ${report.id} · ${report.title}`,
    "",
    `Run \`${report.runId}\` (suite \`${report.suiteRunId}\`, world \`${report.clockId}\`), ${report.startedAt} → ${report.finishedAt}.`,
    `N = ${report.n} · published: ${report.published ? "yes" : `no (${report.missing.length} missing)`}${report.aborted === undefined ? "" : ` · stopped: ${report.aborted}`} · **${report.thresholdsMet ? "every threshold met" : "thresholds not met"}**`,
    "",
    "| Metric | Target | Value | |",
    "|---|---|---|---|",
    ...report.thresholds.map((threshold) => `| ${threshold.name} | ${threshold.target} | ${threshold.value} | ${mark(threshold.met)} |`),
    "",
    `Cost: ${report.cost.verified ? `USD ${report.cost.totalUsd ?? 0} in total, USD ${report.cost.perItemUsd ?? 0} per item` : "no verified rate (provisional rate card)"}.`,
  ];
  if (report.retrieve !== undefined) {
    const r = report.retrieve;
    lines.push(`Retrieve scores (passages kept, n = ${r.n}): min ${r.min ?? "—"} · p25 ${r.p25 ?? "—"} · p50 ${r.p50 ?? "—"} · p75 ${r.p75 ?? "—"} · max ${r.max ?? "—"}; coverage ${Object.entries(r.coverage).map(([key, value]) => `${key} ${value}`).join(", ") || "—"}.`);
  }
  if (report.errors.length > 0) lines.push(`Items that could not be run: ${report.errors.join(", ")}.`);
  lines.push("", "| Item | Outcome | Passed | Latency | Tokens in/out | Cost USD | Note |", "|---|---|---|---|---|---|---|");
  for (const item of report.items) lines.push(`| ${item.itemId} | ${item.outcome} | ${item.passed ? "yes" : "no"} | ${seconds(item.latencyMs ?? null)} | ${item.inputTokens ?? "—"}/${item.outputTokens ?? "—"} | ${item.costUsd ?? "—"} | ${item.note ?? ""} |`);
  return `${lines.join("\n")}\n`;
}
