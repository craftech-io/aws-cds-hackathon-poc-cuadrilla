// `npm run scenarios -- --suite smoke|full|eval|load [--only SC-04,SC-05 | EV-01] [--run-id …] [--max-turns 400]
// [--max-validations 80] [--max-cost-usd …] [--parallel 4] [--base-url …] [--bff-url …] [--report-dir …] [--live-operator]`
// (docs/test-plan.md §4.4): runs the suite against `poc` through the `QaDriver` only (the credentials of the
// environment: `qa-runner` by OIDC in CI) and writes `scenario-report.json` and `.md`, the run's artifacts
// (never committed). Every suite but `smoke` spends Bedrock: it runs only with the CTO's OK.
//
//   --dry-run          validates every scenario and prints the plan (lanes, units); no AWS call
//   --aggregate <dir>  the "100 % probada" gate over the `scenario-report*.json` of that folder; no AWS call
//
// The exit code is 0 only when the run (or the gate) passed.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { EVAL_SUITE, runEvalSuite } from "../evaluation/lib/suite";
import { DEFAULT_BASE_URL } from "../smoke/interim";
import type { EvalActionName, EvalDriver } from "../evaluation/lib/types";
import { aggregate } from "./lib/aggregate";
import { type CliOptions, parseCli } from "./lib/cli";
import { DriverRefusal } from "./lib/context";
import { type DriverClient, createDriverClient } from "./lib/driver-client";
import { setEdgeConfig } from "./lib/edge";
import { type RunReport, passed, renderMarkdown } from "./lib/report";
import { lanesOf, runSuite } from "./lib/runner";
import { type ScenarioDef, unitsOf, validateScenario } from "./lib/steps";
import { SCENARIOS, scenariosOf } from "./lib/suites";
import loadLight from "./load-light";
import { setLiveOperator } from "./sc-17-whatsapp-live";

const log = (line: string) => process.stdout.write(`${line}\n`);

function chosen(options: CliOptions): ScenarioDef[] {
  if (options.suite === "load") return [loadLight];
  if (options.suite === "eval") return [];
  const scenarios = scenariosOf(options.suite, options.only);
  if (options.only !== undefined) {
    const unknown = options.only.filter((id) => !SCENARIOS.some((scenario) => scenario.id === id));
    if (unknown.length > 0) throw new RangeError(`unknown scenario(s): ${unknown.join(", ")}`);
  }
  return scenarios;
}

function dryRun(scenarios: readonly ScenarioDef[]): number {
  const problems = [...SCENARIOS, loadLight].flatMap(validateScenario);
  for (const problem of problems) log(`invalid: ${problem}`);
  const { lanes, alone, last } = lanesOf(scenarios);
  for (const lane of lanes) log(`lane: ${lane.map((scenario) => `${scenario.id} (${unitsOf(scenario).length} units)`).join(" → ")}`);
  for (const scenario of alone) log(`alone: ${scenario.id}`);
  for (const scenario of last) log(`last: ${scenario.id}`);
  return problems.length === 0 ? 0 : 1;
}

function gate(dir: string): number {
  const reports = readdirSync(dir)
    .filter((name) => /^scenario-report.*\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as RunReport);
  const result = aggregate(reports);
  log(`gate over ${result.runs.length} run(s) (${result.runs.join(", ")}): ${result.ok ? "PASS" : "FAIL"}`);
  for (const problem of result.problems) log(`  ${problem}`);
  return result.ok ? 0 : 1;
}

/** The evaluation's port over the same client: the result, or the driver's refusal as an error. */
export function evalDriverOf(client: DriverClient): EvalDriver {
  return {
    async call(action: EvalActionName, input: unknown, idempotencyKey: string) {
      const answer = await client.call(action, input, idempotencyKey);
      if (answer.ok) return answer.result;
      throw new DriverRefusal(action, answer.error.code, answer.error.reason, answer.error.message);
    },
  };
}

const EVAL_IDS = EVAL_SUITE.map((entry) => entry.def.id);

async function runEval(options: CliOptions, driver: DriverClient): Promise<number> {
  const only = options.only === undefined ? undefined : EVAL_IDS.filter((id) => options.only?.includes(id));
  const unknown = (options.only ?? []).filter((id) => !(EVAL_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) throw new RangeError(`unknown measurement(s): ${unknown.join(", ")}`);
  const reports = await runEvalSuite({
    suiteRunId: options.runId,
    driver: evalDriverOf(driver),
    maxTurns: options.maxTurns,
    ...(options.maxValidations === undefined ? {} : { maxValidations: options.maxValidations }),
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    ...(only === undefined ? {} : { only }),
    reportDir: options.reportDir,
    log,
  });
  for (const report of reports) log(`${report.id}: thresholds ${report.thresholdsMet ? "met" : "NOT met"} · N ${report.n}${report.aborted === undefined ? "" : ` · ${report.aborted}`}`);
  return reports.length === (only ?? EVAL_IDS).length && reports.every((report) => report.thresholdsMet) ? 0 : 1;
}

function writeRunReport(dir: string, report: RunReport): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scenario-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(dir, "scenario-report.md"), renderMarkdown(report));
}

function wireLiveOperator(options: CliOptions): void {
  if (!options.liveOperator) return;
  setLiveOperator({
    photoClass: options.livePhoto,
    async prompt(message) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await terminal.question(`\n[team phone] ${message}\nPress Enter once done. `);
      } finally {
        terminal.close();
      }
    },
  });
}

async function main(): Promise<number> {
  const options = parseCli(process.argv.slice(2), process.env);
  if (options.aggregate !== undefined) return gate(options.aggregate);
  const scenarios = chosen(options);
  if (options.dryRun) return dryRun(scenarios);
  setEdgeConfig({ baseUrl: options.baseUrl ?? DEFAULT_BASE_URL, ...(options.bffUrl === undefined ? {} : { bffUrl: options.bffUrl }) });
  wireLiveOperator(options);
  const driver = createDriverClient();
  log(`run ${options.runId} · suite ${options.suite} · budget ${options.maxTurns} turns${options.maxCostUsd === undefined ? "" : ` / USD ${options.maxCostUsd}`}`);
  if (options.suite === "eval") return runEval(options, driver);
  const report = await runSuite({ runId: options.runId, suite: options.suite === "load" ? "custom" : options.suite, scenarios, driver, maxTurns: options.maxTurns, parallel: options.parallel, log, ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }) });
  writeRunReport(options.reportDir, report);
  log(`verdict ${report.verdict} · agent units ${report.agentRate.passed}/${report.agentRate.total} · report in ${options.reportDir}/`);
  return passed(report.verdict) || report.verdict === "SKIPPED_PENDING_P01" ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
