// Flow ids of docs/flows-catalog.md (`FL-001` … `FL-122`), their areas, the test levels of the
// traceability matrix (docs/test-plan.md §2) and the grammar of scenario steps (§4.3, ADR-0021).
// Tests tag every `describe`/`it` that proves a flow with `[FL-xxx]`; every scenario step without
// parts, and every part of a step with parts, declares `flows`, one `kind` and one `after`.
import { z } from "zod";

/** Flows of the catalog; a flow id outside 1..FLOW_COUNT is a typo, not a new flow. */
export const FLOW_COUNT = 122;

export const FlowId = z
  .string()
  .regex(/^FL-\d{3}$/, "expected FL-000")
  .refine((value) => Number(value.slice(3)) >= 1 && Number(value.slice(3)) <= FLOW_COUNT, `expected a flow of the catalog, FL-001 to FL-${FLOW_COUNT}`);
export type FlowId = z.infer<typeof FlowId>;

export function flowId(n: number): FlowId {
  return FlowId.parse(`FL-${String(n).padStart(3, "0")}`);
}

export const ALL_FLOW_IDS: readonly FlowId[] = Array.from({ length: FLOW_COUNT }, (_, index) => flowId(index + 1));

/** Areas of the catalog ("Áreas" line of docs/flows-catalog.md), by letter. */
export const FLOW_AREAS = {
  A: "Onboarding and registry",
  B: "Start of the day and work orders",
  C: "Voice and diagnosis",
  D: "Manual and limits",
  E: "Photo evidence",
  F: "Closing and installation certificate",
  G: "Escalation and supervisors",
  H: "Safety",
  I: "Policy, window and templates",
  J: "Console and surfaces",
  K: "Live channel and robustness",
  L: "Own sign-up, access and leads",
} as const;

export const FlowArea = z.enum(Object.keys(FLOW_AREAS) as [keyof typeof FLOW_AREAS, ...Array<keyof typeof FLOW_AREAS>]);
export type FlowArea = z.infer<typeof FlowArea>;

/** Test levels of the matrix: unit, local flow, console UI, scenario runner in `poc`, CI smoke. */
export const FlowLevel = z.enum(["U", "LF", "UI", "SR", "SMK"]);
export type FlowLevel = z.infer<typeof FlowLevel>;

/** `[FL-017]`, the tag a test name carries for `npm run flows:check`. */
export function flowTag(id: string): string {
  return `[${FlowId.parse(id)}]`;
}

/** Flow ids tagged in a test name, in order of appearance, without repeats. */
export function flowTagsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(FL-\d{3})\]/g)].map((match) => match[1] ?? ""))];
}

// ---- Scenario steps (docs/test-plan.md §4.3, ADR-0021) -----------------------------------------

/** `det` passes 3 of 3 runs; `agent` depends on the model and passes its oracle in ≥ 2 of 3. */
export const StepKind = z.enum(["det", "agent"]);
export type StepKind = z.infer<typeof StepKind>;

/** Scenarios of the runner (`SC-00` … `SC-20`) and evaluation runs (`EV-01`, `EV-02`). */
export const ScenarioId = z.string().regex(/^(?:SC|EV)-\d{2}$/, "expected SC-00 or EV-01");
export type ScenarioId = z.infer<typeof ScenarioId>;

/** Id of a step or part inside its scenario: `4`, `4.b`, or an express-tour step `X2`. */
export const StepId = z.string().regex(/^X?\d+(?:\.[a-z])?$/, "expected 4, 4.b or X2");
export type StepId = z.infer<typeof StepId>;

/** What a step starts from: a preset of `world.create`, a scene, or an earlier step or part. */
export const StepAfter = z.union([z.literal("preset"), z.literal("scene"), StepId]);
export type StepAfter = z.infer<typeof StepAfter>;

const CITATION = /^(?:(?:SC|EV)-\d{2}|SMK)\/(X?\d+)(?:\.([a-z])|\.\.(\d+))?$/;

/** A step as the matrix cites it: `SC-01/2`, a part `SC-18/4.b`, a range `SC-04/3..8`, `SC-18/X2`, `SMK/3`. */
export const StepCitation = z.string().regex(CITATION, "expected SC-nn/m, SC-nn/m.p, SC-nn/m..k, SC-nn/Xm or SMK/m");
export type StepCitation = z.infer<typeof StepCitation>;

export interface ParsedStepCitation {
  /** `SC-nn` or `EV-nn`; a smoke step `SMK/m` is a step of `SC-00`. */
  readonly scenario: ScenarioId;
  /** The steps it names, in order (a range expands); parts are not expanded here. */
  readonly steps: readonly string[];
  readonly part?: string;
}

export function parseStepCitation(citation: string): ParsedStepCitation {
  const match = CITATION.exec(StepCitation.parse(citation));
  const head = citation.slice(0, citation.indexOf("/"));
  const scenario = head === "SMK" ? "SC-00" : head;
  const first = match?.[1] ?? "";
  const until = match?.[3];
  if (until === undefined) return match?.[2] === undefined ? { scenario, steps: [first] } : { scenario, steps: [first], part: match[2] };
  if (first.startsWith("X") || Number(until) < Number(first)) throw new RangeError(`invalid step range ${citation}`);
  return { scenario, steps: Array.from({ length: Number(until) - Number(first) + 1 }, (_, offset) => String(Number(first) + offset)) };
}

/**
 * What a scenario step (or part) declares. `oracleFlow` exists only in `agent` steps and names one
 * of its `flows`, the one whose oracle row decides it; `expect` is a result sought on purpose (for
 * example `DUPLICATE_EVIDENCE`).
 */
export const StepDeclaration = z
  .object({
    id: StepId,
    flows: z.array(FlowId).min(1),
    kind: StepKind,
    after: StepAfter,
    oracleFlow: FlowId.optional(),
    expect: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (new Set(step.flows).size !== step.flows.length) ctx.addIssue({ code: "custom", path: ["flows"], message: "a flow is declared twice" });
    if (step.oracleFlow !== undefined && step.kind === "det") ctx.addIssue({ code: "custom", path: ["oracleFlow"], message: "a det step has no oracleFlow" });
    if (step.oracleFlow !== undefined && !step.flows.includes(step.oracleFlow)) ctx.addIssue({ code: "custom", path: ["oracleFlow"], message: "oracleFlow must be one of flows" });
    if (step.after === step.id) ctx.addIssue({ code: "custom", path: ["after"], message: "a step cannot start after itself" });
  });
export type StepDeclaration = z.infer<typeof StepDeclaration>;
