// The adapters every Lambda uses, built once per container: `Runtime` in DynamoDB, one kill switch
// reader (its 30-second cache lives as long as the container) and the stage's ceiling from the SST
// link. The BFF, the worker, `InboundWhatsApp` and `createToolHandler` take them from here; tests
// build their own with ops/memory-runtime-store.ts.
import { createLogger } from "../lib/log";
import { type CostCapsDeps, linkedGlobalCostCaps } from "./cost-caps";
import { createDynamoRuntimeStore } from "./dynamo-runtime-store";
import { type KillSwitchReader, createKillSwitchReader } from "./kill-switch";

type RuntimeStore = ReturnType<typeof createDynamoRuntimeStore>;

let store: RuntimeStore | undefined;
let reader: KillSwitchReader | undefined;

export function runtimeStore(): RuntimeStore {
  store ??= createDynamoRuntimeStore();
  return store;
}

/** The container's reader; it outlives requests, so it logs with its own correlation id. */
export function killSwitchReader(): KillSwitchReader {
  reader ??= createKillSwitchReader({ store: runtimeStore(), logger: createLogger({ bindings: { component: "kill-switch" } }) });
  return reader;
}

/** Everything `reserveCost` needs; `logger` and `audit` come from the caller's request. */
export function costCapsDeps(extra: Pick<CostCapsDeps, "logger" | "audit"> = {}): CostCapsDeps {
  return { store: runtimeStore(), kill: killSwitchReader(), globalCaps: linkedGlobalCostCaps, ...extra };
}

/** Test seam. */
export function resetOpsDefaults(): void {
  store = undefined;
  reader = undefined;
}
