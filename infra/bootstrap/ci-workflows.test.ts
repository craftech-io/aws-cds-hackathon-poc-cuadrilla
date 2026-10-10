import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { read } from "./template-text";

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly "timeout-minutes"?: number;
  readonly "continue-on-error"?: boolean;
}

interface Job {
  readonly needs?: string | readonly string[];
  readonly "timeout-minutes"?: number;
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": boolean };
  readonly steps: readonly Step[];
}

interface Workflow {
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": boolean };
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

const workflow = (name: string): Workflow => parse(read(`.github/workflows/${name}`)) as Workflow;
const deploy = workflow("deploy.yml");
const scenarios = workflow("scenarios.yml");
const job = (source: Workflow, name: string): Job => {
  const found = source.jobs[name];
  expect(found, name).toBeDefined();
  return found as Job;
};
const deployJob = job(deploy, "deploy");
const preflight = job(scenarios, "preflight");
const stepNamed = (owner: Job, name: string): Step => {
  const found = owner.steps.find((step) => step.name === name);
  expect(found, name).toBeDefined();
  return found as Step;
};
const isCredentials = (step: Step): boolean => (step.uses ?? "").startsWith("aws-actions/configure-aws-credentials");
const runsSstDeploy = (step: Step): boolean => (step.run ?? "").includes("npx sst deploy --stage poc");

describe("deploy.yml never times out with the SST lock held", () => {
  it("gives the job room for two deploys, the seed and the smoke", () => {
    expect(deployJob["timeout-minutes"]).toBeGreaterThanOrEqual(90);
  });

  it("never puts a step timeout on sst deploy, and bounds every step after it", () => {
    const deploys = deployJob.steps.filter(runsSstDeploy);
    expect(deploys).toHaveLength(2);
    for (const step of deploys) expect(step["timeout-minutes"], step.name).toBeUndefined();
    for (const name of ["Load the synthetic seed and the manual into poc (idempotent, ingests the Knowledge Base on change)", "Smoke scenarios (SC-00, SMK/9 and SMK/10 from this runner)"]) {
      expect(stepNamed(deployJob, name)["timeout-minutes"], name).toBeGreaterThan(0);
    }
  });

  it("retries once, only after a failed first deploy and with a fresh deploy-role session", () => {
    const [first, retry] = deployJob.steps.filter(runsSstDeploy);
    expect(first?.["continue-on-error"]).toBe(true);
    expect(retry?.if).toContain(`steps.${first?.id ?? "?"}.outcome == 'failure'`);
    const before = deployJob.steps.slice(0, deployJob.steps.indexOf(retry as Step)).reverse().find(isCredentials);
    expect(before?.if).toBe(retry?.if);
    expect(before?.with?.["role-to-assume"]).toContain("github-deploy");
  });

  it("renews the deploy-role session before the seed", () => {
    const seed = deployJob.steps.findIndex((step) => (step.run ?? "").includes("npm run seed:load"));
    const previous = deployJob.steps[seed - 1];
    expect(previous && isCredentials(previous)).toBe(true);
    expect(previous?.with?.["role-to-assume"]).toContain("github-deploy");
  });

  it("marks the stage deployed only after a successful deploy, for the report steps", () => {
    const marker = deployJob.steps.find((step) => step.id === "sst");
    expect(marker?.if).toBeUndefined();
    const index = deployJob.steps.indexOf(marker as Step);
    expect(deployJob.steps.slice(0, index).filter(runsSstDeploy)).toHaveLength(2);
  });
});

describe("a suite never runs during a deploy", () => {
  it("shares one concurrency group between deploy.yml and every suite job, never cancelling", () => {
    expect(deploy.concurrency).toEqual({ group: "poc-stage", "cancel-in-progress": false });
    expect(scenarios.concurrency).toBeUndefined();
    for (const name of ["scenarios", "measurements"]) {
      const suite = job(scenarios, name);
      expect(suite.concurrency, name).toEqual(deploy.concurrency);
      expect(suite.needs, name).toBe("preflight");
    }
  });

  it("keeps the preflight outside the group, failing while deploy.yml is queued or running", () => {
    expect(preflight.concurrency).toBeUndefined();
    expect(scenarios.permissions.actions).toBe("read");
    const check = stepNamed(preflight, "No deploy of poc is queued or running");
    expect(check.run).toContain("--workflow deploy.yml");
    expect(check.run).toContain('select(.status != "completed")');
    expect(check.run).toContain("exit 1");
  });
});

describe("the qa-runner session never asks for more than the role allows", () => {
  const guard = stepNamed(preflight, "The qa-runner session fits the role's MaxSessionDuration");
  const runGuard = (value: string | undefined): { status: number | null; output: string } => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", BOOTSTRAP_TEMPLATE: guard.env?.BOOTSTRAP_TEMPLATE ?? "" };
    if (value !== undefined) env.QA_RUNNER_SESSION_SECONDS = value;
    const result = spawnSync("bash", ["-e", "-c", guard.run ?? "exit 99"], { cwd: process.cwd(), env, encoding: "utf8" });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  it("reads the repository variable and the bootstrap template", () => {
    expect(guard.env?.QA_RUNNER_SESSION_SECONDS).toBe("${{ vars.QA_RUNNER_SESSION_SECONDS }}");
    expect(guard.env?.BOOTSTRAP_TEMPLATE).toBe("infra/bootstrap/ci-role.yaml");
  });

  it.each([
    ["unset (3600 by default)", undefined],
    ["empty", ""],
    ["the role maximum", "7200"],
    ["the minimum", "900"],
  ])("passes when the variable is %s", (_case, value) => {
    expect(runGuard(value).status).toBe(0);
  });

  it("fails fast, naming both numbers, above the role's MaxSessionDuration", () => {
    const { status, output } = runGuard("7201");
    expect(status).toBe(1);
    expect(output).toContain("::error::QA_RUNNER_SESSION_SECONDS is 7201 s, more than the qa-runner role's MaxSessionDuration (7200 s");
  });

  it.each([["below the STS minimum", "899"], ["not a number", "2h"]])("fails when the variable is %s", (_case, value) => {
    const { status, output } = runGuard(value);
    expect(status).toBe(1);
    expect(output).toContain("::error::QA_RUNNER_SESSION_SECONDS must be a whole number of seconds");
  });

  it("asks for the variable's session in both suite jobs", () => {
    for (const name of ["scenarios", "measurements"]) {
      const credentials = job(scenarios, name).steps.find(isCredentials);
      expect(credentials?.with?.["role-duration-seconds"], name).toBe("${{ vars.QA_RUNNER_SESSION_SECONDS || 3600 }}");
    }
  });
});
