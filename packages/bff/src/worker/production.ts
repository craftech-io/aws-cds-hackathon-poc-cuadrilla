// The `InstallerWorker`'s dependencies in a deployed Lambda, built once per container: the DynamoDB
// connector, the Harness over `Resource.Harness`, G1 over `Resource.GuardrailG1`, the kill switch reader
// and the cost caps of ops/defaults.ts, the `orders` and `evidence` targets in process for the preloaded
// reads, the network orchestrator's client, the queue producer over `Resource.InstallerEvents`, the
// HKDF subkeys of `SessionTokenKey`, and the ports of the product's modules (worker/stage-ports.ts).
import { evidenceTools } from "../agent-tools/evidence/index";
import { ordersTools } from "../agent-tools/orders/index";
import { linkedHarnessClient } from "../agent/harness-client";
import { connector } from "../connector";
import { createLogger } from "../lib/log";
import { subkey } from "../lib/secrets";
import { networkClient } from "../network/client";
import { costCapsDeps, killSwitchReader } from "../ops/defaults";
import { linkedG1Prefilter } from "../turns/prefilter";
import { createEventSink, linkedQueueSend } from "./sink";
import { stageWorkerPorts } from "./stage-ports";
import type { WorkerDeps } from "./worker";

let deps: WorkerDeps | undefined;

export function productionWorkerDeps(): WorkerDeps {
  if (deps !== undefined) return deps;
  const data = connector();
  const now = () => new Date();
  const network = networkClient();
  const sink = createEventSink({ data, send: linkedQueueSend() });
  const costs = costCapsDeps({ logger: createLogger({ bindings: { component: "cost-caps" } }) });
  deps = {
    data,
    turn: {
      harness: linkedHarnessClient(() => Date.now()),
      prefilter: linkedG1Prefilter(),
      budget: { kill: killSwitchReader(), costCaps: costs },
      sessionKey: () => subkey("session"),
      runtimeSessionKey: () => subkey("runtime-session"),
      agentMode: "REAL",
      reads: { orders: ordersTools, evidence: evidenceTools },
    },
    ports: stageWorkerPorts({ sink, network, costs, logger: createLogger({ bindings: { component: "installer-worker" } }) }),
    network,
    sink,
    now,
    loggerFor: (correlationId) => createLogger({ correlationId }),
  };
  return deps;
}
