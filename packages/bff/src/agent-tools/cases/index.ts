// Lambda entry of `ToolCases` (target `cases`, docs/architecture.md §9.2): `packages/bff/src/agent-tools/cases/index.handler`
// serves the Gateway and direct invocations through `createToolHandler`, so every fence (`LAM-CALLER`,
// `LAM-SCOPE`, `LAM-KILL` with `report_safety_hazard` exempt, `LAM-STRICT`) already holds before the
// implementations of handler.ts, steps.ts and close.ts run. `createCasesTools` builds the same target
// over another runtime (the worker's ports, the tests' fakes).
import { createToolHandler, type ToolHandler } from "../common/handler";
import { CASES_IMPLEMENTATIONS } from "./handler";
import { type CasesRuntime, defaultCasesRuntime } from "./runtime";

export function createCasesTools(deps: () => CasesRuntime): ToolHandler {
  return createToolHandler({ target: "cases", deps, tools: CASES_IMPLEMENTATIONS });
}

export const casesTools = createCasesTools(defaultCasesRuntime);

export const handler = casesTools.handler;
