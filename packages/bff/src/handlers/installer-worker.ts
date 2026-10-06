// Lambda entry of the `InstallerWorker` (infra/workers.ts): consumes `InstallerEvents.fifo`, one event per
// installer at a time (docs/architecture.md §7). The worker itself is worker/worker.ts; its dependencies
// are built once per container by worker/production.ts.
import type { Context, SQSEvent } from "aws-lambda";
import { productionWorkerDeps } from "../worker/production";
import { createInstallerWorker } from "../worker/worker";

export async function handler(event: SQSEvent, context: Context): Promise<void> {
  await createInstallerWorker(productionWorkerDeps())(event, context);
}
