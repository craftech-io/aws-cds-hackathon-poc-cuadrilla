// `scenario-report.json` and `.md` of one run (docs/test-plan.md §4.4): every unit (step or part) with its
// kind, flows, verdict, duration, latencies and what it informed; per scenario the policy audit of each
// world and its usage; per flow the worst verdict; the rate of the `agent` units (overall and by flow); and
// the estimated cost of the run priced with the rate card. Written as artifacts of the run, never
// committed; no address, token or text of a message goes in (only verdicts, ids of the world and counts).
import { percentile } from "../../../packages/bff/src/metrics/kpis";
import type { BlockOrigin } from "./context";
import type { StepKind } from "./steps";

export type Verdict = "PASS" | "WARN" | "FAIL" | "BLOCKED" | "SKIPPED" | "SKIPPED_PENDING_P01";

export interface UnitResult {
  readonly id: string;
  readonly title: string;
  readonly kind: StepKind;
  readonly flows: readonly string[];
  readonly oracleFlow?: string;
  readonly expect?: string;
  readonly verdict: Verdict;
  readonly durationMs: number;
  readonly informed: Readonly<Record<string, string>>;
  readonly latencies: Readonly<Record<string, number>>;
  readonly blocks: ReadonlyArray<{ readonly origin: BlockOrigin; readonly detail: string }>;
  readonly warnings: readonly string[];
  readonly error?: string;
}

export interface WorldAudit {
  readonly clockId: string;
  /** `null` when the audit could not run (the scenario then fails: §1 asks 0 violations of every world). */
  readonly violations: number | null;
  readonly error?: string;
}

export interface WorldUsage {
  readonly clockId: string;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly validations: number;
  readonly transcribeSec: number;
  readonly estimatedCostUsd: number | null;
  readonly firstReplyMs: readonly number[];
  readonly turnMs: readonly number[];
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly title: string;
  readonly verdict: Verdict;
  readonly durationMs: number;
  readonly units: readonly UnitResult[];
  readonly audits: readonly WorldAudit[];
  readonly usage: readonly WorldUsage[];
  readonly cleanupErrors: readonly string[];
}

export interface Rate {
  readonly passed: number;
  readonly total: number;
}

export interface RunReport {
  readonly runId: string;
  readonly suite: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly verdict: Verdict;
  readonly scenarios: readonly ScenarioResult[];
  /** Worst verdict per flow over the units that declare it. */
  readonly flows: Readonly<Record<string, Verdict>>;
  readonly agentRate: Rate & { readonly byFlow: Readonly<Record<string, Rate>> };
  readonly usage: { readonly turns: number; readonly inputTokens: number; readonly outputTokens: number; readonly validations: number; readonly transcribeSec: number; readonly estimatedCostUsd: number | null };
  readonly latencies: { readonly firstReplyP50: number | null; readonly firstReplyP95: number | null; readonly turnP95: number | null; readonly n: number };
  readonly budget: { readonly maxTurns: number; readonly maxCostUsd?: number; readonly aborted?: string };
}

const SEVERITY: Readonly<Record<Verdict, number>> = { PASS: 0, SKIPPED_PENDING_P01: 1, SKIPPED: 2, WARN: 3, BLOCKED: 4, FAIL: 5 };

export function worst(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce<Verdict>((current, next) => (SEVERITY[next] > SEVERITY[current] ? next : current), "PASS");
}

/** A unit counts as passed for the gates when its verdict is PASS or WARN. */
export function passed(verdict: Verdict): boolean {
  return verdict === "PASS" || verdict === "WARN";
}

export function flowVerdicts(scenarios: readonly ScenarioResult[]): Record<string, Verdict> {
  const flows: Record<string, Verdict> = {};
  for (const unit of scenarios.flatMap((scenario) => scenario.units)) for (const flow of unit.flows) flows[flow] = worst([flows[flow] ?? "PASS", unit.verdict]);
  return Object.fromEntries(Object.entries(flows).sort(([a], [b]) => a.localeCompare(b)));
}

/** The rate of the `agent` units that ran (skipped ones do not count), overall and by the flow that decides each. */
export function agentRate(scenarios: readonly ScenarioResult[]): RunReport["agentRate"] {
  const byFlow: Record<string, { passed: number; total: number }> = {};
  let ok = 0;
  let total = 0;
  for (const unit of scenarios.flatMap((scenario) => scenario.units)) {
    if (unit.kind !== "agent" || unit.verdict === "SKIPPED" || unit.verdict === "SKIPPED_PENDING_P01") continue;
    total += 1;
    if (passed(unit.verdict)) ok += 1;
    for (const flow of unit.oracleFlow === undefined ? unit.flows : [unit.oracleFlow]) {
      const entry = (byFlow[flow] ??= { passed: 0, total: 0 });
      entry.total += 1;
      if (passed(unit.verdict)) entry.passed += 1;
    }
  }
  return { passed: ok, total, byFlow };
}

