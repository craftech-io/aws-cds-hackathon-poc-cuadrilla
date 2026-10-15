import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_LAMBDAS } from "./agentcore-spec";
import { IAM_ARNS, LAMBDA_CAPABILITIES, QA_DRIVER_DLQ_ONLY_ACTIONS, expectedGrants, managedPolicies, type LambdaName } from "./iam-capabilities";
import {
  CERTIFICATE_WRITER,
  LINK_CARRIED_RESOURCES,
  METRIC_FILTERS,
  POLICY_AUDIT,
  QA_DRIVER,
  RESERVED_CONCURRENCY,
  STATEMENT_REFS,
  WP38_HANDLERS,
  carriedResources,
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

describe("metric filters: only what a scenario step reads (ADR-0028, §12)", () => {
  it("are exactly the ones §12 lists", () => {
    const sentence = bullet("Metric filters").split(". Las cifras")[0] ?? "";
    const listed = [...sentence.matchAll(/`([A-Z][a-z][A-Za-z]+)(?:\{[^}]*\})?`/g)].map((match) => match[1]);
    expect(METRIC_FILTERS.map((spec) => spec.metric).sort()).toEqual([...new Set(listed)].sort());
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
    expect(read("packages/bff/src/ops/cost-caps.ts")).toContain('action: "KILL_SWITCH_ACTIVE", metric: "KillSwitchActive"');
    expect(read("packages/bff/src/routers/edge.ts")).toContain('{ metric: "OriginRejected", value: 1 }');
  });

  it("counts only refused spends of a kill switch", () => {
    expect(METRIC_FILTERS.find((spec) => spec.metric === "KillSwitchActive")?.pattern).toContain('$.action = "KILL_SWITCH_ACTIVE"');
  });
});

describe("P-07 (closed by the CTO on 2026-10-14): no cost threshold, no spend alarm, no project budget", () => {
  const observability = read("infra/observability.ts");

  it("infra/observability.ts builds only the metric filters: no alarm, no dashboard, no budget", () => {
    expect(observability).not.toMatch(/cloudwatch\.(MetricAlarm|CompositeAlarm|Dashboard)|budgets\.Budget/);
    for (const file of ["infra/bff.ts", "infra/certificates.ts"]) expect(read(file)).not.toMatch(/cloudwatch\.(MetricAlarm|Dashboard)|budgets\.Budget/);
    expect(observability).toContain("created.nodes.logGroup.apply");
  });

  it("the spec exports no spend alarm, budget nor cut topic", () => {
    const spec = read("infra/observability-spec.ts");
    for (const name of ["AGENT_SPEND_ALARM_USD_PER_HOUR", "PROJECT_BUDGET", "COST_ALARMS", "CostAlerts", "AgentSpendUsd", "TurnCapHits"]) expect(spec, name).not.toContain(name);
    expect(existsSync(resolve(process.cwd(), "infra/cost-guard.ts"))).toBe(false);
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

