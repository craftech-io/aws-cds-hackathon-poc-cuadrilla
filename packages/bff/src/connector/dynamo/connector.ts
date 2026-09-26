// Assembles the `Connector` port from the repositories over one repository context (one table
// client, one clock, one id generator, one world policy). Used by connector/index.ts over DynamoDB
// and by memory/index.ts over memory: the same repository code in both.
import type { Connector } from "../ports";
import { auditRepo } from "./audit";
import { casesRepo } from "./cases";
import { conversationsRepo } from "./conversations";
import { evidenceRepo } from "./evidence";
import { ispsRepo } from "./isps";
import { metricsRepo } from "./metrics";
import { peopleRepo } from "./people";
import { referenceRepo } from "./reference";
import type { RepoContext } from "./repo";
import { runtimeRepo } from "./runtime";
import { worldRuntimeRepo } from "./runtime-world";
import { seedStore } from "./seed";
import { timersRepo } from "./timers";
import { workOrdersRepo } from "./work-orders";

export function createConnector(ctx: RepoContext): Connector {
  return {
    isps: ispsRepo(ctx),
    people: peopleRepo(ctx),
    workOrders: { ...workOrdersRepo(ctx), ...evidenceRepo(ctx) },
    timers: timersRepo(ctx),
    cases: casesRepo(ctx),
    conversations: conversationsRepo(ctx),
    audit: auditRepo(ctx),
    reference: referenceRepo(ctx),
    runtime: runtimeRepo(ctx),
    worlds: worldRuntimeRepo(ctx),
    metrics: metricsRepo(ctx),
    seed: seedStore(ctx),
  };
}
