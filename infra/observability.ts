// Observability of the app: logs only (ADR-0028, docs/architecture.md §12, docs/build-plan.md WP-38).
// Every value lives in infra/observability-spec.ts (checked by its test).
//
//   Logs      Every Lambda's group comes from SST with the 30 days of the $transform of sst.config.ts;
//             the Harness runtime's `live` group from infra/agentcore.ts (30 days, before the endpoint);
//             `…-DEFAULT` is declared manual configuration (§17 item 15). The code writes one JSON line
//             per event (packages/bff/src/lib/log.ts) and every indicator of §12 is a field of it.
//   Metrics   Only the four filters of METRIC_FILTERS, each over the group SST creates for its emitter
//             (`fn.nodes.logGroup`; its name does not follow the function's, SST draws its own suffix).
//             SignupStarted belongs to the sign-up's cut (infra/cost-guard.ts).
//   Alarms    Only the cost cut of ADR-0019, both on CostAlerts: CostGuard turns them into KILL#AGENT.
//             No dashboard and no alarm without an action (infra/logs-only.test.ts).
//   Budget    `<app>-<stage>-monthly` by the cost allocation tag `Project`: 50, 80 and 100 % to
//             `SeedOverrides.operatorEmail` (read at deploy time, never echoed), and 100 % to CostAlerts.
//
// Cost: metric filters are free; a custom metric bills only for the hours it receives data; two alarms
// at USD 0.10 a month each; the first two budgets of an account are free.
//
// Verify:
//   aws --profile craftech-demos logs describe-metric-filters --log-group-name <log group of the Bff>   → TurnCapHits, OriginRejected, KillSwitchActive (+ SignupStarted)
//   aws --profile craftech-demos cloudwatch describe-alarms --alarm-name-prefix aws-cds-hackathon-poc-cuadrilla-poc-
//     → the 6 alarms of the two cuts, AlarmActions = [CostAlerts] on each
//   aws --profile craftech-demos budgets describe-notifications-for-budget --account-id 776805327629 --budget-name aws-cds-hackathon-poc-cuadrilla-poc-monthly
//   aws --profile craftech-demos budgets describe-subscribers-for-notification --account-id 776805327629 --budget-name aws-cds-hackathon-poc-cuadrilla-poc-monthly \
//     --notification NotificationType=ACTUAL,ComparisonOperator=GREATER_THAN,Threshold=100,ThresholdType=PERCENTAGE   → the operator and CostAlerts

import { toolEvidence } from "./agent-tools";
import { bff } from "./bff";
import { alarmName, costAlerts, costAlertsPolicy } from "./cost-guard";
import type { LambdaName } from "./iam-capabilities";
import {
  COST_ALARMS,
  METRICS_NAMESPACE,
  METRIC_FILTERS,
  PROJECT_BUDGET,
  budgetCostFilter,
  budgetName,
  budgetNotifications,
  budgetSubscribers,
  metricFilterName,
  type CostAlarmSpec,
} from "./observability-spec";
import { SeedOverrides } from "./secrets";
import { PROJECT } from "./tags";
import { installerWorker } from "./workers";

/** The emitters of METRIC_FILTERS, by name: a filter can only name a function that exists. */
const emitters: Readonly<Partial<Record<LambdaName, sst.aws.Function>>> = { Bff: bff, InstallerWorker: installerWorker, ToolEvidence: toolEvidence };

function logGroupName(fn: LambdaName): $util.Output<string> {
  const created = emitters[fn];
  if (created === undefined) throw new Error(`infra/observability.ts does not know the Function ${fn}, which a metric filter names.`);
  return created.nodes.logGroup.apply((group) => {
    if (group === undefined) throw new Error(`${fn} has no log group of its own; its metric filters need one (sst.config.ts logging).`);
    return group.name;
  });
}

// ---- Metric filters ---------------------------------------------------------------------------------

export const metricFilters: aws.cloudwatch.LogMetricFilter[] = METRIC_FILTERS.flatMap((spec) =>
  spec.emitters.map(
    (emitter) =>
      new aws.cloudwatch.LogMetricFilter(metricFilterName(spec.metric, emitter), {
        logGroupName: logGroupName(emitter),
        pattern: spec.pattern,
        metricTransformation: {
          namespace: METRICS_NAMESPACE,
          name: spec.metric,
          value: spec.value,
          unit: spec.unit,
          ...(spec.dimensions === undefined ? {} : { dimensions: { ...spec.dimensions } }),
        },
      }),
  ),
);

// ---- Alarms of the cost cut -------------------------------------------------------------------------

function costAlarm(spec: CostAlarmSpec): aws.cloudwatch.MetricAlarm {
  return new aws.cloudwatch.MetricAlarm(`${spec.suffix}Alarm`, {
    name: alarmName(spec.suffix),
    alarmDescription: spec.description,
    alarmActions: [costAlerts.arn],
    namespace: METRICS_NAMESPACE,
    metricName: spec.metric,
    ...(spec.dimensions === undefined ? {} : { dimensions: { ...spec.dimensions } }),
    statistic: spec.statistic,
    period: spec.periodSeconds,
    evaluationPeriods: 1,
    threshold: spec.threshold,
    comparisonOperator: spec.comparison,
    treatMissingData: "notBreaching",
  });
}

export const costCutAlarms: aws.cloudwatch.MetricAlarm[] = COST_ALARMS.map(costAlarm);

// ---- Project budget ---------------------------------------------------------------------------------

const operatorEmails = SeedOverrides.value.apply((raw) => {
  const emails = budgetSubscribers(raw);
  if (emails.length === 0) $util.log.warn("SeedOverrides has no operatorEmail: the project budget only notifies CostAlerts (docs/seed-spec.md §1).");
  return emails;
});

export const projectBudget = new aws.budgets.Budget("ProjectBudget", {
  name: budgetName($app.name, $app.stage),
  budgetType: "COST",
  limitAmount: String(PROJECT_BUDGET.limitUsdPerMonth),
  limitUnit: "USD",
  timeUnit: "MONTHLY",
  costFilters: [budgetCostFilter(PROJECT)],
  notifications: $util.all([operatorEmails, costAlerts.arn]).apply(([emails, topic]) => budgetNotifications(emails, topic)),
}, { dependsOn: [costAlertsPolicy] }); // Budgets checks that it may publish on the topic.
