// What WP-38 builds, as plain data and pure functions (docs/architecture.md §11, §12 and §14, ADR-0019,
// ADR-0028, docs/build-plan.md WP-38). No SST or Pulumi dependency: infra/observability.ts,
// infra/bff.ts and infra/certificates.ts build the resources from this file, and
// infra/observability-spec.test.ts checks every value against the docs, the code that writes the log
// lines and the other modules that hold numbers of §12.
//
// Logs only (ADR-0028). Every indicator of §12 is a field of a JSON log line, read with Logs Insights.
// A CloudWatch metric exists only when a scenario step asserts it:
//
//   OriginRejected              asserted by SMK/10 (the Bff's Function URL called directly)
//   KillSwitchActive            asserted by SC-14/5 (a world's agent cut)
//
// Every filter is one per emitting function, over the log group SST creates for it
// (`fn.nodes.logGroup`). No dashboard, no alarm and no budget: the CTO decided on 2026-10-14 (P-07)
// that the stage has no cost-per-conversation threshold, no agent spend alarm and no project budget,
// and an alarm bills every month even when it never fires. The ceilings of ADR-0019 refuse a spend
// before it happens and the kill switches are turned on by the operator.

import { APP, CAPABILITIES, IAM_ARNS, METRICS_NAMESPACE, STAGE, expectedGrants, isManagedGrant, type CapabilityName, type Grant, type LambdaName } from "./iam-capabilities";

export { METRICS_NAMESPACE };

// ---- Metric filters ---------------------------------------------------------------------------------

export type MetricUnit = "Count";

export interface MetricFilterSpec {
  readonly metric: string;
  /** Functions whose log group carries the line: one filter per log group. */
  readonly emitters: readonly LambdaName[];
  readonly pattern: string;
  /** `"1"` per matching line. */
  readonly value: string;
  readonly unit: MetricUnit;
  /** The scenario step that asserts the metric. */
  readonly readBy: "SMK/10" | "SC-14/5";
  /** File of packages/bff that writes the line today. */
  readonly source?: string;
  /** Work package that writes the line, while no code does yet. */
  readonly pendingIn?: string;
}

const BFF = "packages/bff/src";

export const METRIC_FILTERS: readonly MetricFilterSpec[] = [
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
export const RESERVED_CONCURRENCY = { Bff: 10, InboundWhatsApp: 10, ToolEvidence: 10, CertificateWriter: 5 } as const satisfies Partial<Record<LambdaName, number>>;

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
