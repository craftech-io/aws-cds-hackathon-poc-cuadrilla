// Lambda entry of `ToolKnowledge` (target `knowledge`, docs/architecture.md §9.2): `packages/bff/src/agent-tools/knowledge/index.handler`
// serves the Gateway and direct invocations through `createToolHandler`, so every fence (`LAM-CALLER`,
// `LAM-SCOPE`, `LAM-KILL`, `LAM-STRICT`) holds before `search_procedures` runs. The dependencies are
// built once per container: the common tool runtime, the Knowledge Base client and the catalog of the
// manual and threshold in force (cached for a minute).
import { createKnowledgeCatalog } from "../../knowledge/catalog";
import { knowledgeClient } from "../../knowledge/client";
import { createToolHandler } from "../common/handler";
import { defaultToolRuntime } from "../common/runtime";
import { type KnowledgeRuntime, searchProcedures } from "./handler";

let runtime: KnowledgeRuntime | undefined;

function knowledgeRuntime(): KnowledgeRuntime {
  if (runtime === undefined) {
    const base = defaultToolRuntime();
    const knowledge = knowledgeClient(async (clockId) => (await base.connector.worlds.getFaults(clockId))?.knowledge);
    runtime = { ...base, knowledge, catalog: createKnowledgeCatalog(base.connector.reference, base.realClock) };
  }
  return runtime;
}

export const knowledgeTools = createToolHandler({ target: "knowledge", deps: knowledgeRuntime, tools: [searchProcedures] });

export const handler = knowledgeTools.handler;
