import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALARM_PREFIX, ALARM_SCOPES, BUDGET_SCOPES } from "../packages/bff/src/handlers/cost-guard";
import { testConnector } from "../packages/bff/src/connector/testing";
import { createLogger } from "../packages/bff/src/lib/log";
import { capMetric, planCounters } from "../packages/bff/src/ops/cost-caps";
import { MODEL_RATES, bedrockRateKey } from "../packages/bff/src/services/ratecard/ratecard";
import { recordTurnKpi } from "../packages/bff/src/turns/record";
import { TOOL_LAMBDAS } from "./agentcore-spec";
import { IAM_ARNS, LAMBDA_CAPABILITIES, QA_DRIVER_DLQ_ONLY_ACTIONS, expectedGrants, managedPolicies, type LambdaName } from "./iam-capabilities";
import {
  AGENT_SPEND_ALARM_USD_PER_HOUR,
  CERTIFICATE_WRITER,
  COST_ALARMS,
  LINK_CARRIED_RESOURCES,
  METRIC_FILTERS,
  POLICY_AUDIT,
  PROJECT_BUDGET,
  QA_DRIVER,
  RESERVED_CONCURRENCY,
  STATEMENT_REFS,
  WP38_HANDLERS,
  budgetCostFilter,
  budgetName,
  budgetNotifications,
  budgetSubscribers,
  carriedResources,
  costAlarmName,
  linkCarried,
  metricFilterName,
  qaDriverFunctionName,
  qaRunnerRoleName,
  statementGrants,
} from "./observability-spec";
import { parseStorageRef, storageFor } from "./storage-keys";
import { EDGE_BUDGETS } from "./web-spec";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const architecture = read("docs/architecture.md");
const section12 = architecture.slice(architecture.indexOf("## 12."), architecture.indexOf("## 13."));
const bullet = (label: string) => section12.split("\n").find((line) => line.startsWith(`- **${label}`)) ?? "";

describe("metric filters: only what a cutting alarm or a scenario step reads (ADR-0028, §12)", () => {
  it("are exactly the ones §12 lists, SignupStarted being the sign-up cut's (infra/cost-guard.ts)", () => {
    const sentence = bullet("Metric filters").split(". Las cifras")[0] ?? "";
    const listed = [...sentence.matchAll(/`([A-Z][a-z][A-Za-z]+)(?:\{[^}]*\})?`/g)].map((match) => match[1]);
    expect([...METRIC_FILTERS.map((spec) => spec.metric), "SignupStarted"].sort()).toEqual([...new Set(listed)].sort());
    expect(read("infra/cost-guard.ts")).toContain('pattern: `{ $.metric = "${SIGNUP_STARTED_METRIC}" }`');
  });

  it("each one names Lambdas of infra/iam-capabilities.ts and a unique filter per log group", () => {
    const names = METRIC_FILTERS.flatMap((spec) => spec.emitters.map((emitter) => metricFilterName(spec.metric, emitter)));
    expect(new Set(names).size).toBe(names.length);
    for (const spec of METRIC_FILTERS) for (const emitter of spec.emitters) expect(Object.keys(LAMBDA_CAPABILITIES), spec.metric).toContain(emitter);
  });

  it("matches the log lines the code writes today; the ones still pending name their work package", () => {
    for (const spec of METRIC_FILTERS) {
      expect(spec.pattern).toContain(`$.metric = "${spec.metric}"`);
      if (spec.source === undefined) {
        expect(spec.pendingIn, spec.metric).toMatch(/^WP-\d+$/);
        continue;
      }
      expect(existsSync(resolve(process.cwd(), spec.source)), spec.source).toBe(true);
      expect(read(spec.source), spec.metric).toContain(`"${spec.metric}"`);
    }
    const caps = read("packages/bff/src/ops/cost-caps.ts");
    expect(caps).toContain('if (counter.resource === "turns") return { metric: "TurnCapHits", scope };');
    expect(caps).toContain('action: "KILL_SWITCH_ACTIVE", metric: "KillSwitchActive"');
    expect(read("packages/bff/src/routers/edge.ts")).toContain('{ metric: "OriginRejected", value: 1 }');
  });

  it("[W3 review flows B1] never leaves a metric an alarm cuts with pending: the code writes every one of them today", () => {
    for (const spec of METRIC_FILTERS.filter((filter) => filter.readBy === "alarm")) {
      expect(spec.pendingIn, spec.metric).toBeUndefined();
      expect(spec.source, spec.metric).toBeDefined();
    }
    expect(read("packages/bff/src/turns/record.ts")).toContain('deps.log.info("metric", { metric: AGENT_SPEND_METRIC, value: usd');
  });

  it("counts only the global ceiling of turns and only refused spends of a kill switch", () => {
    const turnCaps = METRIC_FILTERS.find((spec) => spec.metric === "TurnCapHits");
    expect(turnCaps).toMatchObject({ pattern: '{ $.metric = "TurnCapHits" && $.scope = "GLOBAL" }', dimensions: { scope: "$.scope" }, readBy: "alarm" });
    expect(METRIC_FILTERS.find((spec) => spec.metric === "KillSwitchActive")?.pattern).toContain('$.action = "KILL_SWITCH_ACTIVE"');
    expect(METRIC_FILTERS.find((spec) => spec.metric === "AgentSpendUsd")).toMatchObject({ value: "$.value", unit: "None" });
  });
});

