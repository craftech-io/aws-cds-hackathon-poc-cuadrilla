// Lambda entry of the `QaDriver` (ADR-0007, docs/tool-catalog.md "Acciones del QaDriver", docs/test-plan.md
// §4): invoked only by the bootstrap's `qa-runner` role (its resource policy, infra/bff.ts), never by a
// URL. Every request is `{ action, idempotencyKey, input }`; the answer is `{ ok, replayed, result }` or
// `{ ok: false, error }` and the invocation never throws (qa-driver/driver.ts). The ports are the stage's,
// built once per container from the links (qa-driver/stage-ports.ts).
import { createLogger } from "../lib/log";
import { type QaDriver, createQaDriver } from "../qa-driver/driver";
import type { QaResponse } from "../qa-driver/contract";
import { buildHandlers } from "../qa-driver/handlers";
import { stageLookups, stageQaPorts } from "../qa-driver/stage-ports";

let driver: QaDriver | undefined;

function stageDriver(): QaDriver {
  if (driver !== undefined) return driver;
  const ports = stageQaPorts();
  driver = createQaDriver({
    data: ports.data,
    lookups: stageLookups(ports),
    handlers: buildHandlers(ports),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "qa-driver" } }),
  });
  return driver;
}

export async function handler(event: unknown): Promise<QaResponse> {
  try {
    return await stageDriver()(event);
  } catch (error) {
    // The ports could not even be built (a missing link): an answer, never a thrown invocation.
    createLogger({ bindings: { service: "qa-driver" } }).error("qa_driver.unwired", { errorName: error instanceof Error ? error.name : "unknown" });
    return { ok: false, error: { code: "UNAVAILABLE", message: "the QA driver is not wired in this stage", reason: "NOT_WIRED" } };
  }
}
