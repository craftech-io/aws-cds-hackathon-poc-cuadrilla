// The options of `npm run scenarios` (no AWS): the run id of CI and of a laptop, the budget per suite, and
// refusals of what the runner cannot honour.
import { describe, expect, it } from "vitest";
import { RunId } from "../../../packages/bff/src/qa-driver/contract";
import { localRunId, parseCli, runIdOf } from "./cli";

describe("parseCli", () => {
  it("defaults to the smoke suite and takes the run id of GitHub", () => {
    const options = parseCli([], { GITHUB_RUN_ID: "812345", GITHUB_RUN_ATTEMPT: "2" });
    expect(options).toMatchObject({ suite: "smoke", runId: "812345-2", parallel: 4, reportDir: "scenario-report", dryRun: false, liveOperator: false, livePhoto: "NOT_PASS" });
  });

  it("gives each suite its budget of §4.4 and reads the rest", () => {
    expect(parseCli(["--suite", "full"], { GITHUB_RUN_ID: "1" }).maxTurns).toBe(400);
    expect(parseCli(["--suite", "eval"], { GITHUB_RUN_ID: "1" }).maxTurns).toBe(120);
    const options = parseCli(["--suite", "full", "--only", "sc-04, SC-05", "--max-turns", "90", "--max-cost-usd", "12.5", "--parallel", "2", "--bff-url", "https://example.invalid", "--run-id", "77-1"]);
    expect(options).toMatchObject({ only: ["SC-04", "SC-05"], maxTurns: 90, maxCostUsd: 12.5, parallel: 2, bffUrl: "https://example.invalid", runId: "77-1" });
    expect(parseCli(["--suite", "eval", "--only", "ev-02", "--max-validations", "80", "--run-id", "77-1"])).toMatchObject({ only: ["EV-02"], maxValidations: 80 });
  });

  it("refuses an unknown suite, a bad number, more than four in parallel and a bad run id", () => {
    expect(() => parseCli(["--suite", "nightly"])).toThrow(/--suite/);
    expect(() => parseCli(["--max-turns", "-3"])).toThrow(/--max-turns/);
    expect(() => parseCli(["--parallel", "8"])).toThrow(/--parallel/);
    expect(() => parseCli(["--run-id", "../etc"])).toThrow();
    expect(() => parseCli(["--live-photo", "MAYBE"])).toThrow(/--live-photo/);
    expect(() => parseCli(["--unknown"])).toThrow();
  });
});

describe("run ids", () => {
  it("makes a local id the driver accepts, time first", () => {
    const first = localRunId(1_760_000_000_000, Buffer.alloc(16, 1));
    const later = localRunId(1_760_000_100_000, Buffer.alloc(16, 1));
    expect(RunId.safeParse(first).success).toBe(true);
    expect(first < later).toBe(true);
    expect(RunId.safeParse(runIdOf(undefined, {})).success).toBe(true);
  });
});