/** A CloudWatch JSON filter of the form `{ $.a = "x" && $.b = "y" }` applied to a log line. */
function matchesFilter(pattern: string, line: Readonly<Record<string, unknown>>): boolean {
  const terms = [...pattern.matchAll(/\$\.([A-Za-z]+) = "([^"]*)"/g)];
  expect(terms.length, pattern).toBeGreaterThan(0);
  return terms.every(([, field, value]) => line[field as string] === value);
}

describe("[W3 review B1] a QA world's test ceiling never counts as the stage's global ceiling", () => {
  it("logs scope GLOBAL_TEST for a globalCapsOverride hit, which the TurnCapHits filter of the cut does not match", () => {
    const pattern = METRIC_FILTERS.find((spec) => spec.metric === "TurnCapHits")?.pattern ?? "";
    const caps = { turnsPerDay: 1500, validationsPerDay: 300, transcribeSecondsPerDay: 3600 };
    const now = new Date("2026-10-20T15:00:00Z");
    const plan = (clockId: string, settings: object) => planCounters({ world: { clockId, settings }, resource: "turns", amount: 1, reserve: ["GLOBAL"] }, caps, now);
    const [test] = plan("qa-812-1-sc12-global", { globalCapsOverride: { turnsPerDay: 2 } });
    const [real] = plan("GLOBAL#isp-demo", {});
    expect(test?.key).toBe("TURNCAP#GLOBAL#qa-812-1-sc12-global#2026-10-20");
    expect(test && matchesFilter(pattern, capMetric(test))).toBe(false);
    expect(test && capMetric(test)).toEqual({ metric: "TurnCapHits", scope: "GLOBAL_TEST" });
    expect(real && matchesFilter(pattern, capMetric(real))).toBe(true);
  });
});

/** Every metric line of a log stream, as JSON. */
async function spendLines(turns: ReadonlyArray<readonly [clockId: string, ispId: string]>, usage = NORMAL_TURN): Promise<Array<Record<string, unknown>>> {
  const world = testConnector();
  for (const kind of ["input", "output"] as const) {
    await world.connector.reference.put("RateCard", { key: bedrockRateKey(kind), price: MODEL_RATES.prices[kind], unit: "PER_1M_TOKENS", provisional: false, source: MODEL_RATES.source, asOf: MODEL_RATES.asOf });
  }
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger({ level: "info", sink: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>) });
  for (const [clockId, ispId] of turns) {
    const request = { trigger: "INSTALLER_MESSAGE" as const, eventId: "evt", clockId, ispId, installerId: "inst-rogelio", workOrderId: "wo-24817", eventAtSim: "2026-10-13T09:15:00-06:00" };
    await recordTurnKpi({ data: world.connector, agentMode: "REAL", log }, request, usage, 1_000);
  }
  return lines;
}

/** The cost alarm's statistic over one period's lines, and whether it breaches. */
function costAlarmBreaches(lines: ReadonlyArray<Record<string, unknown>>): { readonly value: number; readonly breaches: boolean } {
  const alarm = COST_ALARMS.find((spec) => spec.suffix === "AgentSpendHourly");
  const filter = METRIC_FILTERS.find((spec) => spec.metric === alarm?.metric);
  if (alarm === undefined || filter === undefined) throw new Error("the cost alarm or its filter is missing");
  const samples = lines.filter((line) => matchesFilter(filter.pattern, line)).map((line) => Number(line[filter.value.slice(2)]));
  const value = alarm.statistic === "Sum" ? samples.reduce((sum, sample) => sum + sample, 0) : samples.reduce((sum, sample) => sum + sample, 0) / Math.max(1, samples.length);
  return { value, breaches: value > alarm.threshold };
}

