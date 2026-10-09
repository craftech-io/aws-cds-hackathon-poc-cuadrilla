// The console of a local world: the real `appRouter` with its middlewares, bound to the world's stage
// through `bindConsolePorts` (routers/console-ports.ts), as the `QaDriver` calls it (`createQaCaller`: a
// principal built on the server, no token). The phone simulator's envelope reaches the same
// `InboundWhatsApp` the world's phone reaches, the console's queue and timers are the world's installer
// queue, "Reiniciar demo" and "Saltar a escena" run the world factory over the world's own ports, and
// the buckets are the world's. A call leaves its events queued; the caller settles the world after it.
import type { ConsoleRole } from "@cuadrilla/shared";
import { createUserDirectory } from "../../../packages/bff/src/auth/staff";
import { createSimulatedTransport } from "../../../packages/bff/src/channels/whatsapp/simulated";
import { processInboundEvent } from "../../../packages/bff/src/channels/whatsapp/inbound";
import { tableEvalRuns } from "../../../packages/bff/src/metrics/eval-runs";
import { type ConsolePorts, bindConsolePorts } from "../../../packages/bff/src/routers/console-ports";
import type { ContextDeps } from "../../../packages/bff/src/routers/deps";
import { type AppCaller, createQaCaller } from "../../../packages/bff/src/routers/index";
import type { DispatchControlClient } from "../../../packages/bff/src/services/demo-controls/dispatch-client";
import { worldRebuild } from "../../../packages/bff/src/worlds/rebuild";
import type { FlowWorld } from "./world";

/** The dispatcher's control API as the console calls it; the flows drive the dispatcher through `world.dispatch`. */
const NO_DISPATCH_CONTROL: DispatchControlClient = {
  command: async () => {
    throw new Error("the local console does not drive the dispatcher; use world.dispatch");
  },
};

export function consolePorts(world: FlowWorld): ConsolePorts {
  const { stage, data, memory } = world;
  return {
    services: { connector: data, realClock: stage.realClock, logger: stage.log },
    client: memory.client,
    queue: { enqueue: (event) => stage.sink.enqueue(event) },
    scheduler: stage.scheduler,
    dispatcher: stage.dispatcher,
    rebuild: worldRebuild(world.worlds),
    network: world.network.client,
    dispatch: NO_DISPATCH_CONTROL,
    hashPhone: stage.hashPhone,
    addresses: () => ({}),
    objects: world.objects,
    inbound: (event) => processInboundEvent(event, stage.inbound),
    simEnvelopeKey: () => stage.key("sim-envelope"),
    simulatedTransport: () => createSimulatedTransport({ conversations: data.conversations, isps: data.isps, applyStatuses: async () => [], realClock: stage.realClock }),
    brand: () => ({ mode: "neutral" }),
    costCaps: stage.costs,
    kill: stage.kill,
    stageTransports: () => ["simulated"],
    evalRuns: tableEvalRuns(memory.client),
    newId: () => stage.newId(),
  };
}

/** The console as the `QaDriver`'s principal of `role` in the world `clockId`. */
export function consoleOf(world: FlowWorld, role: ConsoleRole, clockId: string): AppCaller {
  const deps: ContextDeps = {
    verifier: { verify: async () => Promise.reject(new Error("the local console takes no tokens")) } as unknown as ContextDeps["verifier"],
    connector: world.data,
    users: createUserDirectory(world.data.isps, world.realNow, 0),
    mocks: async () => ({ network: "OK", dispatch: "OK" }),
    wallClock: world.realNow,
    loggerFor: () => world.stage.log,
  };
  return createQaCaller({ role, clockId }, bindConsolePorts(deps, consolePorts(world)));
}
