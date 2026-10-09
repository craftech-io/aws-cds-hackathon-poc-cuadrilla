/// <reference path="../../sst-env.d.ts" />
// `WorldJanitor` (infra/scheduler.ts, docs/architecture.md §8 and §9.3): the nightly reset of idle invited
// guest worlds and the Memory purge of expired sign-up generations (`{kind: "IDLE_GUEST_RESET"}`, the
// 04:00 rule), and the passes after the first of a Memory purge the `Bff` or the `QaDriver` started
// (`MEMORY_PURGE`, asynchronous). The event is validated with zod before anything is read; the passes of
// the nightly resets run together at the end of the run (worlds/janitor.ts).
import { type Logger, createLogger } from "../lib/log";
import type { WorldsDeps } from "../worlds/deps";
import { type JanitorOutcome, collectingPurge, runJanitor } from "../worlds/janitor";
import { stageWorldsDeps } from "../worlds/stage";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface JanitorDeps {
  readonly worlds: (continuePurge: WorldsDeps["continuePurge"]) => WorldsDeps;
  readonly log: Logger;
  readonly sleep: (ms: number) => Promise<void>;
}

export async function handleWorldJanitor(deps: JanitorDeps, event: unknown): Promise<JanitorOutcome> {
  const collector = collectingPurge();
  const worlds = deps.worlds(collector.continuePurge);
  const outcome = await runJanitor(worlds, event, deps.sleep);
  if (worlds.memory !== undefined) await collector.drain({ memory: worlds.memory, data: worlds.connector, log: deps.log, now: worlds.now, sleep: deps.sleep });
  return outcome;
}

export async function handler(event: unknown): Promise<JanitorOutcome> {
  const log = createLogger({ bindings: { service: "world-janitor" } });
  return handleWorldJanitor({ worlds: (continuePurge) => stageWorldsDeps({ log, continuePurge, certificates: true }), log, sleep }, event);
}
