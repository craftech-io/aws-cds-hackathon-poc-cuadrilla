// Lambda entry of `ToolEvidence` (target `evidence`, docs/architecture.md §9.2): `packages/bff/src/agent-tools/evidence/index.handler`
// serves the Gateway and direct invocations through `createToolHandler`, so every fence (`LAM-CALLER`,
// `LAM-SCOPE`, `LAM-KILL`, `LAM-STRICT`) already holds. Each tool answers `UNAVAILABLE` until WP-30
// replaces its placeholder with the implementation in `handler.ts` (docs/build-plan.md §4).
import { notYetAvailable } from "../common/context";
import { createToolHandler } from "../common/handler";
import { defaultToolRuntime } from "../common/runtime";
import { EVIDENCE_TOOLS } from "./schema";

export const evidenceTools = createToolHandler({ target: "evidence", deps: defaultToolRuntime, tools: EVIDENCE_TOOLS.map((definition) => notYetAvailable(definition)) });

export const handler = evidenceTools.handler;
