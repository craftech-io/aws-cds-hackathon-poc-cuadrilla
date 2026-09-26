// Target `knowledge` (`ToolKnowledge`, docs/tool-catalog.md): retrieval over the operator's manual in
// the Bedrock Knowledge Base. Every policy or procedure the agent states comes from here and is cited
// with the section ids this call returned in the same turn (`CP-CITATION`).
import { z } from "zod";
import { ManualCategory, ManualSectionId } from "@cuadrilla/shared";
import { defineTool } from "../common/definition";
import { boundedText } from "../common/fields";

/** Characters of a passage the tool returns (docs/tool-catalog.md, `search_procedures`). */
export const PASSAGE_MAX_CHARS = 1_200;

export const searchProceduresTool = defineTool({
  target: "knowledge",
  name: "search_procedures",
  description:
    "Searches the operator's procedures manual and returns the passages that answer, each with its section id, title and score, plus the citation format to use. coverage NONE means the manual does not cover it: say so and offer to escalate; never answer a policy or procedure from memory. coverage UNAVAILABLE means the manual could not be read now.",
  principals: ["HARNESS", "CONSOLE"],
  args: z.strictObject({
    query: boundedText(300, "What to look up, in Spanish, in the installer's words or the manual's"),
    category: ManualCategory.optional().describe("Manual category to narrow the search to"),
  }),
  output: z.strictObject({
    coverage: z.enum(["FOUND", "NONE", "UNAVAILABLE"]),
    manualVersion: z.string().optional(),
    passages: z.array(
      z.strictObject({
        sectionId: ManualSectionId,
        title: z.string(),
        text: z.string().max(PASSAGE_MAX_CHARS),
        score: z.number(),
      }),
    ),
    citationFormat: z.string(),
  }),
});

export const KNOWLEDGE_TOOLS = [searchProceduresTool] as const;
