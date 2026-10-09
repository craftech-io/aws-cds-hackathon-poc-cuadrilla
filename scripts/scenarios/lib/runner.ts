// Runs a suite of scenarios against `poc` (docs/test-plan.md §4.4):
//
//   - up to 4 scenarios at a time, each in its own operator; the scenarios of one lane one after the other
//     (`SC-19` then `SC-18` share `guest-test`); then the `alone` ones; then the `last` one (`SC-16`);
//   - inside a scenario: its setup (worlds and presets), then the units in order. A failed unit takes down
//     only the units whose `after` chain reaches it (a `det` never depends on an `agent`, so an agent's miss
//     never skips a `det`); the rest still run;
//   - `finally`, whatever happened: the scenario's own cleanup, then per world its policy audit (0
//     violations, or the scenario fails), its usage (`metrics.get`) and `world.destroy`;
//   - the budget (`--max-turns`, `--max-cost-usd`) is checked before each scenario: past it the rest are
//     skipped and the report says why.
import { QA_REASON } from "../../../packages/bff/src/qa-driver/contract";
import { AssertionFailed, Blocked, DriverRefusal, type ScenarioContext, ScenarioBug, type UnitRecord, emptyRecord, unitContext } from "./context";
import type { DriverClient } from "./driver-client";
import { WaitTimeout } from "./eventually";
import { type RunReport, type ScenarioResult, type UnitResult, type Verdict, type WorldAudit, type WorldUsage, buildReport, worst } from "./report";
import { type ScenarioDef, type Suite, type Unit, dependentsOf, unitsOf } from "./steps";
import { worldsOf } from "./world";

export interface RunOptions {
  readonly runId: string;
  readonly suite: Suite | "custom";
  readonly scenarios: readonly ScenarioDef[];
  readonly driver: DriverClient;
  readonly maxTurns: number;
  readonly maxCostUsd?: number;
  readonly parallel?: number;
  readonly now?: () => number;
  readonly waitOptions?: { readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> };
  readonly log?: (line: string) => void;
}

export const CLEANUP_UNIT = "999";
export const SETUP_UNIT = "setup";

function verdictOf(error: unknown): Verdict {
  return error instanceof Blocked || (error instanceof DriverRefusal && error.reason === QA_REASON.NOT_WIRED) ? "BLOCKED" : "FAIL";
}

