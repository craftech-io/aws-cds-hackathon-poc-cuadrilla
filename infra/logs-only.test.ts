// Observability is logs only (ADR-0028, docs/architecture.md §12): JSON logs kept 30 days in every group,
// no dashboard, and an alarm only where it trips a cut (it publishes to `CostAlerts`, which `CostGuard`
// turns into a kill switch). Anything that costs every month and that nobody reads fails here. The infra
// modules are read as text: the scan needs no Pulumi program and no AWS account.
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

const ALARM = /(?:aws|awsnative)\.cloudwatch\.(?:MetricAlarm|CompositeAlarm|Alarm)/;
const ALARM_ACTIONS = /alarmActions: \[([^\]]*)\]/;

/** The `alarmActions` of an alarm: written in its arguments, or in an object spread into them (`...common`). */
function alarmActions(text: string, args: string): string | undefined {
  const inline = ALARM_ACTIONS.exec(args)?.[1];
  if (inline !== undefined) return inline;
  for (const [, name] of args.matchAll(/\.\.\.(\w+)\b/g)) {
    const declaration = new RegExp(`const ${name ?? ""}\\b[^=]*= \\{`).exec(text);
    if (declaration === null) continue;
    const spread = ALARM_ACTIONS.exec(balanced(text, declaration.index + declaration[0].length - 1, "{", "}"))?.[1];
    if (spread !== undefined) return spread;
  }
  return undefined;
}

describe("logs only (ADR-0028, docs/architecture.md §12)", () => {
  it("scans every infra module", () => {
    expect(SOURCES.map(({ file }) => file)).toEqual(expect.arrayContaining(["infra/agentcore.ts", "infra/cost-guard.ts", "infra/leads.ts", "infra/observability.ts", "sst.config.ts"]));
  });

  it("creates no dashboard", () => {
    for (const { file, text } of SOURCES) expect(text, file).not.toMatch(/\b(?:aws|awsnative)\.cloudwatch\.Dashboard\b|sst\.aws\.Dashboard\b/);
  });

  it("creates an alarm only when it publishes to CostAlerts, which CostGuard turns into a cut", () => {
    const alarms = SOURCES.flatMap(({ file, text }) => calls(text, ALARM).map((args) => ({ file, name: /^\("(\w+)"/.exec(args)?.[1] ?? "?", actions: alarmActions(text, args) })));
    // The four alarms of the sign-up cut (ADR-0025 §4) exist since wave 2b: the scan is not empty.
    expect(alarms.filter(({ file }) => file === "infra/cost-guard.ts").length).toBeGreaterThanOrEqual(4);
    for (const { file, name, actions } of alarms) {
      expect(actions, `${file} ${name} has no alarmActions`).toBeDefined();
      expect(actions, `${file} ${name}`).toMatch(/^\s*costAlerts\.arn\s*$/);
    }
    expect(read("infra/cost-guard.ts")).toMatch(/new sst\.aws\.SnsTopic\("CostAlerts"/);
  });

  it("finds an alarm with no action, inline or behind a spread", () => {
    const text = 'const common = { evaluationPeriods: 1 };\nnew aws.cloudwatch.MetricAlarm("A", { ...common, threshold: 0 });\nnew aws.cloudwatch.MetricAlarm("B", { alarmActions: [costAlerts.arn] });';
    const found = calls(text, ALARM).map((args) => alarmActions(text, args));
    expect(found).toEqual([undefined, "costAlerts.arn"]);
    const spread = 'const common = {\n  alarmActions: [costAlerts.arn],\n  evaluationPeriods: 1,\n};\nnew aws.cloudwatch.MetricAlarm("C", { ...common });';
    expect(calls(spread, ALARM).map((args) => alarmActions(spread, args))).toEqual(["costAlerts.arn"]);
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
