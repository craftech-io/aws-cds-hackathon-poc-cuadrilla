// The cut in runtime (ADR-0019, ADR-0025 §4, docs/architecture.md §12 and §14): the topic `CostAlerts`,
// `CostGuard` subscribed to it, and the four alarms of the sign-up that publish there (WP-56). The cost
// cut of WP-38 publishes on the same topic from infra/observability.ts: the alarms `TurnCapHitsGlobal`
// and `AgentSpendHourly` and the project budget at 100 %. `CostGuard` only turns a kill switch ON,
// by the closed table of packages/bff/src/handlers/cost-guard.ts (`ALARM_SCOPES`, `BUDGET_SCOPES`):
//
//   <app>-<stage>-AuthEmailBounces      Bounce of AWS/SES (kind = AUTH) ≥ 5 in 1 h                       → KILL#SIGNUP
//   <app>-<stage>-AuthEmailBounceRate   Bounce / Send (kind = AUTH) ≥ 3 % in 24 h, with at least 20 sends → KILL#SIGNUP
//   <app>-<stage>-AuthEmailComplaints   Complaint (kind = AUTH) ≥ 2 in 24 h                               → KILL#SIGNUP
//   <app>-<stage>-SignupBurst           SignupStarted (CuadrillaAgent, from the Bff's log lines) > 150 in 1 h → KILL#SIGNUP
//   <app>-<stage>-TurnCapHitsGlobal     infra/observability.ts                                            → KILL#AGENT
//   <app>-<stage>-AgentSpendHourly      infra/observability.ts                                            → KILL#AGENT
//   <app>-<stage>-monthly (budget)      infra/observability.ts, 100 % of the actual cost                  → KILL#AGENT
//
// The authentication emails are the only ones of the shared account that go to addresses nobody
// verified: a bot or a typo bounces, and a pause of SES for bounces or complaints would stop the
// sending of the whole account (the other app's too). Only the operator turns a cut off
// (`npm run ops:kill -- --scope SIGNUP|AGENT --off`).
//
// Topic: fixed name inside the `sns:<app>-*` fence of the CI role; only CloudWatch alarms and AWS
// Budgets of this account may publish (`aws:SourceAccount`). CostGuard: reserved concurrency 1,
// `PutItem` of `Runtime` only on `KILL#*` keys, `AuditLog` for `KILL_SWITCH_SET`.
//
// Verify:
//   aws --profile craftech-demos cloudwatch describe-alarms --alarm-name-prefix aws-cds-hackathon-poc-cuadrilla-poc-   (the six, AlarmActions = CostAlerts)
//   aws --profile craftech-demos sns list-subscriptions-by-topic --topic-arn <CostAlerts>   → CostGuard only
//   npm run ops:kill -- --status   → KILL#ALL, SIMULATOR, AGENT and SIGNUP absent or off

import { bff } from "./bff";
import { grantTableLinks, signupPermissions } from "./leads";
import { AUTH_EMAIL_METRICS } from "./messaging-email-spec";
import { METRICS_NAMESPACE } from "./iam-capabilities";
import { storageLinks, storagePermissions } from "./storage";

export const COST_GUARD_HANDLER = "packages/bff/src/handlers/cost-guard.handler";

/** `<app>-<stage>-<suffix>`: the suffix is the key of the handler's closed table. */
export function alarmName(suffix: string): string {
  return `${$app.name}-${$app.stage}-${suffix}`;
}

/** The metric of the sign-up burst, from the `metric` field of the Bff's JSON log lines. */
export const SIGNUP_STARTED_METRIC = "SignupStarted";

export const costAlerts = new sst.aws.SnsTopic("CostAlerts", {
  transform: { topic: { name: `${$app.name}-${$app.stage}-CostAlerts` } },
});

const accountId = aws.getCallerIdentityOutput({}).accountId;

export const costAlertsPolicy = new aws.sns.TopicPolicy("CostAlertsPolicy", {
  arn: costAlerts.arn,
  policy: $util.jsonStringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AlarmsAndBudgetsOfThisAccount",
        Effect: "Allow",
        Principal: { Service: ["cloudwatch.amazonaws.com", "budgets.amazonaws.com"] },
        Action: "sns:Publish",
        Resource: costAlerts.arn,
        Condition: { StringEquals: { "aws:SourceAccount": accountId } },
      },
    ],
  }),
});