/** 50 k input and 2 k output tokens: USD 0.12 at USD 2/10 per M, a long Harness turn with its preloads. */
const NORMAL_TURN = { inputTokens: 50_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
const times = <T,>(count: number, value: T): T[] => Array.from({ length: count }, () => value);

describe("[W3R1 N1] the hourly spend cut: one conversation never cuts the agent of the stage", () => {
  it("sums each turn's own spend, so the alarm is the spend rate and never a running total repeated per turn", () => {
    const alarm = COST_ALARMS.find((spec) => spec.metric === "AgentSpendUsd");
    expect(alarm).toMatchObject({ statistic: "Sum", periodSeconds: 3600, threshold: AGENT_SPEND_ALARM_USD_PER_HOUR });
    expect(ALARM_SCOPES[alarm?.suffix ?? ""]).toBe("AGENT");
  });

  it("a 40-turn guest conversation (sign-up world or invited) logs no spend sample and never trips it, however costly its turns", async () => {
    const heavy = { ...NORMAL_TURN, inputTokens: 400_000, outputTokens: 40_000 };
    for (const world of [["GUEST#isp-guest-s261009abcde", "isp-guest-s261009abcde"], ["GUEST#isp-guest-07", "isp-guest-07"]] as const) {
      const lines = await spendLines(times(40, world), heavy);
      expect(costAlarmBreaches(lines)).toEqual({ value: 0, breaches: false });
    }
  });

  it("a 40-turn conversation of the demo world at a normal turn cost stays under the budget; a sustained overspend trips it", async () => {
    const long = costAlarmBreaches(await spendLines(times(40, ["GLOBAL#isp-demo", "isp-demo"] as const)));
    expect(long.value).toBeCloseTo(40 * 0.12, 6);
    expect(long.breaches).toBe(false);
    const runaway = costAlarmBreaches(await spendLines(times(200, ["GLOBAL#isp-demo", "isp-demo"] as const)));
    expect(runaway.breaches).toBe(true);
  });
});

describe("alarms: only the cost cut, all on CostAlerts and in CostGuard's closed table (ADR-0019) [FL-100]", () => {
  it("every metric an alarm reads has its alarm, and every alarm watches a filtered metric", () => {
    const byAlarm = METRIC_FILTERS.filter((spec) => spec.readBy === "alarm").map((spec) => spec.metric);
    expect(COST_ALARMS.map((alarm) => alarm.metric).sort()).toEqual(byAlarm.sort());
    const global = COST_ALARMS.find((alarm) => alarm.metric === "TurnCapHits");
    expect(global).toMatchObject({ suffix: "TurnCapHitsGlobal", dimensions: { scope: "GLOBAL" }, threshold: 0, comparison: "GreaterThanThreshold" });
  });

  it("CostGuard turns KILL#AGENT on for each cost alarm and for the budget, by the same names", () => {
    for (const alarm of COST_ALARMS) expect(ALARM_SCOPES[alarm.suffix], alarm.suffix).toBe("AGENT");
    expect(BUDGET_SCOPES[PROJECT_BUDGET.suffix]).toBe("AGENT");
    expect(costAlarmName("")).toBe(ALARM_PREFIX);
    expect(budgetName()).toBe(`${ALARM_PREFIX}${PROJECT_BUDGET.suffix}`);
  });

  it("infra/observability.ts builds no dashboard and every alarm publishes on CostAlerts", () => {
    const source = read("infra/observability.ts");
    expect(source).not.toMatch(/cloudwatch\.Dashboard/);
    const blocks = source.split("new aws.cloudwatch.MetricAlarm(").slice(1);
    expect(blocks).toHaveLength(1);
    for (const block of blocks) expect(block.slice(0, block.indexOf("});"))).toContain("alarmActions: [costAlerts.arn],");
    expect(source).toContain("created.nodes.logGroup.apply");
    for (const file of ["infra/bff.ts", "infra/certificates.ts"]) expect(read(file)).not.toMatch(/cloudwatch\.(MetricAlarm|Dashboard)/);
  });
});

describe("project budget (§12, ADR-0019)", () => {
  it("is inside the CI role's budget fence and filters by the cost allocation tag Project", () => {
    expect(budgetName("aws-cds-hackathon-poc-cuadrilla", "poc")).toBe("aws-cds-hackathon-poc-cuadrilla-poc-monthly");
    expect(read("infra/bootstrap/ci-role.yaml")).toContain('budget/${AppName}-*"');
    expect(budgetCostFilter("aws-cds-hackathon-poc-cuadrilla")).toEqual({ name: "TagKeyValue", values: ["user:Project$aws-cds-hackathon-poc-cuadrilla"] });
  });

  it("notifies the operator at 50, 80 and 100 % and CostAlerts only at 100 %", () => {
    const notices = budgetNotifications(["ops@example.org"], "topic");
    expect(notices.map((notice) => [notice.threshold, notice.subscriberEmailAddresses, notice.subscriberSnsTopicArns])).toEqual([
      [50, ["ops@example.org"], undefined],
      [80, ["ops@example.org"], undefined],
      [100, ["ops@example.org"], ["topic"]],
    ]);
    for (const notice of notices) expect(notice).toMatchObject({ notificationType: "ACTUAL", thresholdType: "PERCENTAGE", comparisonOperator: "GREATER_THAN" });
    expect(budgetNotifications([], "topic")).toEqual([{ comparisonOperator: "GREATER_THAN", notificationType: "ACTUAL", threshold: 100, thresholdType: "PERCENTAGE", subscriberSnsTopicArns: ["topic"] }]);
  });

  it("reads operatorEmail from SeedOverrides and never echoes the secret", () => {
    expect(budgetSubscribers("{}")).toEqual([]);
    expect(budgetSubscribers('{"operatorEmail":"Success+Op@Simulator.AmazonSES.com"}')).toEqual(["success+op@simulator.amazonses.com"]);
    expect(() => budgetSubscribers("not json secret-value")).toThrow(/value not shown/);
    expect(() => budgetSubscribers('{"operatorEmail":"secret-value"}')).toThrow(/value not shown/);
    try {
      budgetSubscribers('{"operatorEmail":"secret-value"}');
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});

describe("the functions of infra/bff.ts and infra/certificates.ts", () => {
  const plan = read("docs/build-plan.md");

  it("point at handlers of the work packages that own them", () => {
    for (const [fn, wp] of [["CertificateWriter", "WP-35"], ["PolicyAudit", "WP-40"], ["QaDriver", "WP-45"]] as const) {
      const file = `\`${WP38_HANDLERS[fn].replace(/\.handler$/, "")}.ts\``;
      const at = plan.indexOf(file);
      expect(at, fn).toBeGreaterThan(0);
      expect([...plan.slice(0, at).matchAll(/\*\*(WP-\d+) ·/g)].at(-1)?.[1], fn).toBe(wp);
    }
  });

  it("names the QaDriver as the bootstrap fences it and only the qa-runner invokes it", () => {
    expect(qaDriverFunctionName()).toBe("aws-cds-hackathon-poc-cuadrilla-poc-qa-driver");
    expect(IAM_ARNS.qaDriver.endsWith(`:function:${qaDriverFunctionName()}`)).toBe(true);
    const bootstrap = read("infra/bootstrap/ci-role.yaml");
    expect(bootstrap).toContain('RoleName: !Sub "${AppName}-qa-runner"');
    expect(qaRunnerRoleName()).toBe("aws-cds-hackathon-poc-cuadrilla-qa-runner");
    expect(read("infra/bff.ts")).toContain("principal: `arn:aws:iam::${account}:role/${qaRunnerRoleName($app.name)}`");
  });

  it("gives the driver room for the longest wait of a step and audits daily at 03:00 in Mexico City", () => {
    expect(QA_DRIVER.timeoutSeconds).toBeGreaterThan(600);
    expect(QA_DRIVER.timeoutSeconds).toBeLessThanOrEqual(900);
    expect(POLICY_AUDIT).toMatchObject({ schedule: "cron(0 9 * * ? *)", event: { kind: "DAILY" } });
    expect(CERTIFICATE_WRITER).toEqual({ timeoutSeconds: 30, memoryMb: 1024, reservedConcurrency: 5 });
    expect(architecture).toContain("invoca `CertificateWriter` (Lambda propia, 1024 MB, timeout 30 s)");
  });

  it("keeps the reserved concurrency of §12 in every module that sets it", () => {
    const line = section12.split("\n").find((text) => text.startsWith("- Concurrencia:")) ?? "";
    const documented = Object.fromEntries([...line.matchAll(/`([A-Za-z]+)` (\d+)/g)].map((match) => [match[1], Number(match[2])]));
    expect(documented).toEqual(RESERVED_CONCURRENCY);
    expect(EDGE_BUDGETS.bff.reservedConcurrency).toBe(RESERVED_CONCURRENCY.Bff);
    expect(TOOL_LAMBDAS.evidence.reservedConcurrency).toBe(RESERVED_CONCURRENCY.ToolEvidence);
    expect(CERTIFICATE_WRITER.reservedConcurrency).toBe(RESERVED_CONCURRENCY.CertificateWriter);
    expect(read("infra/messaging-whatsapp.ts")).toContain(`concurrency: { reserved: ${RESERVED_CONCURRENCY.InboundWhatsApp} }`);
    expect(read("infra/cost-guard.ts")).toContain(`concurrency: { reserved: ${RESERVED_CONCURRENCY.CostGuard} }`);
  });
});

describe("every grant of the four roles is a link or a statement nobody can widen (§14)", () => {
  const ROLES: LambdaName[] = ["Bff", "QaDriver", "PolicyAudit", "CertificateWriter"];
  const resolvable = (resource: string) =>
    parseStorageRef(resource) !== undefined || /^\{Leads\}(\/index\/\*)?$/.test(resource) || (STATEMENT_REFS as readonly string[]).includes(resource) || resource.startsWith("arn:aws:");

  it.each(ROLES)("%s: each statement or managed policy names storage, Leads, the stage's pool or web ACLs, or an exact ARN", (fn) => {
    const managed = Object.values(managedPolicies(fn)).flat();
    for (const grant of [...statementGrants(fn), ...managed]) for (const resource of grant.resources) expect(resolvable(resource), `${fn}: ${resource}`).toBe(true);
    const all = expectedGrants(fn);
    expect([...statementGrants(fn), ...all.filter(linkCarried), ...managed].length).toBe(all.length);
  });

  it.each(ROLES)("%s: a link carries only the role that link grants", (fn) => {
    const carried = expectedGrants(fn).filter((grant) => linkCarried(grant) && grant.resources.every((resource) => (LINK_CARRIED_RESOURCES as readonly string[]).includes(resource)));
    for (const grant of carried) {
      const [resource] = grant.resources;
      const expected = expectedActionsOf(resource ?? "");
      expect([...grant.actions].sort(), `${fn}: ${resource}`).toEqual(expected);
    }
  });

  it("links a bucket by name only where the role's data access does not already link it (no duplicate link)", () => {
    for (const fn of ["Bff", "QaDriver"] as const) expect(storageFor(fn).buckets, fn).not.toContain("Seed");
    for (const fn of ["PolicyAudit", "CertificateWriter"] as const) expect(storageFor(fn).buckets, fn).not.toContain("Evidence");
    const source = read("infra/bff.ts");
    expect(source).toContain('roleAccess("PolicyAudit", [evidenceBucket])');
    expect(read("infra/certificates.ts")).toContain("[...storageLinks(WRITER), evidenceBucket, GuardrailG3, BrandConfig]");
  });

  it("keeps SES, End User Messaging, Bedrock and Cognito away from the Bff's statements", () => {
    expect(JSON.stringify(statementGrants("Bff"))).not.toMatch(/"(ses|social-messaging|bedrock|bedrock-agentcore|cognito-idp):/);
    expect(carriedResources("Bff")).toEqual(["{GuestAccountDeletion}", "{GuestWorlds}", "{InboundWhatsApp}", "{InstallerEvents}", "{WorldJanitor}"]);
  });

  it("gives CertificateWriter only its Evidence prefixes as statements and G3 by link", () => {
    expect(statementGrants("CertificateWriter").flatMap((grant) => grant.resources).sort()).toEqual(["{Evidence}/certificates/*", "{Evidence}/guest/*/certificates/*", "{Evidence}/guest/*/photos/*", "{Evidence}/photos/*"]);
    expect(carriedResources("CertificateWriter")).toEqual(["{G3}"]);
  });

  it("links the QaDriver to the DLQ, the entries and the targets it probes, and PolicyAudit to nothing", () => {
    expect(carriedResources("QaDriver")).toEqual(expect.arrayContaining(["{InstallerEventsDlq}", "{PolicyAudit}", "{ToolCases}", "{G1}", IAM_ARNS.waTopic]));
    expect(carriedResources("PolicyAudit")).toEqual([]);
  });
});

function expectedActionsOf(resource: string): string[] {
  if (resource === "{InstallerEvents}") return ["sqs:SendMessage"];
  if (resource === "{InstallerEventsDlq}") return [...QA_DRIVER_DLQ_ONLY_ACTIONS].sort();
  if (resource === "{G1}" || resource === "{G3}") return ["bedrock:ApplyGuardrail"];
  if (resource === IAM_ARNS.waTopic) return ["sns:Publish"];
  return ["lambda:InvokeFunction"];
}

