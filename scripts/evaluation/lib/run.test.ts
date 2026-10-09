// The measurements end to end at no cost: the runner's three steps through a local `QaDriver` whose actions
// are the evaluation's own over a world built in memory by the real factory (packages/bff/src/evaluation/
// testing.ts): the photos with the real `validate_install_photo` and the scripted validator, the questions
// with scripted answers. What a run against `poc` adds (the Harness, G1/G2, the Knowledge Base and the
// multimodal call) is proven there with the CTO's OK.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_ACTIONS } from "../../../packages/bff/src/evaluation/index";
import { questionSet } from "../../../packages/bff/src/evaluation/run-questions";
import { type EvalHarness, answeringChannel, evalHarness, idealAnswers } from "../../../packages/bff/src/evaluation/testing";
import { itemInstallerId } from "../../../packages/bff/src/evaluation/world-request";
import { tableEvalRuns } from "../../../packages/bff/src/metrics/eval-runs";
import { createWorld } from "../../../packages/bff/src/worlds/worlds";
import { runEv01 } from "../ev-01-manual";
import { runEv02 } from "../ev-02-photos";
import { runEvalSuite } from "./suite";
import type { EvalActionName, EvalDriver } from "./types";

interface LocalDriver extends EvalDriver {
  readonly calls: Array<{ readonly action: EvalActionName; readonly key: string; readonly items: number }>;
}

function localDriver(kit: EvalHarness, deps = kit.deps): LocalDriver {
  const calls: LocalDriver["calls"] = [];
  return {
    calls,
    async call(action, input, key) {
      const items = input as { questionIds?: unknown[]; photoIds?: unknown[] };
      calls.push({ action, key, items: (items.questionIds ?? items.photoIds ?? []).length });
      if (action === "world.create") return createWorld(kit.harness.deps, input);
      return EVAL_ACTIONS[action](deps, input);
    },
  };
}

const RUN = "local-1";

async function questionsKit(): Promise<EvalHarness> {
  let ideal: ReturnType<typeof idealAnswers> | undefined;
  const kit = await evalHarness("Q", {
    suiteRunId: RUN,
    channel: answeringChannel(async (world, installerId, questionId) => ideal?.(world, installerId, questionId)),
  });
  ideal = idealAnswers(await questionSet(kit.deps));
  return kit;
}

describe("EV-02 through the runner, locally [FL-036] [FL-037] [FL-038] [FL-039] [FL-040] [FL-041] [FL-043] [FL-097] [FL-087]", () => {
  it("[FL-087] creates the world, validates the 60 photos in batches, publishes the run and reports every threshold met", async () => {
    const kit = await evalHarness("P", { suiteRunId: RUN });
    const driver = localDriver(kit);
    const report = await runEv02({ suiteRunId: RUN, driver, now: () => kit.harness.now() });
    expect(driver.calls.map((call) => [call.action, call.key, call.items])).toEqual([
      ["world.create", "local-1/EV-02/1/m1", 0],
      ...[1, 2, 3, 4, 5].map((n) => ["eval.runPhotos", `local-1/EV-02/2/m${n}`, 12]),
      ["eval.runPhotos", "local-1/EV-02/3/m1", 0],
    ]);
    expect(report).toMatchObject({ id: "EV-02", runId: "local-1-p", clockId: "eval-local-1-p", n: 60, published: true, missing: [], errors: [], thresholdsMet: true });
    expect(report.thresholds.find((threshold) => threshold.name === "Validation accuracy")).toMatchObject({ value: "60/60 (100.0 %)", met: true });
    expect(report.thresholds.find((threshold) => threshold.name === "Adversarial photos accepted")).toMatchObject({ value: "0", met: true });
    expect(report.items.find((item) => item.itemId === "ph-adv-04")).toMatchObject({ outcome: "REJECT", passed: true, note: "reason DUPLICATE_EVIDENCE" });
    expect(report.cost.verified).toBe(true);
    expect(await tableEvalRuns(kit.harness.client).latest("P")).toMatchObject({ runId: "local-1-p" });
  }, 60_000);

  it("stops before a batch that would pass the validation budget, and does not publish", async () => {
    const kit = await evalHarness("P", { suiteRunId: RUN });
    const report = await runEv02({ suiteRunId: RUN, driver: localDriver(kit), maxValidations: 30 });
    expect(report).toMatchObject({ n: 24, published: false, thresholdsMet: false, aborted: "validation budget: 24 used, 30 allowed" });
    expect(report.missing).toHaveLength(36);
    expect(await tableEvalRuns(kit.harness.client).latest("P")).toBeUndefined();
  }, 60_000);
});

