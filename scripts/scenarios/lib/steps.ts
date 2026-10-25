// Scenarios, steps and parts as the runner reads them (docs/test-plan.md §4.3 and §4.5, ADR-0021). Every
// step without parts, and every part `n.a`, `n.b`… of a step with parts, declares
//
//   flows       the flows it proves (`flows: ["FL-xxx", …]`, what `npm run flows:check` looks for)
//   kind        `det` (no result of the model decides it: 3 of 3) or `agent` (its oracle in ≥ 2 of 3)
//   after       `preset`, `scene` or the id of an earlier step or part it depends on (`'2'`, `'4.b'`)
//   oracleFlow  only for an `agent` step or part with several flows: the flow whose oracle row decides
//   expect      a result sought on purpose (`DUPLICATE_EVIDENCE`)
//
// A step with parts declares none of those: each part does. `validateScenario` enforces what §4.3 asks of
// the definitions (steps.test.ts runs it over every scenario and against §4.5): a `det` never depends on an
// `agent` (not even on a part of its own step), `after` names an earlier id, `oracleFlow` is an `agent`'s
// and one of its flows. The context of a run (context.ts) enforces the quiescence rule on negatives.
import type { ScenarioContext } from "./context";

export type StepKind = "det" | "agent";
export type Suite = "smoke" | "full";

export interface StepBody {
  readonly title: string;
  readonly kind: StepKind;
  readonly flows: readonly string[];
  /** `preset`, `scene` or the id of an earlier step or part of the same scenario. */
  readonly after: string;
  readonly oracleFlow?: string;
  readonly expect?: string;
  readonly run: (ctx: ScenarioContext) => Promise<void>;
}

export interface PlainStep extends StepBody {
  /** The number the catalog cites (`SC-01/2` is step `2`; the express tour's are `X1`…). */
  readonly id: string;
}

export interface StepPart extends StepBody {
  /** `a`, `b`, … in the order of §4.5. */
  readonly part: string;
}

export interface PartedStep {
  readonly id: string;
  readonly title: string;
  readonly parts: readonly StepPart[];
}

export type StepDef = PlainStep | PartedStep;

export interface ScenarioDef {
  /** `SC-04` (the catalog's name). */
  readonly id: string;
  /** `sc-04`: the clock's and the keys' segment. */
  readonly slug: string;
  readonly title: string;
  readonly suites: readonly Suite[];
  /** Scenarios of one lane run one after the other (`SC-19` then `SC-18` share `guest-test`). */
  readonly lane?: string;
  /** Runs alone after the parallel part (`SC-20`: the counters of its run); `last` after every other (`SC-16`). */
  readonly alone?: boolean;
  readonly last?: boolean;
  /** Why the whole scenario is skipped this run (`SC-17` while `live` is not a transport): its steps are `SKIPPED_LIVE_P01`. */
  readonly pending?: (ctx: ScenarioContext) => Promise<string | undefined>;
  /** The worlds and baselines every unit starts from (presets, never turns of the model); unit key `setup`. */
  readonly setup?: (ctx: ScenarioContext) => Promise<void>;
  readonly steps: readonly StepDef[];
  /** Always runs, also after a failure (kill switch off, the DLQ, the seam's accounts). */
  readonly cleanup?: (ctx: ScenarioContext) => Promise<void>;
}

/** One unit the runner executes and the report scores: a step without parts, or one part. */
export interface Unit extends StepBody {
  /** `4` or `4.b`. */
  readonly id: string;
  readonly stepId: string;
}

export function isParted(step: StepDef): step is PartedStep {
  return "parts" in step;
}

/** The units of a scenario, in order. */
export function unitsOf(scenario: Pick<ScenarioDef, "steps">): Unit[] {
  return scenario.steps.flatMap((step): Unit[] => (isParted(step) ? step.parts.map((part) => ({ ...part, id: `${step.id}.${part.part}`, stepId: step.id })) : [{ ...step, stepId: step.id }]));
}

const FLOW = /^FL-\d{3}$/;
const STEP_ID = /^(?:X?\d{1,2})$/;

/** The kind an `after` reference stands for: a step with parts is `agent` when any part is. */
function kindOfRef(units: readonly Unit[], ref: string): StepKind | undefined {
  const exact = units.find((unit) => unit.id === ref);
  if (exact !== undefined) return exact.kind;
  const parts = units.filter((unit) => unit.stepId === ref);
  if (parts.length === 0) return undefined;
  return parts.some((part) => part.kind === "agent") ? "agent" : "det";
}

/** Problems of a scenario's definition (empty when it follows §4.3). */
export function validateScenario(scenario: ScenarioDef): string[] {
  const problems: string[] = [];
  const units = unitsOf(scenario);
  const ids = new Set<string>();
  for (const step of scenario.steps) {
    if (!STEP_ID.test(step.id)) problems.push(`${scenario.id}/${step.id}: not a step id`);
    if (scenario.steps.filter((other) => other.id === step.id).length > 1) problems.push(`${scenario.id}/${step.id}: repeated step id`);
    if (isParted(step)) {
      if (step.parts.length < 2) problems.push(`${scenario.id}/${step.id}: a step with parts has at least two`);
      step.parts.forEach((part, index) => {
        if (part.part !== String.fromCharCode(97 + index)) problems.push(`${scenario.id}/${step.id}.${part.part}: parts go a, b, c… in order`);
      });
      for (const field of ["kind", "flows", "after", "oracleFlow", "expect"]) if (field in step) problems.push(`${scenario.id}/${step.id}: a step with parts declares no ${field} of its own`);
    }
  }
  units.forEach((unit, index) => {
    const where = `${scenario.id}/${unit.id}`;
    if (unit.flows.length === 0) problems.push(`${where}: declares no flow`);
    for (const flow of unit.flows) if (!FLOW.test(flow)) problems.push(`${where}: ${flow} is not a flow id`);
    if (unit.oracleFlow !== undefined) {
      if (unit.kind !== "agent") problems.push(`${where}: oracleFlow only in an agent step or part`);
      else if (!unit.flows.includes(unit.oracleFlow)) problems.push(`${where}: oracleFlow ${unit.oracleFlow} is not one of its flows`);
    }
    if (unit.after !== "preset" && unit.after !== "scene") {
      const earlier = units.slice(0, index);
      const kind = kindOfRef(earlier, unit.after);
      if (kind === undefined) problems.push(`${where}: after '${unit.after}' is not an earlier step or part`);
      else if (unit.kind === "det" && kind === "agent") problems.push(`${where}: a det step or part depends on an agent one ('${unit.after}')`);
    }
    ids.add(unit.id);
  });
  return problems;
}

export function defineScenario(scenario: ScenarioDef): ScenarioDef {
  const problems = validateScenario(scenario);
  if (problems.length > 0) throw new RangeError(problems.join("; "));
  return scenario;
}

/** The units a failed unit takes down: every later unit whose `after` chain reaches it. */
export function dependentsOf(units: readonly Unit[], failed: string): Set<string> {
  const down = new Set<string>([failed]);
  for (const unit of units) {
    if (down.has(unit.id)) continue;
    const ref = unit.after;
    if (down.has(ref) || [...down].some((id) => id.startsWith(`${ref}.`))) down.add(unit.id);
  }
  down.delete(failed);
  return down;
}
