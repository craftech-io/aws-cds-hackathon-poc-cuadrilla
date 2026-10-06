// Lambda entry of `ToolEvidence` (target `evidence`, docs/architecture.md §9.2): infra/agent-tools.ts
// points the Function at `packages/bff/src/agent-tools/evidence/index.handler`. Every call goes
// through `createToolHandler`, so `LAM-CALLER`, `LAM-SCOPE`, `LAM-KILL` and `LAM-STRICT` hold before a
// tool runs. `createEvidenceTarget` is what the tests and the local flows build the target with,
// over the in-memory connector and fakes of the photo model, the objects, the orchestrator, the case
// opener and the outbound pipeline.
import { createToolHandler } from "../common/handler";
import { getChecklist, updateChecklist } from "./checklist";
import { type EvidenceToolRuntime, defaultEvidenceRuntime } from "./runtime";
import { validateInstallPhoto } from "./validate";

export function createEvidenceTarget(deps: () => EvidenceToolRuntime) {
  return createToolHandler({ target: "evidence", deps, tools: [getChecklist, validateInstallPhoto, updateChecklist] });
}

export const evidenceTools = createEvidenceTarget(defaultEvidenceRuntime);

export const handler = evidenceTools.handler;
