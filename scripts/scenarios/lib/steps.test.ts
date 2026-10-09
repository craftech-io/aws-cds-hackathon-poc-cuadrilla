// The definitions of the scenarios against docs/test-plan.md §4.3 and §4.5 (ADR-0021): parts, kinds,
// `after`, `oracleFlow`, the flows each unit must declare for the catalog's citations, and the quiescence
// rule of negatives (a negative or an exact count only on a snapshot of `settled()`).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCatalog } from "../../flows/check";
import { parseScenarioPlan, resolveCitation } from "../../flows/plan";
import type { QaResponse } from "../../../packages/bff/src/qa-driver/contract";
import { ScenarioBug, emptyRecord, unitContext } from "./context";
import type { DriverClient } from "./driver-client";
import { type ScenarioDef, type StepBody, dependentsOf, unitsOf, validateScenario } from "./steps";
import { SCENARIOS } from "./suites";
import { TOUR_STEPS } from "../../../packages/web/src/views/tour/steps";

const ROOT = new URL("../../../", import.meta.url);
const plan = parseScenarioPlan(readFileSync(new URL("docs/test-plan.md", ROOT), "utf8")).plan;
const catalog = parseCatalog(readFileSync(new URL("docs/flows-catalog.md", ROOT), "utf8"));

const body = (kind: StepBody["kind"], after: string, extra: Partial<StepBody> = {}): StepBody => ({ title: "t", kind, flows: ["FL-001"], after, run: async () => undefined, ...extra });
const scenario = (steps: ScenarioDef["steps"]): ScenarioDef => ({ id: "SC-99", slug: "sc-99", title: "test", suites: ["full"], steps });

describe("validateScenario (§4.3, ADR-0021)", () => {
  it("refuses a det part whose after is an agent part of the same step", () => {
    const problems = validateScenario(scenario([{ id: "1", title: "x", parts: [{ part: "a", ...body("agent", "preset") }, { part: "b", ...body("det", "1.a") }] }]));
    expect(problems).toEqual([expect.stringContaining("a det step or part depends on an agent one ('1.a')")]);
  });

  it("refuses a det step after a step whose parts include an agent one, an unknown id and a later id", () => {
    const parted = { id: "1", title: "x", parts: [{ part: "a", ...body("det", "preset") }, { part: "b", ...body("agent", "1.a") }] };
    expect(validateScenario(scenario([parted, { id: "2", ...body("det", "1") }]))).toEqual([expect.stringContaining("depends on an agent one ('1')")]);
    expect(validateScenario(scenario([{ id: "1", ...body("det", "7") }]))).toEqual([expect.stringContaining("not an earlier step or part")]);
    expect(validateScenario(scenario([{ id: "1", ...body("det", "2") }, { id: "2", ...body("det", "preset") }]))).toEqual([expect.stringContaining("not an earlier step or part")]);
    expect(validateScenario(scenario([{ id: "1", ...body("agent", "preset") }, { id: "2", ...body("agent", "1") }, { id: "3", ...body("det", "scene") }]))).toEqual([]);
  });

  it("allows oracleFlow only on an agent unit and only among its flows; parts go a, b… and the step declares nothing of its own", () => {
    expect(validateScenario(scenario([{ id: "1", ...body("det", "preset", { oracleFlow: "FL-001" }) }]))).toEqual([expect.stringContaining("oracleFlow only in an agent")]);
    expect(validateScenario(scenario([{ id: "1", ...body("agent", "preset", { oracleFlow: "FL-002" }) }]))).toEqual([expect.stringContaining("is not one of its flows")]);
    const skipped = { id: "1", title: "x", parts: [{ part: "a", ...body("det", "preset") }, { part: "c", ...body("det", "preset") }] };
    expect(validateScenario(scenario([skipped]))).toEqual([expect.stringContaining("parts go a, b, c")]);
    const own = { id: "1", title: "x", kind: "det", parts: [{ part: "a", ...body("det", "preset") }, { part: "b", ...body("det", "preset") }] } as unknown as ScenarioDef["steps"][number];
    expect(validateScenario(scenario([own]))).toEqual([expect.stringContaining("declares no kind of its own")]);
  });

  it("takes down only the units whose after chain reaches a failed one", () => {
    const units = unitsOf(scenario([{ id: "1", ...body("agent", "preset") }, { id: "2", ...body("agent", "1") }, { id: "3", ...body("det", "preset") }, { id: "4", title: "x", parts: [{ part: "a", ...body("agent", "2") }, { part: "b", ...body("det", "3") }] }, { id: "5", ...body("agent", "4") }]));
    expect([...dependentsOf(units, "1")].sort()).toEqual(["2", "4.a", "5"]);
    expect([...dependentsOf(units, "3")].sort()).toEqual(["4.b", "5"]);
  });
});

