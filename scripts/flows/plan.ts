// The scenario side of `flows:check` (docs/test-plan.md §4.3 and §4.5, ADR-0021), read from the
// documents alone so it runs from wave 0, before any scenario file exists:
//
//   - the steps and parts of every scenario of §4.5 (`4 [det] …`, `4.a [det] … · 4.b [agent] …`),
//     where a step with more than one `[det]`/`[agent]` segment must be written in parts;
//   - every `SC-nn/…`, `SMK/…` and `EV-nn/…` citation of the catalog resolves to a step or part;
//   - "(pendiente P-01)" marks only `SC-17` citations of the flows §2.1 lists for P-01;
//   - the keys of the oracle table follow the grammar of §4.3 and its precedence has no tie.
//
// What the scenario files must declare (`flows`, `kind`, `after`, `oracleFlow`) is checked by
// check.ts once they exist.
import type { Flow } from "./check";

export type StepKind = "det" | "agent";

export interface ScenarioStep {
  /** `det`/`agent` of a step without parts; undefined for a step with parts or an evaluation step. */
  readonly kind: StepKind | undefined;
  /** Parts `a`, `b`, … with their kinds (ADR-0021). */
  readonly parts: ReadonlyMap<string, StepKind>;
}

export type ScenarioPlan = ReadonlyMap<string, ReadonlyMap<string, ScenarioStep>>;

function section(markdown: string, start: string, end: string): string {
  const from = markdown.indexOf(start);
  if (from === -1) return "";
  const to = markdown.indexOf(end, from + start.length);
  return markdown.slice(from, to === -1 ? undefined : to);
}

const SEGMENT = /(?<![\w./'-])(X?\d+)(?:\.([a-z]))?(?:-(\d+))? \[(det|agent)\]/g;
const PART_HEADER = /(?:^|· )(X?\d+) \(/g;
const PLAIN_STEP = /(?:^|· )(\d+) /g;

/** Steps and parts of every scenario row of §4.5, plus the problems of how they are written. */
export function parseScenarioPlan(testPlan: string): { plan: ScenarioPlan; errors: string[] } {
  const plan = new Map<string, Map<string, { kind: StepKind | undefined; parts: Map<string, StepKind> }>>();
  const errors: string[] = [];
  for (const line of section(testPlan, "### 4.5", "\n## 5").split("\n")) {
    const row = /^\| `((?:SC|EV)-\d{2})`[^|]*\|[^|]*\| (.*) \|$/.exec(line);
    if (!row) continue;
    const scenario = row[1] ?? "";
    const text = row[2] ?? "";
    const steps = new Map<string, { kind: StepKind | undefined; parts: Map<string, StepKind> }>();
    const step = (id: string) => steps.get(id) ?? steps.set(id, { kind: undefined, parts: new Map() }).get(id)!;
    let segments = 0;
    for (const match of text.matchAll(SEGMENT)) {
      segments += 1;
      const [, id = "", part, until, kind] = match;
      const last = until === undefined ? Number(id.replace("X", "")) : Number(until);
      const first = Number(id.replace("X", ""));
      for (let n = first; n <= last; n += 1) {
        const name = `${id.startsWith("X") ? "X" : ""}${n}`;
        const entry = step(name);
        if (part !== undefined) entry.parts.set(part, kind as StepKind);
        else if (entry.kind !== undefined) errors.push(`${scenario}/${name}: more than one [det]/[agent] segment; write it in parts ${name}.a, ${name}.b (§4.3)`);
        else entry.kind = kind as StepKind;
      }
    }
    const tagged = (text.match(/\[(det|agent)\]/g) ?? []).length;
    if (tagged !== segments) errors.push(`${scenario}: ${tagged - segments} [det]/[agent] segment(s) without a step or part id`);
    for (const match of text.matchAll(PART_HEADER)) step(match[1] ?? "");
    if (segments === 0) for (const match of text.matchAll(PLAIN_STEP)) step(match[1] ?? "");
    for (const [id, entry] of steps) {
      if (entry.kind !== undefined && entry.parts.size > 0) errors.push(`${scenario}/${id}: declares a kind and parts at once (§4.3)`);
    }
    plan.set(scenario, steps);
  }
  return { plan, errors };
}

/** Steps or parts a citation names (`SC-18/4`, `SC-18/4.b`, `SC-02/5..7`, `SMK/3`, `EV-01/2`). */
export function resolveCitation(plan: ScenarioPlan, citation: string): { targets: string[]; error?: string } {
  const match = /^(?:(SC|EV)-(\d{2})|(SMK))\/(X?\d+)(?:\.([a-z])|\.\.(\d+))?$/.exec(citation);
  if (!match) return { targets: [], error: `${citation}: not a step citation (SC-nn/m, SC-nn/m.p, SC-nn/m..k, SC-nn/Xm)` };
  const scenario = match[3] ? "SC-00" : `${match[1]}-${match[2]}`;
  const steps = plan.get(scenario);
  if (!steps) return { targets: [], error: `${citation}: ${scenario} is not a scenario of docs/test-plan.md §4.5` };
  const id = match[4] ?? "";
  const ids = match[6] === undefined ? [id] : Array.from({ length: Number(match[6]) - Number(id) + 1 }, (_, index) => `${Number(id) + index}`);
  const targets: string[] = [];
  for (const stepId of ids) {
    const entry = steps.get(stepId);
    if (!entry) return { targets: [], error: `${citation}: ${scenario} has no step ${stepId}` };
    if (match[5] === undefined) targets.push(...(entry.parts.size > 0 ? [...entry.parts.keys()].map((part) => `${scenario}/${stepId}.${part}`) : [`${scenario}/${stepId}`]));
    else if (entry.parts.has(match[5])) targets.push(`${scenario}/${stepId}.${match[5]}`);
    else return { targets: [], error: `${citation}: ${scenario}/${stepId} has no part ${match[5]}` };
  }
  return { targets };
}

/** Kind of a resolved target (`SC-18/4.b` or `SC-01/2`). */
export function kindOf(plan: ScenarioPlan, target: string): StepKind | undefined {
  const [scenario = "", path = ""] = target.split("/");
  const [id = "", part] = path.split(".");
  const entry = plan.get(scenario)?.get(id);
  return part === undefined ? entry?.kind : entry?.parts.get(part);
}

/** Flows §2.1 lets run `SKIPPED_PENDING_P01` (the row about live WhatsApp). */
export function pendingP01Flows(testPlan: string): Set<string> {
  const row = section(testPlan, "### 2.1", "### 2.2")
    .split("\n")
    .find((line) => line.startsWith("| FL-") && line.includes("P-01"));
  return new Set((row?.split(" | ")[0] ?? "").match(/FL-\d{3}/g) ?? []);
}

export function checkStepCitations(flows: readonly Flow[], plan: ScenarioPlan, pendingFlows: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  for (const flow of flows) {
    for (const cited of [...flow.tests.SR, ...flow.tests.SMK]) {
      const { error } = resolveCitation(plan, cited);
      if (error) errors.push(`${flow.id}: ${error}`);
    }
    for (const match of (flow.cells.SR ?? "").matchAll(/`([^`]+)` \([^()]*pendiente P-01\)/g)) {
      const cited = match[1] ?? "";
      if (!cited.startsWith("SC-17/")) errors.push(`${flow.id}: ${cited} is marked pending P-01 but only SC-17 may be skipped (§2.1)`);
      if (!pendingFlows.has(flow.id)) errors.push(`${flow.id}: marked pending P-01 but §2.1 does not list it`);
    }
  }
  return errors;
}
