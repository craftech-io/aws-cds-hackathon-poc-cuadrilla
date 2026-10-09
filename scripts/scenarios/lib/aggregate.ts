// The gate of "100 % probada" over the reports of consecutive runs (docs/test-plan.md §1 item 3): every
// `det` unit passes in every run (3 of 3), every `agent` unit passes its oracle in at least two thirds of
// the runs (2 of 3), each one on its own; a unit skipped because P-01 is pending counts as skipped only in
// `SC-17`; every world of every run audited with 0 violations. `npm run scenarios -- --aggregate <dir>`.
import { type RunReport, type Verdict, passed } from "./report";

export const GATE_RUNS = 3;

export interface UnitGate {
  readonly key: string;
  readonly kind: "det" | "agent";
  readonly flows: readonly string[];
  readonly verdicts: readonly Verdict[];
  readonly passes: number;
  readonly runs: number;
  readonly ok: boolean;
  readonly note?: string;
}

export interface GateResult {
  readonly runs: readonly string[];
  readonly units: readonly UnitGate[];
  readonly auditViolations: number;
  readonly unauditedWorlds: number;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/** Whether a unit's verdicts over the runs meet the gate of its kind. */
export function unitMeetsGate(kind: "det" | "agent", verdicts: readonly Verdict[], scenario: string): { readonly ok: boolean; readonly passes: number; readonly note?: string } {
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === "SKIPPED_PENDING_P01")) {
    return scenario === "SC-17" ? { ok: true, passes: 0, note: "SKIPPED_PENDING_P01" } : { ok: false, passes: 0, note: "SKIPPED_PENDING_P01 outside SC-17" };
  }
  const passes = verdicts.filter(passed).length;
  if (kind === "det") return { ok: verdicts.length >= GATE_RUNS && passes === verdicts.length, passes };
  return { ok: verdicts.length >= GATE_RUNS && passes * 3 >= verdicts.length * 2, passes };
}

export function aggregate(reports: readonly RunReport[]): GateResult {
  const byUnit = new Map<string, { kind: "det" | "agent"; flows: readonly string[]; scenario: string; verdicts: Verdict[] }>();
  let auditViolations = 0;
  let unauditedWorlds = 0;
  for (const report of reports) {
    for (const scenario of report.scenarios) {
      for (const audit of scenario.audits) {
        if (audit.violations === null) unauditedWorlds += 1;
        else auditViolations += audit.violations;
      }
      for (const unit of scenario.units) {
        const key = `${scenario.scenario}/${unit.id}`;
        const entry = byUnit.get(key) ?? { kind: unit.kind, flows: unit.flows, scenario: scenario.scenario, verdicts: [] };
        entry.verdicts.push(unit.verdict);
        byUnit.set(key, entry);
      }
    }
  }
  const units = [...byUnit.entries()].map(([key, entry]): UnitGate => {
    const gate = unitMeetsGate(entry.kind, entry.verdicts, entry.scenario);
    return { key, kind: entry.kind, flows: entry.flows, verdicts: entry.verdicts, passes: gate.passes, runs: entry.verdicts.length, ok: gate.ok, ...(gate.note === undefined ? {} : { note: gate.note }) };
  });
  const problems = [
    ...(reports.length < GATE_RUNS ? [`${reports.length} run(s): the gate asks ${GATE_RUNS} in a row`] : []),
    ...units.filter((unit) => !unit.ok).map((unit) => `${unit.key} (${unit.kind}) ${unit.passes}/${unit.runs}${unit.note === undefined ? "" : ` ${unit.note}`}`),
    ...(auditViolations > 0 ? [`policy audit: ${auditViolations} violation(s)`] : []),
    ...(unauditedWorlds > 0 ? [`policy audit: ${unauditedWorlds} world(s) not audited`] : []),
  ];
  return { runs: reports.map((report) => report.runId), units, auditViolations, unauditedWorlds, ok: problems.length === 0, problems };
}
