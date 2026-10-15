// Observability is logs only (ADR-0028, docs/architecture.md §12): JSON logs kept 30 days in every group,
// no dashboard, no alarm and no budget (an alarm bills every month even when it never fires; P-07, closed
// by the CTO on 2026-10-14: no cost threshold, no agent spend alarm, no project budget). Anything that
// costs every month and that nobody reads fails here. The infra modules are read as text: the scan needs
// no Pulumi program and no AWS account.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_LOG_RETENTION_DAYS, DEFAULT_RUNTIME_LOG_RETENTION, RUNTIME_DEFAULT_ENDPOINT, RUNTIME_LOG_GROUP_PREFIX } from "./agentcore-spec";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

/** Every infra module that can create a resource: `infra/**\/*.ts` but tests, plus sst.config.ts. */
function modules(dir = resolve(ROOT, "infra")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return modules(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [relative(ROOT, path)] : [];
  });
}

const SOURCES = [...modules(), "sst.config.ts"].map((file) => ({ file, text: read(file) }));

/** The text that opens at `from` (an index of `open`) up to its balanced `close`. */
function balanced(text: string, from: number, open = "(", close = ")"): string {
  let depth = 0;
  for (let index = from; index < text.length; index++) {
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return text.slice(from, index + 1);
  }
  throw new Error(`unbalanced ${open}${close}`);
}

/** Where `new <constructor>(` is called in a module, with its arguments. */
function calls(text: string, constructor: RegExp): string[] {
  return [...text.matchAll(new RegExp(`new ${constructor.source}\\(`, "g"))].map((match) => balanced(text, (match.index ?? 0) + match[0].length - 1));
}

/** Every resource that bills by the month whether or not it is used: alarms, dashboards and budgets. */
const FIXED_COST = /\b(?:aws|awsnative)\.(?:cloudwatch\.(?:MetricAlarm|CompositeAlarm|Alarm|Dashboard)|budgets\.Budget)\b|\bsst\.aws\.Dashboard\b/;

describe("logs only (ADR-0028, docs/architecture.md §12)", () => {
  it("scans every infra module", () => {
    expect(SOURCES.map(({ file }) => file)).toEqual(expect.arrayContaining(["infra/agentcore.ts", "infra/leads.ts", "infra/observability.ts", "sst.config.ts"]));
  });

  it("creates no alarm, no dashboard and no budget", () => {
    for (const { file, text } of SOURCES) expect(text, file).not.toMatch(FIXED_COST);
  });

  it("finds an alarm, a dashboard or a budget wherever a module would create one", () => {
    for (const text of ['new aws.cloudwatch.MetricAlarm("A", {});', 'new awsnative.cloudwatch.Alarm("B", {});', 'new aws.cloudwatch.Dashboard("C", {});', 'new aws.budgets.Budget("D", {});', 'new sst.aws.Dashboard("E");']) {
      expect(text).toMatch(FIXED_COST);
    }
  });

  it("keeps every log group 30 days: the functions by $transform, the live runtime group by the IaC", () => {
    expect(AGENT_LOG_RETENTION_DAYS).toBe(30);
    expect(read("sst.config.ts")).toContain('args.logging ??= { retention: "1 month" };');
    for (const { file, text } of SOURCES) {
      for (const args of calls(text, /aws\.cloudwatch\.LogGroup/)) expect(args, file).toMatch(/retentionInDays: (AGENT_LOG_RETENTION_DAYS|30),/);
    }
    expect(calls(read("infra/agentcore.ts"), /aws\.cloudwatch\.LogGroup/).join()).toContain("runtimeLogGroupName(id, endpoint)");
  });

  it("declares the DEFAULT runtime group's 30 days in infra/agentcore-spec.ts, with its apply and verify commands", () => {
    expect(DEFAULT_RUNTIME_LOG_RETENTION).toMatchObject({ modeledByProvider: false, retentionDays: 30, manualConfig: "docs/architecture.md §17 item 15" });
    expect(DEFAULT_RUNTIME_LOG_RETENTION.apply).toBe(`aws --profile craftech-demos logs put-retention-policy --log-group-name ${RUNTIME_LOG_GROUP_PREFIX}<runtimeId>-${RUNTIME_DEFAULT_ENDPOINT} --retention-in-days 30`);
    expect(DEFAULT_RUNTIME_LOG_RETENTION.verify).toMatch(/^aws --profile craftech-demos logs describe-log-groups --log-group-name-prefix \/aws\/bedrock-agentcore\/runtimes\/ /);
  });
});
