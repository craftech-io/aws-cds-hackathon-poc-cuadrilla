// Mock of a generic network orchestrator (docs/architecture-integrations.md §6). The Lambda entry is
// `handler.ts` (Function URL, AWS_IAM); this index is for the code that builds or reads its world
// state without going through HTTP: the world factory and the seed (`newOnuRow`, `onuKey`), the
// scenario runner's evidence (`readsByReader`) and the local flows (`handleNetworkRequest` over an
// `InMemoryOnuStore`). Explicit re-exports only; nothing here imports the AWS SDK.

export { BEHAVIOURS, DEFAULT_TX_POWER_DBM, LOW_POWER_RX_DBM, behaviourControlPatch, physicalActionPatch, resolveOnuStatus } from "./behaviours";
export type { OnuStatePatch } from "./behaviours";

export { FAULT_LATENCY_MS, FAULT_RETRY_AFTER_SECONDS, FAULT_TIMEOUT_MS, requestedFault } from "./faults";

export { ONU_ENTITY, ONU_SORT_KEY, OnuRow, READER_COUNTER, newOnuRow, onuKey, readsByReader } from "./rows";
export type { NewOnuRow, OnuKey } from "./rows";

export { handleNetworkRequest } from "./routes";
export type { MockDeps, MockRequest, MockResponse } from "./routes";

export { InMemoryOnuStore } from "./store";
export type { OnuStore } from "./store";
