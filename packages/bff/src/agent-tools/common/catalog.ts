// The 12 Gateway tools by target (docs/tool-catalog.md, docs/design-brief.md §5.3), in chain order.
// `npm run tools:build-schemas` writes the Gateway payloads from here; each target's Lambda serves
// the tools of its entry. Direct-invocation handlers (docs/tool-catalog.md) are not Gateway tools.
import { CASES_TOOLS } from "../cases/schema";
import { EVIDENCE_TOOLS } from "../evidence/schema";
import { KNOWLEDGE_TOOLS } from "../knowledge/schema";
import { MESSAGING_TOOLS } from "../messaging/schema";
import { ORDERS_TOOLS } from "../orders/schema";
import { TOOL_TARGETS, type ToolDefinition, type ToolTarget } from "./definition";

export const TOOL_CATALOG: Readonly<Record<ToolTarget, readonly ToolDefinition[]>> = {
  orders: ORDERS_TOOLS,
  knowledge: KNOWLEDGE_TOOLS,
  evidence: EVIDENCE_TOOLS,
  messaging: MESSAGING_TOOLS,
  cases: CASES_TOOLS,
};

/** Every Gateway tool, in target order. */
export function catalogTools(catalog: Readonly<Record<ToolTarget, readonly ToolDefinition[]>> = TOOL_CATALOG): ToolDefinition[] {
  return TOOL_TARGETS.flatMap((target) => [...catalog[target]]);
}
