// What WP-38 builds, as plain data and pure functions (docs/architecture.md §11, §12 and §14, ADR-0019,
// ADR-0028, docs/build-plan.md WP-38). No SST or Pulumi dependency: infra/observability.ts,
// infra/bff.ts and infra/certificates.ts build the resources from this file, and
// infra/observability-spec.test.ts checks every value against the docs, the code that writes the log
// lines, the other modules that hold numbers of §12 and the closed table of CostGuard.
//
// Logs only (ADR-0028). Every indicator of §12 is a field of a JSON log line, read with Logs Insights.
// A CloudWatch metric exists only when an alarm that cuts reads it or a scenario step asserts it:
//
//   TurnCapHits{scope=GLOBAL}   alarm → CostAlerts → CostGuard → KILL#AGENT     (ADR-0019)
//   AgentSpendUsd               alarm → CostAlerts → CostGuard → KILL#AGENT     (ADR-0019)
//   OriginRejected              asserted by SMK/10 (the Bff's Function URL called directly)
//   KillSwitchActive            asserted by SC-14/5 (a world's agent cut)
//   SignupStarted               alarm of the sign-up's cut: infra/cost-guard.ts (WP-56), not here
//
// Every filter is one per emitting function, over the log group SST creates for it
// (`fn.nodes.logGroup`). No dashboard, no alarm without an action: each alarm publishes on CostAlerts.
// The project budget notifies the operator at 50, 80 and 100 % and, at 100 %, CostAlerts too.

import { SeedOverridesValue } from "../packages/bff/src/lib/secret-schemas";
import { APP, CAPABILITIES, IAM_ARNS, METRICS_NAMESPACE, STAGE, expectedGrants, isManagedGrant, type CapabilityName, type Grant, type LambdaName } from "./iam-capabilities";

export { METRICS_NAMESPACE };

// ---- Metric filters ---------------------------------------------------------------------------------

export type MetricUnit = "Count" | "None";

export interface MetricFilterSpec {
  readonly metric: string;
  /** Functions whose log group carries the line: one filter per log group. */
  readonly emitters: readonly LambdaName[];
  readonly pattern: string;
  /** `"1"` per matching line, or a JSON field of the line. */
  readonly value: string;
  readonly unit: MetricUnit;
  /** Dimension name → JSON field of the line. */
  readonly dimensions?: Readonly<Record<string, string>>;
  /** Who reads the metric: an alarm of this module, or the scenario step that asserts it. */
  readonly readBy: "alarm" | "SMK/10" | "SC-14/5";
  /** File of packages/bff that writes the line today. */
  readonly source?: string;
  /** Work package that writes the line, while no code does yet. */
  readonly pendingIn?: string;
}

const BFF = "packages/bff/src";

export const METRIC_FILTERS: readonly MetricFilterSpec[] = [
  // `reserve_cost` of the turns (the worker before InvokeHarness, the Bff before a simulator message).
  {
    metric: "TurnCapHits",
    emitters: ["InstallerWorker", "Bff"],
    pattern: '{ $.metric = "TurnCapHits" && $.scope = "GLOBAL" }',
    value: "1",
    unit: "Count",
    dimensions: { scope: "$.scope" },
    readBy: "alarm",
    source: `${BFF}/ops/cost-caps.ts`,
  },
  // Each turn's own spend by the rate card, logged by the worker only in the demo and live worlds.
  { metric: "AgentSpendUsd", emitters: ["InstallerWorker"], pattern: '{ $.metric = "AgentSpendUsd" }', value: "$.value", unit: "None", readBy: "alarm", source: `${BFF}/turns/record.ts` },
  { metric: "OriginRejected", emitters: ["Bff"], pattern: '{ $.metric = "OriginRejected" }', value: "1", unit: "Count", readBy: "SMK/10", source: `${BFF}/routers/edge.ts` },
  // A spend refused by a kill switch (`KILL_SWITCH_ACTIVE`), never the operator's own on/off lines.
  {
    metric: "KillSwitchActive",
    emitters: ["InstallerWorker", "ToolEvidence", "Bff"],
    pattern: '{ $.metric = "KillSwitchActive" && $.action = "KILL_SWITCH_ACTIVE" }',
    value: "1",
    unit: "Count",
    readBy: "SC-14/5",
    source: `${BFF}/ops/cost-caps.ts`,
  },
];

/** Pulumi name of the filter of a metric over one emitter's log group. */
export function metricFilterName(metric: string, emitter: LambdaName): string {
  return `Metric${metric}${emitter}`;
}

// ---- Alarms of the cost cut (ADR-0019) --------------------------------------------------------------

export interface CostAlarmSpec {
  /** `<app>-<stage>-<suffix>`; the suffix is a key of CostGuard's closed table. */
  readonly suffix: string;
  readonly description: string;
  readonly metric: string;
  readonly dimensions?: Readonly<Record<string, string>>;
  readonly statistic: "Sum" | "Average";
  readonly periodSeconds: number;
  readonly threshold: number;
  readonly comparison: "GreaterThanThreshold";
}