describe("every scenario of the runner", () => {
  const units = (definition: ScenarioDef) => unitsOf(definition);

  it("is valid by §4.3", () => {
    for (const definition of SCENARIOS) expect(validateScenario(definition), definition.id).toEqual([]);
  });

  it("has exactly the steps, parts and kinds of §4.5", () => {
    for (const definition of SCENARIOS) {
      const planned = plan.get(definition.id);
      expect(planned, `${definition.id} is in §4.5`).toBeDefined();
      const want = [...(planned ?? new Map()).entries()].flatMap(([id, step]) => (step.parts.size > 0 ? [...step.parts.entries()].map(([part, kind]) => `${id}.${part}:${kind}`) : [`${id}:${step.kind}`]));
      const have = units(definition).map((unit) => `${unit.id}:${unit.kind}`);
      expect(have, definition.id).toEqual(want);
    }
  });

  it("declares on each unit every flow the catalog cites it for", () => {
    const cited = new Map<string, Set<string>>();
    for (const flow of catalog) {
      for (const citation of [...flow.tests.SR, ...flow.tests.SMK]) for (const target of resolveCitation(plan, citation).targets) cited.set(target, (cited.get(target) ?? new Set()).add(flow.id));
    }
    for (const definition of SCENARIOS) {
      for (const unit of units(definition)) {
        const want = [...(cited.get(`${definition.id}/${unit.id}`) ?? [])];
        expect(unit.flows, `${definition.id}/${unit.id}`).toEqual(expect.arrayContaining(want));
      }
    }
  });
});

describe("SC-18 and the tour's one source", () => {
  it("has a step for every step of views/tour/steps.ts, both tracks", () => {
    const sc18 = SCENARIOS.find((definition) => definition.id === "SC-18");
    const ids = new Set(sc18?.steps.map((step) => step.id));
    const missing = Object.values(TOUR_STEPS).flatMap((steps) => steps.map((step) => step.stepId)).filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
  });
});

describe("the quiescence rule (§4.3)", () => {
  const snapshot = { clockId: "qa-812-1-sc-99", simNow: "", mode: "PAUSED", worldEpoch: 1, timers: [], orders: [], people: [], cases: [], caseTimers: [], decisions: [], outbox: [] };
  const driver: DriverClient = { call: async (): Promise<QaResponse> => ({ ok: true, replayed: false, result: snapshot }) };
  const ctxOf = () => unitContext({ runId: "812-1", scenario: scenario([]), driver, state: {} }, "3", emptyRecord());

  it("refuses a negative or an exact count on a snapshot that was not taken by settled()", async () => {
    const ctx = ctxOf();
    const plain = await ctx.snapshot({ clockId: snapshot.clockId });
    expect(() => ctx.none(plain, "cases", [])).toThrow(ScenarioBug);
    expect(() => ctx.exactly(plain, 0, "cases", [])).toThrow(ScenarioBug);
  });

  it("refuses it on a settled snapshot when something changed after the settle", async () => {
    const ctx = ctxOf();
    const settled = await ctx.settled({ clockId: snapshot.clockId }, { clockId: snapshot.clockId });
    expect(() => ctx.none(settled, "cases", [])).not.toThrow();
    await ctx.qa("clock.advance", { clockId: snapshot.clockId, minutes: 10 });
    expect(() => ctx.none(settled, "cases", [])).toThrow(ScenarioBug);
  });
});
