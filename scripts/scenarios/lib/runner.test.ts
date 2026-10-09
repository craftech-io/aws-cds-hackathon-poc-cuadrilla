// The runner over a fake driver (no AWS): units scored alone, a failure takes down only its `after` chain,
// the cleanup (own and per world) always runs, a `pending` scenario is SKIPPED_PENDING_P01, a driver's
// NOT_WIRED is BLOCKED (never a pass), and the budget skips what is left.
import { describe, expect, it } from "vitest";
import type { QaActionName, QaResponse } from "../../../packages/bff/src/qa-driver/contract";
import { Blocked } from "./context";
import type { DriverClient } from "./driver-client";
import { lanesOf, runScenario, runSuite } from "./runner";
import { type ScenarioDef, type StepBody, defineScenario } from "./steps";
import { createWorld } from "./world";

interface Call {
  readonly action: QaActionName;
  readonly input: unknown;
  readonly key: string;
}

function fakeDriver(overrides: Partial<Record<QaActionName, (input: unknown) => QaResponse>> = {}, turnsPerWorld = 10): DriverClient & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async call(action, input, key) {
      calls.push({ action, input, key });
      const override = overrides[action];
      if (override !== undefined) return override(input);
      const clockId = (input as { clockId?: string }).clockId ?? "";
      if (action === "world.create") return { ok: true, replayed: false, result: { kind: "QA", world: { clockId, ispId: `isp-${clockId}`, worldEpoch: 1, startAtSim: "", operations: [], people: [], presets: [] } } };
      if (action === "policyAudit.run") return { ok: true, replayed: false, result: { violations: 0 } };
      if (action === "metrics.get") return { ok: true, replayed: false, result: { clockId, usage: { turns: turnsPerWorld }, estimatedCostUsd: 0.5 } };
      return { ok: true, replayed: false, result: {} };
    },
  };
}

const body = (kind: StepBody["kind"], after: string, run: StepBody["run"] = async () => undefined): StepBody => ({ title: "t", kind, flows: ["FL-001"], after, run });
const fail = async () => {
  throw new Error("boom");
};

function scenarioOf(id: string, steps: ScenarioDef["steps"], extra: Partial<ScenarioDef> = {}): ScenarioDef {
  return defineScenario({
    id,
    slug: `sc-${id.slice(3)}`,
    title: id,
    suites: ["full"],
    async setup(ctx) {
      await createWorld(ctx, { operations: [{ key: "a", model: "wo-24817", installer: "own" }] });
    },
    steps,
    ...extra,
  });
}

const options = (driver: DriverClient, scenarios: readonly ScenarioDef[] = []) => ({ runId: "812-1", suite: "full" as const, scenarios, driver, maxTurns: 400 });