export function usageOf(scenarios: readonly ScenarioResult[]): RunReport["usage"] & { readonly firstReplyMs: number[]; readonly turnMs: number[] } {
  const all = scenarios.flatMap((scenario) => scenario.usage);
  const sum = (field: "turns" | "inputTokens" | "outputTokens" | "validations" | "transcribeSec") => all.reduce((total, world) => total + world[field], 0);
  const costs = all.map((world) => world.estimatedCostUsd);
  return {
    turns: sum("turns"),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    validations: sum("validations"),
    transcribeSec: sum("transcribeSec"),
    estimatedCostUsd: costs.some((cost) => cost === null) ? null : Math.round(costs.reduce<number>((total, cost) => total + (cost ?? 0), 0) * 10_000) / 10_000,
    firstReplyMs: all.flatMap((world) => [...world.firstReplyMs]),
    turnMs: all.flatMap((world) => [...world.turnMs]),
  };
}

export function buildReport(input: { readonly runId: string; readonly suite: string; readonly startedAt: number; readonly finishedAt: number; readonly scenarios: readonly ScenarioResult[]; readonly budget: RunReport["budget"] }): RunReport {
  const { firstReplyMs, turnMs, ...usage } = usageOf(input.scenarios);
  return {
    runId: input.runId,
    suite: input.suite,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    durationMs: input.finishedAt - input.startedAt,
    verdict: worst(input.scenarios.map((scenario) => scenario.verdict)),
    scenarios: input.scenarios,
    flows: flowVerdicts(input.scenarios),
    agentRate: agentRate(input.scenarios),
    usage,
    latencies: { firstReplyP50: percentile(firstReplyMs, 50), firstReplyP95: percentile(firstReplyMs, 95), turnP95: percentile(turnMs, 95), n: firstReplyMs.length },
    budget: input.budget,
  };
}

const pct = (rate: Rate): string => (rate.total === 0 ? "—" : `${rate.passed}/${rate.total}`);

export function renderMarkdown(report: RunReport): string {
  const lines = [
    `# Scenario run ${report.runId} (${report.suite})`,
    "",
    `Verdict **${report.verdict}** · ${Math.round(report.durationMs / 1000)} s · agent units ${pct(report.agentRate)} · turns ${report.usage.turns} · estimated cost ${report.usage.estimatedCostUsd === null ? "unverified rates" : `USD ${report.usage.estimatedCostUsd.toFixed(4)}`}`,
    `First reply p50/p95 ${report.latencies.firstReplyP50 ?? "—"}/${report.latencies.firstReplyP95 ?? "—"} ms (N ${report.latencies.n}) · turn p95 ${report.latencies.turnP95 ?? "—"} ms`,
    ...(report.budget.aborted === undefined ? [] : [`Budget: ${report.budget.aborted}`]),
    "",
    "| Scenario | Unit | Kind | Flows | Verdict | s | Notes |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const scenario of report.scenarios) {
    for (const unit of scenario.units) {
      const notes = [unit.error, ...unit.warnings, ...Object.entries(unit.informed).map(([key, value]) => `${key}=${value}`), ...unit.blocks.map((block) => `block ${block.origin}`)].filter((note) => note !== undefined && note !== "");
      lines.push(`| ${scenario.scenario} | ${unit.id} | ${unit.kind} | ${unit.flows.join(", ")} | ${unit.verdict} | ${Math.round(unit.durationMs / 1000)} | ${notes.join("; ").replace(/\|/g, "/").slice(0, 300)} |`);
    }
    for (const audit of scenario.audits) lines.push(`| ${scenario.scenario} | audit | det | — | ${audit.violations === 0 ? "PASS" : "FAIL"} | — | ${audit.violations ?? audit.error ?? "not run"} violation(s) |`);
    for (const error of scenario.cleanupErrors) lines.push(`| ${scenario.scenario} | cleanup | — | — | WARN | — | ${error.replace(/\|/g, "/").slice(0, 300)} |`);
  }
  lines.push("", "| Flow | Verdict | Agent rate |", "|---|---|---|");
  for (const [flow, verdict] of Object.entries(report.flows)) lines.push(`| ${flow} | ${verdict} | ${report.agentRate.byFlow[flow] === undefined ? "—" : pct(report.agentRate.byFlow[flow])} |`);
  return `${lines.join("\n")}\n`;
}
