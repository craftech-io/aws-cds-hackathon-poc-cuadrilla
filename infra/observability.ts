// Observability of the app: logs only (ADR-0028, docs/architecture.md §12, docs/build-plan.md WP-38).
// Every value lives in infra/observability-spec.ts (checked by its test).
//
//   Logs      Every Lambda's group comes from SST with the 30 days of the $transform of sst.config.ts;
//             the Harness runtime's `live` group from infra/agentcore.ts (30 days, before the endpoint);
//             `…-DEFAULT` is declared manual configuration (§17 item 15). The code writes one JSON line
//             per event (packages/bff/src/lib/log.ts) and every indicator of §12 is a field of it.
//   Metrics   Only the two filters of METRIC_FILTERS, each over the group SST creates for its emitter
//             (`fn.nodes.logGroup`; its name does not follow the function's, SST draws its own suffix),
//             each one asserted by a scenario step.
//   Alarms    None, and no dashboard nor budget (P-07, closed by the CTO on 2026-10-14: no cost threshold,
//             no agent spend alarm, no project budget; infra/logs-only.test.ts).
//
// Cost: metric filters are free; a custom metric bills only for the hours it receives data.
//
// Verify:
//   aws --profile craftech-demos logs describe-metric-filters --log-group-name <log group of the Bff>   → OriginRejected, KillSwitchActive
//   aws --profile craftech-demos cloudwatch describe-alarms --alarm-name-prefix aws-cds-hackathon-poc-cuadrilla-poc-   → none

import { toolEvidence } from "./agent-tools";
import { bff } from "./bff";
import type { LambdaName } from "./iam-capabilities";
import { METRICS_NAMESPACE, METRIC_FILTERS, metricFilterName } from "./observability-spec";
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
        },
      }),
  ),
);
