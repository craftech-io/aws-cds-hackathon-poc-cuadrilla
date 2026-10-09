// The `eval` suite of the scenario runner (`npm run scenarios -- --suite eval`, WP-45; `scenarios.yml`,
// WP-48): EV-01 and EV-02, each in its own world, one after the other, with their reports written as the
// run's artifacts (never committed).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ev01, runEv01 } from "../ev-01-manual";
import { ev02, runEv02 } from "../ev-02-photos";
import { type EvalReport, renderReport } from "./report";
import type { EvalRunOptions, EvaluationDef } from "./types";

export interface EvalSuiteEntry {
  readonly def: EvaluationDef;
  readonly run: (options: EvalRunOptions) => Promise<EvalReport>;
}

export const EVAL_SUITE: readonly EvalSuiteEntry[] = [
  { def: ev01, run: runEv01 },
  { def: ev02, run: runEv02 },
];

/** `<dir>/<EV-nn>-<runId>.json` and `.md`; returns their paths. */
export function writeReport(dir: string, report: EvalReport): string[] {
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${report.id}-${report.runId}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${base}.md`, renderReport(report));
  return [`${base}.json`, `${base}.md`];
}

/** Runs the chosen measurements (both by default), writes each report, and returns them. */
export async function runEvalSuite(options: EvalRunOptions & { readonly reportDir: string; readonly only?: ReadonlyArray<EvaluationDef["id"]> }): Promise<EvalReport[]> {
  const reports: EvalReport[] = [];
  for (const entry of EVAL_SUITE) {
    if (options.only !== undefined && !options.only.includes(entry.def.id)) continue;
    const report = await entry.run(options);
    writeReport(options.reportDir, report);
    reports.push(report);
  }
  return reports;
}
