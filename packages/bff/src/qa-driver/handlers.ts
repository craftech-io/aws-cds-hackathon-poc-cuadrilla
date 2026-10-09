// One handler per `QaDriver` action (docs/tool-catalog.md), over the ports the Lambda entry wires
// (stage-ports.ts) or the fakes of the tests (testing.ts). The world and clock actions are in
// handlers-world.ts, the channel, console, tools, evaluation, reads and probes in handlers-io.ts, and the
// QA seam of the own sign-up in handlers-seam.ts. The input each one receives was parsed by the driver
// with its schema (contract-inputs.ts) and fenced by the guard (guard.ts).
import type { QaActionName } from "./contract";
import type { ActionContext, ActionHandlers } from "./driver";
import { ioActions } from "./handlers-io";
import { seamActions } from "./handlers-seam";
import { worldActions } from "./handlers-world";
import type { QaPorts } from "./ports";

type Loose = (input: never, ctx: ActionContext) => Promise<unknown>;

export function buildHandlers(ports: QaPorts): ActionHandlers {
  const all: Record<QaActionName, Loose> = { ...worldActions(ports), ...ioActions(ports), ...seamActions(ports) };
  return all as unknown as ActionHandlers;
}