describe("runScenario", () => {
  it("skips only the units whose after chain reaches a failure and cleans every world in finally", async () => {
    const driver = fakeDriver();
    let cleaned = false;
    const scenario = scenarioOf(
      "SC-98",
      [
        { id: "1", ...body("agent", "preset", fail) },
        { id: "2", ...body("agent", "1") },
        { id: "3", ...body("det", "preset") },
        { id: "4", title: "x", parts: [{ part: "a", ...body("det", "3") }, { part: "b", ...body("agent", "4.a", fail) }] },
      ],
      {
        cleanup: async () => {
          cleaned = true;
        },
      },
    );
    const result = await runScenario(options(driver), scenario);
    expect(result.units.map((unit) => `${unit.id}:${unit.verdict}`)).toEqual(["1:FAIL", "2:SKIPPED", "3:PASS", "4.a:PASS", "4.b:FAIL"]);
    expect(cleaned).toBe(true);
    expect(driver.calls.filter((call) => call.action === "world.destroy").map((call) => (call.input as { clockId: string }).clockId)).toEqual(["qa-812-1-sc-98"]);
    expect(result.audits).toEqual([{ clockId: "qa-812-1-sc-98", violations: 0 }]);
    expect(result.verdict).toBe("FAIL");
  });

  it("gives every call an idempotency key of the run, the scenario and the unit", async () => {
    const driver = fakeDriver();
    await runScenario(options(driver), scenarioOf("SC-97", [{ id: "1", ...body("det", "preset", async (ctx) => void (await ctx.qa("clock.advance", { clockId: "qa-812-1-sc-97", minutes: 5 }))) }]));
    expect(driver.calls.map((call) => call.key)).toEqual(["812-1/sc-97/setup/m1", "812-1/sc-97/1/m1", "812-1/sc-97/999/m1", "812-1/sc-97/999/r1", "812-1/sc-97/999/m2"]);
  });

  it("reports a policy violation of a world as the scenario's failure", async () => {
    const driver = fakeDriver({ "policyAudit.run": () => ({ ok: true, replayed: false, result: { violations: 2 } }) });
    const result = await runScenario(options(driver), scenarioOf("SC-96", [{ id: "1", ...body("det", "preset") }]));
    expect(result.units[0]?.verdict).toBe("PASS");
    expect(result.verdict).toBe("FAIL");
  });

  it("marks a pending scenario's units SKIPPED_PENDING_P01 without running its setup", async () => {
    const driver = fakeDriver();
    const scenario = scenarioOf("SC-17", [{ id: "1", ...body("det", "preset", fail) }], { pending: async () => "P-01 open" });
    const result = await runScenario(options(driver), scenario);
    expect(result.units.map((unit) => unit.verdict)).toEqual(["SKIPPED_PENDING_P01"]);
    expect(driver.calls.some((call) => call.action === "world.create")).toBe(false);
    expect(result.verdict).toBe("SKIPPED_PENDING_P01");
  });

  it("is BLOCKED, never a pass, when the driver answers NOT_WIRED or the step needs what is missing", async () => {
    const driver = fakeDriver({ "kill.set": () => ({ ok: false, error: { code: "UNAVAILABLE", reason: "NOT_WIRED", message: "not deployed" } }) });
    const scenario = scenarioOf("SC-95", [
      { id: "1", ...body("det", "preset", async (ctx) => void (await ctx.qa("kill.set", { clockId: "qa-812-1-sc-95", scope: "AGENT", on: true }))) },
      {
        id: "2",
        ...body("det", "preset", async () => {
          throw new Blocked("needs the team phone");
        }),
      },
    ]);
    const result = await runScenario(options(driver), scenario);
    expect(result.units.map((unit) => unit.verdict)).toEqual(["BLOCKED", "BLOCKED"]);
    expect(result.verdict).toBe("BLOCKED");
  });
});

describe("runSuite", () => {
  it("puts a lane in order, the alone ones after and the last one at the end", () => {
    const a = scenarioOf("SC-01", []);
    const b = scenarioOf("SC-19", [], { lane: "guest-test" });
    const c = scenarioOf("SC-18", [], { lane: "guest-test" });
    const d = scenarioOf("SC-20", [], { alone: true });
    const e = scenarioOf("SC-16", [], { last: true });
    const plan = lanesOf([e, a, d, b, c]);
    expect(plan.lanes.map((lane) => lane.map((scenario) => scenario.id))).toEqual([["SC-01"], ["SC-19", "SC-18"]]);
    expect(plan.alone.map((scenario) => scenario.id)).toEqual(["SC-20"]);
    expect(plan.last.map((scenario) => scenario.id)).toEqual(["SC-16"]);
  });

  it("skips what is left once the turn budget is spent, and says why", async () => {
    const driver = fakeDriver({}, 30);
    const scenarios = ["SC-01", "SC-02", "SC-03"].map((id) => scenarioOf(id, [{ id: "1", ...body("det", "preset") }]));
    const report = await runSuite({ ...options(driver, scenarios), maxTurns: 50, parallel: 1 });
    expect(report.scenarios.map((scenario) => scenario.verdict)).toEqual(["PASS", "PASS", "SKIPPED"]);
    expect(report.budget.aborted).toContain("turn budget of 50");
    expect(report.usage.turns).toBe(60);
    expect(report.usage.estimatedCostUsd).toBe(1);
  });

  it("stops on the cost budget too", async () => {
    const driver = fakeDriver();
    const scenarios = ["SC-01", "SC-02"].map((id) => scenarioOf(id, [{ id: "1", ...body("det", "preset") }]));
    const report = await runSuite({ ...options(driver, scenarios), maxCostUsd: 0.4, parallel: 1 });
    expect(report.scenarios.map((scenario) => scenario.verdict)).toEqual(["PASS", "SKIPPED"]);
    expect(report.budget.aborted).toContain("cost budget");
  });
});
