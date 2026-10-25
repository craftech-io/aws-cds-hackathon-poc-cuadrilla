// The run's report and the "100 % probada" gate over three runs (docs/test-plan.md §1 item 3, §4.4): the
// agent rate counts only agent units that ran and by the flow that decides each; a det unit passes 3 of 3,
// an agent one 2 of 3, each part on its own; SKIPPED_LIVE_P01 is accepted only in SC-17.
import { describe, expect, it } from "vitest";
import { aggregate, unitMeetsGate } from "./aggregate";
import { type RunReport, type ScenarioResult, type UnitResult, type Verdict, buildReport, renderMarkdown, worst } from "./report";

const unit = (id: string, kind: "det" | "agent", verdict: Verdict, flows: string[] = ["FL-010"], oracleFlow?: string): UnitResult => ({
  id,
  title: id,
  kind,
  flows,
  ...(oracleFlow === undefined ? {} : { oracleFlow }),
  verdict,
  durationMs: 1000,
  informed: {},
  latencies: {},
  blocks: [],
  warnings: [],
});

const scenario = (id: string, units: UnitResult[], violations: number | null = 0, cost: number | null = 0.25): ScenarioResult => ({
  scenario: id,
  title: id,
  verdict: worst(units.map((entry) => entry.verdict)),
  durationMs: 1000,
  units,
  audits: [{ clockId: `qa-1-1-${id.toLowerCase()}`, violations }],
  usage: [{ clockId: `qa-1-1-${id.toLowerCase()}`, turns: 4, inputTokens: 100, outputTokens: 10, validations: 1, transcribeSec: 3, estimatedCostUsd: cost, firstReplyMs: [1000, 3000], turnMs: [2000] }],
  cleanupErrors: [],
});

const run = (runId: string, scenarios: ScenarioResult[]): RunReport => buildReport({ runId, suite: "full", startedAt: 0, finishedAt: 60_000, scenarios, budget: { maxTurns: 400 } });

describe("buildReport", () => {
  it("rates the agent units that ran, by the flow that decides each, and adds usage and cost", () => {
    const report = run("1-1", [
      scenario("SC-04", [unit("9.a", "agent", "PASS", ["FL-040", "FL-103"], "FL-040"), unit("9.b", "det", "PASS", ["FL-040"]), unit("10", "agent", "FAIL", ["FL-041"]), unit("11", "agent", "SKIPPED", ["FL-041"])]),
      scenario("SC-17", [unit("3", "agent", "SKIPPED_LIVE_P01", ["FL-091"])]),
    ]);
    expect(report.agentRate.passed).toBe(1);
    expect(report.agentRate.total).toBe(2);
    expect(report.agentRate.byFlow).toEqual({ "FL-040": { passed: 1, total: 1 }, "FL-041": { passed: 0, total: 1 } });
    expect(report.flows["FL-041"]).toBe("FAIL");
    expect(report.flows["FL-091"]).toBe("SKIPPED_LIVE_P01");
    expect(report.usage).toMatchObject({ turns: 8, validations: 2, estimatedCostUsd: 0.5 });
    expect(report.latencies.n).toBe(4);
    expect(report.verdict).toBe("FAIL");
  });

  it("leaves the cost unknown when one world's rates are unverified, and renders a table", () => {
    const report = run("1-1", [scenario("SC-01", [unit("1", "det", "PASS")], 0, null)]);
    expect(report.usage.estimatedCostUsd).toBeNull();
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("unverified rates");
    expect(markdown).toContain("| SC-01 | 1 | det | FL-010 | PASS |");
  });
});

describe("the gate over three runs", () => {
  it("asks det 3/3 and agent ≥ 2/3, each unit on its own", () => {
    expect(unitMeetsGate("det", ["PASS", "PASS", "WARN"], "SC-04").ok).toBe(true);
    expect(unitMeetsGate("det", ["PASS", "PASS", "FAIL"], "SC-04").ok).toBe(false);
    expect(unitMeetsGate("agent", ["PASS", "FAIL", "PASS"], "SC-04").ok).toBe(true);
    expect(unitMeetsGate("agent", ["PASS", "FAIL", "FAIL"], "SC-04").ok).toBe(false);
    expect(unitMeetsGate("agent", ["PASS", "PASS"], "SC-04").ok).toBe(false);
  });

  it("accepts SKIPPED_LIVE_P01 only in SC-17", () => {
    expect(unitMeetsGate("agent", ["SKIPPED_LIVE_P01", "SKIPPED_LIVE_P01", "SKIPPED_LIVE_P01"], "SC-17")).toMatchObject({ ok: true, note: "SKIPPED_LIVE_P01" });
    expect(unitMeetsGate("det", ["SKIPPED_LIVE_P01", "SKIPPED_LIVE_P01", "SKIPPED_LIVE_P01"], "SC-12").ok).toBe(false);
  });

  it("passes a det part even when the agent part of the same step misses once, and fails on a violation", () => {
    const runs = ["1-1", "2-1", "3-1"].map((runId, index) => run(runId, [scenario("SC-04", [unit("9.a", "agent", index === 1 ? "FAIL" : "PASS"), unit("9.b", "det", "PASS")])]));
    const gate = aggregate(runs);
    expect(gate.ok).toBe(true);
    expect(gate.units.map((entry) => `${entry.key}:${entry.passes}/${entry.runs}`)).toEqual(["SC-04/9.a:2/3", "SC-04/9.b:3/3"]);
    const dirty = aggregate([...runs.slice(0, 2), run("3-1", [scenario("SC-04", [unit("9.a", "agent", "PASS"), unit("9.b", "det", "PASS")], 1)])]);
    expect(dirty.ok).toBe(false);
    expect(dirty.problems).toContain("policy audit: 1 violation(s)");
  });

  it("refuses fewer than three runs and a world that was not audited", () => {
    const gate = aggregate([run("1-1", [scenario("SC-01", [unit("1", "det", "PASS")], null)])]);
    expect(gate.ok).toBe(false);
    expect(gate.problems).toEqual(expect.arrayContaining(["1 run(s): the gate asks 3 in a row", "policy audit: 1 world(s) not audited"]));
  });
});