export function describeError(error: unknown): string {
  if (error instanceof AssertionFailed || error instanceof WaitTimeout || error instanceof DriverRefusal || error instanceof Blocked) return error.message;
  if (error instanceof ScenarioBug) return `scenario bug: ${error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function unitResult(unit: Unit, verdict: Verdict, durationMs: number, record: UnitRecord, error?: string): UnitResult {
  return {
    id: unit.id,
    title: unit.title,
    kind: unit.kind,
    flows: unit.flows,
    ...(unit.oracleFlow === undefined ? {} : { oracleFlow: unit.oracleFlow }),
    ...(unit.expect === undefined ? {} : { expect: unit.expect }),
    verdict,
    durationMs,
    informed: record.informed,
    latencies: record.latencies,
    blocks: record.blocks,
    warnings: record.warnings,
    ...(error === undefined ? {} : { error }),
  };
}

const UsageShape = (value: unknown): WorldUsage | undefined => {
  const metrics = value as { clockId?: string; usage?: Record<string, number>; latencies?: { firstReplyMs?: number[]; turnMs?: number[] }; estimatedCostUsd?: number | null } | undefined;
  if (metrics?.usage === undefined || metrics.clockId === undefined) return undefined;
  return {
    clockId: metrics.clockId,
    turns: metrics.usage.turns ?? 0,
    inputTokens: metrics.usage.inputTokens ?? 0,
    outputTokens: metrics.usage.outputTokens ?? 0,
    validations: metrics.usage.validations ?? 0,
    transcribeSec: metrics.usage.transcribeSec ?? 0,
    estimatedCostUsd: metrics.estimatedCostUsd ?? null,
    firstReplyMs: metrics.latencies?.firstReplyMs ?? [],
    turnMs: metrics.latencies?.turnMs ?? [],
  };
};

/** Cleanup of every world of the scenario: audit, usage, destroy (each step on its own; errors collected). */
async function cleanupWorlds(ctx: ScenarioContext): Promise<{ audits: WorldAudit[]; usage: WorldUsage[]; errors: string[] }> {
  const audits: WorldAudit[] = [];
  const usage: WorldUsage[] = [];
  const errors: string[] = [];
  for (const clockId of worldsOf(ctx.state)) {
    // The test guest's world is audited and read like any other; it is destroyed by SC-19/SC-18 themselves.
    try {
      const audit = (await ctx.qa("policyAudit.run", { clockId })) as { violations?: number };
      audits.push({ clockId, violations: audit.violations ?? null });
    } catch (error) {
      audits.push({ clockId, violations: null, error: describeError(error) });
    }
    try {
      const metrics = UsageShape(await ctx.qa("metrics.get", { clockId }));
      if (metrics !== undefined) usage.push(metrics);
    } catch (error) {
      errors.push(`metrics.get ${clockId}: ${describeError(error)}`);
    }
    try {
      await ctx.qa("world.destroy", { clockId });
    } catch (error) {
      errors.push(`world.destroy ${clockId}: ${describeError(error)}`);
    }
  }
  return { audits, usage, errors };
}

export async function runScenario(options: RunOptions, scenario: ScenarioDef, previous: ScenarioContext["previous"] = []): Promise<ScenarioResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const state: Record<string, unknown> = {};
  const base = { runId: options.runId, scenario, driver: options.driver, state, previous, ...(options.waitOptions === undefined ? {} : { waitOptions: options.waitOptions }) };
  const units = unitsOf(scenario);
  const results: UnitResult[] = [];
  const setupRecord = emptyRecord();
  const setupCtx = unitContext(base, SETUP_UNIT, setupRecord);
  let blocked: { verdict: Verdict; error: string } | undefined;
  try {
    const pending = scenario.pending === undefined ? undefined : await scenario.pending(setupCtx);
    if (pending !== undefined) blocked = { verdict: "SKIPPED_PENDING_P01", error: pending };
    else await scenario.setup?.(setupCtx);
  } catch (error) {
    blocked = { verdict: verdictOf(error) === "BLOCKED" ? "BLOCKED" : "FAIL", error: `setup: ${describeError(error)}` };
  }
  const down = new Set<string>();
  for (const unit of units) {
    const record = emptyRecord();
    if (blocked !== undefined) {
      results.push(unitResult(unit, blocked.verdict === "FAIL" ? "SKIPPED" : blocked.verdict, 0, record, blocked.error));
      continue;
    }
    if (down.has(unit.id)) {
      results.push(unitResult(unit, "SKIPPED", 0, record, `depends on a failed unit (after '${unit.after}')`));
      continue;
    }
    const unitStarted = now();
    try {
      await unit.run(unitContext(base, unit.id, record));
      results.push(unitResult(unit, record.warnings.length > 0 ? "WARN" : "PASS", now() - unitStarted, record));
    } catch (error) {
      results.push(unitResult(unit, verdictOf(error), now() - unitStarted, record, describeError(error)));
      for (const id of dependentsOf(units, unit.id)) down.add(id);
    }
    options.log?.(`${scenario.id}/${unit.id} ${results.at(-1)?.verdict ?? ""}${results.at(-1)?.error ? ` · ${results.at(-1)?.error}` : ""}`);
  }
  const cleanupCtx = unitContext(base, CLEANUP_UNIT, emptyRecord());
  const errors: string[] = [];
  try {
    await scenario.cleanup?.(cleanupCtx);
  } catch (error) {
    errors.push(`cleanup: ${describeError(error)}`);
  }
  const cleanup = await cleanupWorlds(cleanupCtx);
  errors.push(...cleanup.errors);
  const auditVerdict: Verdict = cleanup.audits.every((audit) => audit.violations === 0) ? "PASS" : "FAIL";
  const setupVerdict: Verdict = blocked === undefined ? "PASS" : blocked.verdict;
  const verdict = worst([setupVerdict, ...results.map((result) => result.verdict), auditVerdict, ...(errors.length > 0 ? (["WARN"] as const) : [])]);
  return { scenario: scenario.id, title: scenario.title, verdict, durationMs: now() - started, units: results, audits: cleanup.audits, usage: cleanup.usage, cleanupErrors: errors };
}

function skipped(scenario: ScenarioDef, reason: string): ScenarioResult {
  return { scenario: scenario.id, title: scenario.title, verdict: "SKIPPED", durationMs: 0, units: unitsOf(scenario).map((unit) => unitResult(unit, "SKIPPED", 0, emptyRecord(), reason)), audits: [], usage: [], cleanupErrors: [] };
}

/** Lanes of the parallel part, then the ones that run alone, then the last. */
export function lanesOf(scenarios: readonly ScenarioDef[]): { readonly lanes: ScenarioDef[][]; readonly alone: ScenarioDef[]; readonly last: ScenarioDef[] } {
  const lanes = new Map<string, ScenarioDef[]>();
  const alone: ScenarioDef[] = [];
  const last: ScenarioDef[] = [];
  for (const scenario of scenarios) {
    if (scenario.last === true) last.push(scenario);
    else if (scenario.alone === true) alone.push(scenario);
    else lanes.set(scenario.lane ?? scenario.id, [...(lanes.get(scenario.lane ?? scenario.id) ?? []), scenario]);
  }
  return { lanes: [...lanes.values()], alone, last };
}

export async function runSuite(options: RunOptions): Promise<RunReport> {
  const now = options.now ?? Date.now;
  const started = now();
  const spent = { turns: 0, costUsd: 0 as number | null };
  let aborted: string | undefined;
  const results = new Map<string, ScenarioResult>();
  async function runOne(scenario: ScenarioDef): Promise<void> {
    const overCost = options.maxCostUsd !== undefined && (spent.costUsd === null || spent.costUsd >= options.maxCostUsd);
    if (spent.turns >= options.maxTurns || overCost) {
      aborted ??= overCost ? `cost budget of USD ${options.maxCostUsd} reached or not estimable (unverified rates)` : `turn budget of ${options.maxTurns} reached`;
      results.set(scenario.id, skipped(scenario, aborted));
      return;
    }
    const previous = [...results.values()].map((result) => ({ scenario: result.scenario, violations: result.audits.reduce((sum, audit) => sum + (audit.violations ?? 0), 0), unaudited: result.audits.filter((audit) => audit.violations === null).length }));
    const result = await runScenario(options, scenario, previous);
    spent.turns += result.usage.reduce((total, world) => total + world.turns, 0);
    const costs = result.usage.map((world) => world.estimatedCostUsd);
    spent.costUsd = spent.costUsd === null || costs.some((cost) => cost === null) ? null : spent.costUsd + costs.reduce<number>((total, cost) => total + (cost ?? 0), 0);
    results.set(scenario.id, result);
  }
  const { lanes, alone, last } = lanesOf(options.scenarios);
  const queue = [...lanes];
  const workers = Array.from({ length: Math.max(1, Math.min(options.parallel ?? 4, queue.length)) }, async () => {
    for (let lane = queue.shift(); lane !== undefined; lane = queue.shift()) for (const scenario of lane) await runOne(scenario);
  });
  await Promise.all(workers);
  for (const scenario of [...alone, ...last]) await runOne(scenario);
  const scenarios = options.scenarios.map((scenario) => results.get(scenario.id)).filter((result): result is ScenarioResult => result !== undefined);
  return buildReport({ runId: options.runId, suite: options.suite, startedAt: started, finishedAt: now(), scenarios, budget: { maxTurns: options.maxTurns, ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }), ...(aborted === undefined ? {} : { aborted }) } });
}