export const costGuard = new sst.aws.Function("CostGuard", {
  description: "Turns a kill switch ON for the alarms of its closed table; never turns one off.",
  handler: COST_GUARD_HANDLER,
  link: [...storageLinks("CostGuard"), ...grantTableLinks("CostGuard")],
  permissions: [...storagePermissions("CostGuard"), ...signupPermissions("CostGuard")],
  timeout: "10 seconds",
  memory: "256 MB",
  concurrency: { reserved: 1 },
});

export const costGuardSubscription = costAlerts.subscribe("CostGuard", costGuard.arn);

// ---- The sign-up's metric and alarms -----------------------------------------------------------------

export const signupStartedFilter = new aws.cloudwatch.LogMetricFilter("SignupStartedMetric", {
  logGroupName: bff.nodes.logGroup.apply((group) => {
    if (group === undefined) throw new Error("The Bff has no log group of its own: SignupStarted cannot be measured.");
    return group.name;
  }),
  pattern: `{ $.metric = "${SIGNUP_STARTED_METRIC}" }`,
  metricTransformation: { namespace: METRICS_NAMESPACE, name: SIGNUP_STARTED_METRIC, value: "1", unit: "Count" },
});

const common = { alarmActions: [costAlerts.arn], evaluationPeriods: 1, treatMissingData: "notBreaching" };

/** A SES metric of the authentication emails, summed over `period` seconds (a metric query). */
function sesQuery(metric: keyof typeof AUTH_EMAIL_METRICS, period: number) {
  const spec = AUTH_EMAIL_METRICS[metric];
  return { namespace: spec.namespace, metricName: spec.metricName, dimensions: { ...spec.dimensions }, stat: "Sum", period };
}

/** The same metric as the single metric of an alarm. */
function sesMetric(metric: keyof typeof AUTH_EMAIL_METRICS, period: number) {
  const { stat, ...rest } = sesQuery(metric, period);
  return { ...rest, statistic: stat };
}

export const signupCutAlarms = [
  new aws.cloudwatch.MetricAlarm("AuthEmailBouncesAlarm", {
    ...common,
    name: alarmName("AuthEmailBounces"),
    alarmDescription: "Bounces of the authentication emails: cuts the own sign-up (KILL#SIGNUP).",
    ...sesMetric("AuthEmailBounces", 3600),
    threshold: 5,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
  }),
  new aws.cloudwatch.MetricAlarm("AuthEmailBounceRateAlarm", {
    ...common,
    name: alarmName("AuthEmailBounceRate"),
    alarmDescription: "Bounce rate of the authentication emails over 24 h: cuts the own sign-up (KILL#SIGNUP).",
    metricQueries: [
      { id: "bounces", metric: sesQuery("AuthEmailBounces", 86400), returnData: false },
      { id: "sends", metric: sesQuery("AuthEmailSends", 86400), returnData: false },
      { id: "rate", expression: "IF(sends >= 20, bounces / sends, 0)", label: "AuthEmailBounceRate", returnData: true },
    ],
    threshold: 0.03,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
  }),
  new aws.cloudwatch.MetricAlarm("AuthEmailComplaintsAlarm", {
    ...common,
    name: alarmName("AuthEmailComplaints"),
    alarmDescription: "Complaints about the authentication emails: cuts the own sign-up (KILL#SIGNUP).",
    ...sesMetric("AuthEmailComplaints", 86400),
    threshold: 2,
    comparisonOperator: "GreaterThanOrEqualToThreshold",
  }),
  new aws.cloudwatch.MetricAlarm("SignupBurstAlarm", {
    ...common,
    name: alarmName("SignupBurst"),
    alarmDescription: "A burst of sign-ups in one hour: cuts the own sign-up (KILL#SIGNUP).",
    namespace: METRICS_NAMESPACE,
    metricName: SIGNUP_STARTED_METRIC,
    statistic: "Sum",
    period: 3600,
    threshold: 150,
    comparisonOperator: "GreaterThanThreshold",
  }),
];