describe("EV-01 through the runner, locally [FL-028] [FL-029] [FL-030] [FL-032] [FL-087]", () => {
  it("[FL-087] creates the world, asks the 50 questions in batches, publishes the run and reports every threshold met", async () => {
    const kit = await questionsKit();
    const driver = localDriver(kit);
    const report = await runEv01({ suiteRunId: RUN, driver, now: () => kit.harness.now() });
    expect(driver.calls.filter((call) => call.action === "eval.runQuestions").map((call) => call.items)).toEqual([...Array.from({ length: 12 }, () => 4), 2, 0]);
    expect(report).toMatchObject({ id: "EV-01", runId: "local-1-q", n: 50, published: true, errors: [], neutralWords: 0, thresholdsMet: true });
    expect(report.thresholds.slice(0, 2).map((threshold) => [threshold.value, threshold.met])).toEqual([
      ["40/40 (100.0 %)", true],
      ["10/10 (100.0 %)", true],
    ]);
    expect(report.retrieve).toMatchObject({ n: 40, min: 0.68, max: 0.68, coverage: { FOUND: 40, NONE: 4 } });
    expect(report.items.filter((item) => item.note === "offer tapped").map((item) => item.itemId)).toEqual(["q-R-04", "q-R-05", "q-R-06", "q-R-09"]);
    expect(await tableEvalRuns(kit.harness.client).latest("Q")).toMatchObject({ runId: "local-1-q" });
  }, 60_000);

  it("retries a question that could not be run once, then publishes", async () => {
    const kit = await questionsKit();
    const flaky = itemInstallerId("eval-local-1-q", "q-A-03");
    let failures = 0;
    const deps = {
      ...kit.deps,
      channel: {
        ...kit.deps.channel,
        settleInstaller: async (input: { readonly installerId: string; readonly timeoutSec: number }) => {
          if (input.installerId === flaky && failures === 0) {
            failures += 1;
            throw Object.assign(new Error("settle timed out"), { code: "SETTLE_TIMEOUT" });
          }
        },
      },
    };
    const driver = localDriver(kit, deps);
    const report = await runEv01({ suiteRunId: RUN, driver });
    expect(driver.calls.map((call) => call.key)).toContain("local-1/EV-01/2/r14");
    expect(report).toMatchObject({ published: true, errors: [] });
  }, 60_000);

  it("stops before a batch that would pass the turn budget", async () => {
    const kit = await questionsKit();
    const report = await runEv01({ suiteRunId: RUN, driver: localDriver(kit), maxTurns: 10 });
    expect(report).toMatchObject({ n: 4, published: false, thresholdsMet: false, aborted: "turn budget: 4 used, 10 allowed" });
    expect(report.missing).toHaveLength(46);
  }, 60_000);
});

describe("the eval suite", () => {
  it("writes each report as JSON and Markdown", async () => {
    const kit = await evalHarness("P", { suiteRunId: RUN });
    const dir = mkdtempSync(join(tmpdir(), "eval-reports-"));
    const [report] = await runEvalSuite({ suiteRunId: RUN, driver: localDriver(kit), reportDir: dir, only: ["EV-02"] });
    expect(report?.id).toBe("EV-02");
    expect(existsSync(join(dir, "EV-02-local-1-p.json"))).toBe(true);
    expect(readFileSync(join(dir, "EV-02-local-1-p.md"), "utf8")).toContain("| Validation accuracy | ≥ 54 of 60 (90 %) | 60/60 (100.0 %) | MET |");
  }, 60_000);
});