/**
 * The stage's hourly budget of agent spend in USD over the demo and live worlds (ADR-0019). The alarm
 * SUMS each turn's own spend (never a conversation's running total, which a long conversation would
 * repeat once per turn), so it measures the spend rate. Guest worlds, sign-up ones included, never log
 * it: their own ceilings (per world, per account and the global one) cap them, and a visitor can never
 * cut the agent of every other world. One long conversation at a normal turn cost (40 turns at about
 * USD 0.15) spends about USD 6, well under it. Provisional until WP-49 fixes it with the CTO from the
 * verified rate card; the cost per conversation the product shows (`IspSettings.costBudgetUsdPerConversation`)
 * comes from `CuadrillaMetrics`, not from this alarm.
 */
export const AGENT_SPEND_ALARM_USD_PER_HOUR = 20;

export const COST_ALARMS: readonly CostAlarmSpec[] = [
  {
    suffix: "TurnCapHitsGlobal",
    description: "The global ceiling of agent turns of the stage was reached: cuts the agent (KILL#AGENT).",
    metric: "TurnCapHits",
    dimensions: { scope: "GLOBAL" },
    statistic: "Sum",
    periodSeconds: 300,
    threshold: 0,
    comparison: "GreaterThanThreshold",
  },
  {
    suffix: "AgentSpendHourly",
    description: "The agent's spend in the demo and live worlds over the last hour is over the stage's hourly budget: cuts the agent (KILL#AGENT).",
    metric: "AgentSpendUsd",
    statistic: "Sum",
    periodSeconds: 3600,
    threshold: AGENT_SPEND_ALARM_USD_PER_HOUR,
    comparison: "GreaterThanThreshold",
  },
];

/** `<app>-<stage>-<suffix>`, as infra/cost-guard.ts `alarmName` builds it. */
export function costAlarmName(suffix: string, app: string = APP, stage: string = STAGE): string {
  return `${app}-${stage}-${suffix}`;
}

// ---- Project budget ---------------------------------------------------------------------------------

/**
 * Monthly budget of the project by the cost allocation tag `Project` (docs/architecture.md §12 and §17
 * item 8). The amount is provisional (no doc fixes it): the CTO confirms it with WP-49. Notices at 50,
 * 80 and 100 % of the actual cost to `SeedOverrides.operatorEmail`; at 100 % also CostAlerts, which
 * CostGuard turns into KILL#AGENT.
 */
export const PROJECT_BUDGET = {
  suffix: "monthly",
  limitUsdPerMonth: 300,
  notifyAtPercent: [50, 80, 100],
  cutAtPercent: 100,
  costTagKey: "Project",
} as const;

/** Inside the `budget/<app>-*` fence of the CI deploy role (bootstrap `ProjectBudget`). */
export function budgetName(app: string = APP, stage: string = STAGE): string {
  return `${app}-${stage}-${PROJECT_BUDGET.suffix}`;
}

export function budgetCostFilter(project: string): { readonly name: "TagKeyValue"; readonly values: string[] } {
  return { name: "TagKeyValue", values: [`user:${PROJECT_BUDGET.costTagKey}$${project}`] };
}

/** `SeedOverrides.operatorEmail`, read at deploy time; none in the initial `{}`. Errors never echo the value. */
export function budgetSubscribers(rawSeedOverrides: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(rawSeedOverrides);
  } catch {
    throw new Error("SeedOverrides is not valid JSON (value not shown).");
  }
  const parsed = SeedOverridesValue.safeParse(json);
  if (!parsed.success) throw new Error("SeedOverrides does not match packages/bff/src/lib/secret-schemas.ts (value not shown).");
  const email = parsed.data.operatorEmail;
  return email === undefined ? [] : [email.trim().toLowerCase()];
}

export interface BudgetNotification<T> {
  readonly comparisonOperator: "GREATER_THAN";
  readonly notificationType: "ACTUAL";
  readonly threshold: number;
  readonly thresholdType: "PERCENTAGE";
  readonly subscriberEmailAddresses?: string[];
  readonly subscriberSnsTopicArns?: T[];
}

/** Every notice on the actual cost; each one has at least one subscriber or is left out. */
export function budgetNotifications<T>(emails: readonly string[], costAlertsArn: T): Array<BudgetNotification<T>> {
  return PROJECT_BUDGET.notifyAtPercent.flatMap((threshold) => {
    const cut = threshold === PROJECT_BUDGET.cutAtPercent;
    if (emails.length === 0 && !cut) return [];
    return [
      {
        comparisonOperator: "GREATER_THAN" as const,
        notificationType: "ACTUAL" as const,
        threshold,
        thresholdType: "PERCENTAGE" as const,
        ...(emails.length === 0 ? {} : { subscriberEmailAddresses: [...emails] }),
        ...(cut ? { subscriberSnsTopicArns: [costAlertsArn] } : {}),
      },
    ];
  });
}

// ---- Functions of infra/bff.ts and infra/certificates.ts ---------------------------------------------

/** Lambda entries; each file belongs to the WP that writes the code (docs/build-plan.md §2). */
export const WP38_HANDLERS = {
  CertificateWriter: "packages/bff/src/handlers/certificate-writer.handler", // WP-35
  PolicyAudit: "packages/bff/src/handlers/policy-audit.handler", // WP-40
  QaDriver: "packages/bff/src/handlers/qa-driver.handler", // WP-45
} as const satisfies Partial<Record<LambdaName, string>>;

/** docs/architecture.md §11: 1024 MB, 30 s, reserved 5 (§12). */
export const CERTIFICATE_WRITER = { timeoutSeconds: 30, memoryMb: 1024, reservedConcurrency: 5 } as const;

/** A step waits for the world to settle and `memory.inspect` up to 600 s (docs/tool-catalog.md): Lambda's maximum. */
export const QA_DRIVER = { timeoutSeconds: 900, memoryMb: 1024 } as const;

/** Fixed name the bootstrap's `qa-runner` is fenced to (docs/architecture.md §1, IAM_ARNS.qaDriver). */
export function qaDriverFunctionName(app: string = APP, stage: string = STAGE): string {
  return `${app}-${stage}-qa-driver`;
}

/** The bootstrap's scenario runner, the only principal of the QaDriver's resource policy (no IAM path). */
export function qaRunnerRoleName(app: string = APP): string {
  return `${app}-qa-runner`;
}

/**
 * The daily PolicyAudit (docs/architecture.md §12): 03:00 America/Mexico_City (09:00 UTC; Mexico keeps
 * UTC−6 all year), after the leads' sweep (02:20) and before WorldJanitor (04:00). The event names no
 * world: the handler lists the demo and guest worlds at run time.
 */
export const POLICY_AUDIT = { schedule: "cron(0 9 * * ? *)", event: { kind: "DAILY" }, timeoutSeconds: 900, memoryMb: 512 } as const;

/** Reserved concurrency of docs/architecture.md §12; each module sets its own and the test compares. */
export const RESERVED_CONCURRENCY = { Bff: 10, InboundWhatsApp: 10, ToolEvidence: 10, CertificateWriter: 5, CostGuard: 1 } as const satisfies Partial<Record<LambdaName, number>>;

// ---- Which grants travel with a link ------------------------------------------------------------------

/**
 * Resources of iam-capabilities.ts grants that a link carries complete: a linked Function grants
 * `lambda:InvokeFunction` on it alone, a linked queue its one role (infra/workers.ts `queueLink`),
 * `GuardrailG1`/`GuardrailG3` ApplyGuardrail on their guardrail and `WaInbound` `sns:Publish` on the topic.
 */
export const LINK_CARRIED_RESOURCES = [
  "{InstallerEvents}",
  "{InstallerEventsDlq}",
  "{InboundWhatsApp}",
  "{WorldJanitor}",
  "{GuestWorlds}",
  "{GuestAccountDeletion}",
  "{PolicyAudit}",
  "{CertificateWriter}",
  "{ToolOrders}",
  "{ToolKnowledge}",
  "{ToolEvidence}",
  "{ToolMessaging}",
  "{ToolCases}",
  "{G1}",
  "{G3}",
  IAM_ARNS.waTopic,
] as const;

export type LinkCarriedResource = (typeof LINK_CARRIED_RESOURCES)[number];

/** Capabilities whose grants travel complete with their Linkable (mocks, `Scheduler`, `Memory`). */
export const LINK_CARRIED_CAPABILITIES = ["MOCK_NETWORK", "MOCK_DISPATCH", "TIMERS", "MEMORY_ADMIN"] as const satisfies readonly CapabilityName[];

const carriedCapabilityGrants = new Set<Grant>(LINK_CARRIED_CAPABILITIES.flatMap((name) => CAPABILITIES[name].grants));
const isCarriedResource = (resource: string): resource is LinkCarriedResource => (LINK_CARRIED_RESOURCES as readonly string[]).includes(resource);

export function linkCarried(grant: Grant): boolean {
  return carriedCapabilityGrants.has(grant) || grant.resources.every(isCarriedResource);
}

/** The grants of a role that become `permissions` statements (everything a link does not carry nor a managed policy holds). */
export function statementGrants(fn: LambdaName): Grant[] {
  return expectedGrants(fn).filter((grant) => !linkCarried(grant) && !isManagedGrant(grant));
}

/** The link-carried resources a role needs, so its module links exactly those components. */
export function carriedResources(fn: LambdaName): LinkCarriedResource[] {
  const names = expectedGrants(fn)
    .filter((grant) => !carriedCapabilityGrants.has(grant) && grant.resources.every(isCarriedResource))
    .flatMap((grant) => grant.resources as LinkCarriedResource[]);
  return [...new Set(names)].sort();
}

/** Placeholders the statements of infra/bff.ts resolve besides storage and `Leads` (infra/leads.ts). */
export const STATEMENT_REFS = ["{UserPool}", "{Auth}", "{EdgeWebAcl}", "{AuthWebAcl}"] as const;
