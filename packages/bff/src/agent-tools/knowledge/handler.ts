// `search_procedures` (docs/tool-catalog.md, target `knowledge`; FL-028, FL-030, FL-034): the passages
// of the manual in force that answer a question, each with its section id, so every policy or procedure
// the agent states is cited from this call of the same turn (`CP-CITATION`). Rules:
//
//   - `Retrieve` with 5 results, filtered by the manual version in force (and the category, if asked);
//   - a passage whose section is not in the index of that version is dropped (never cite a ghost);
//   - a passage under the score threshold in force (`Reference/KBTHRESHOLD#<version>`) is dropped, and
//     with none left the answer is `coverage: NONE`: the manual does not cover it, nothing is invented;
//   - one passage per section (its best chunk), at most 1.200 characters, best score first;
//   - a Knowledge Base that cannot answer is `coverage: UNAVAILABLE`, not an error of the turn.
//
// The output is stored for the turn (`RESULT#search_procedures`): G2's grounding source and the
// sections `CP-CITATION` accepts.
import { ok } from "@cuadrilla/shared";
import type { KnowledgeCatalog, KnowledgeCatalogSnapshot } from "../../knowledge/catalog";
import { manualLabel } from "../../knowledge/catalog";
import type { KnowledgeClient, RetrievedChunk } from "../../knowledge/client";
import { type ToolContext, type ToolImplementation, type ToolRuntime, implementTool } from "../common/context";
import { PASSAGE_MAX_CHARS, searchProceduresTool } from "./schema";

export interface KnowledgeRuntime extends ToolRuntime {
  readonly knowledge: KnowledgeClient;
  readonly catalog: KnowledgeCatalog;
}

type KnowledgeContext = ToolContext<KnowledgeRuntime>;

/** Citation format of a manual version: "(Manual v1, §{sectionId})". */
export function citationFormat(manualVersion?: string): string {
  return `(Manual${manualVersion === undefined ? "" : ` ${manualLabel(manualVersion)}`}, §{sectionId})`;
}

function clip(text: string): string {
  return text.length <= PASSAGE_MAX_CHARS ? text : `${text.slice(0, PASSAGE_MAX_CHARS - 1).trimEnd()}…`;
}

/** The passages worth citing: in the index of the version, over the threshold, one per section. */
export function passagesOf(chunks: readonly RetrievedChunk[], catalog: KnowledgeCatalogSnapshot) {
  const best = new Map<string, RetrievedChunk>();
  for (const chunk of chunks) {
    if (chunk.manualVersion !== undefined && chunk.manualVersion !== catalog.manualVersion) continue;
    if (!catalog.sections.has(chunk.sectionId) || chunk.score < catalog.threshold) continue;
    const kept = best.get(chunk.sectionId);
    if (kept === undefined || chunk.score > kept.score) best.set(chunk.sectionId, chunk);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || (a.sectionId < b.sectionId ? -1 : 1))
    .map((chunk) => ({ sectionId: chunk.sectionId, title: catalog.sections.get(chunk.sectionId)?.title ?? chunk.title ?? chunk.sectionId, text: clip(chunk.text), score: chunk.score }));
}

export const searchProcedures: ToolImplementation<KnowledgeRuntime> = implementTool(searchProceduresTool, async (args, ctx: KnowledgeContext) => {
  let catalog: KnowledgeCatalogSnapshot;
  try {
    catalog = await ctx.deps.catalog.current();
  } catch (error) {
    ctx.logger.warn("knowledge.catalog_unavailable", { error });
    return ok({ coverage: "UNAVAILABLE", passages: [], citationFormat: citationFormat() });
  }
  const answer = { manualVersion: catalog.manualVersion, citationFormat: citationFormat(catalog.manualVersion) };
  const outcome = await ctx.deps.knowledge.retrieve({ clockId: ctx.scope.clockId, query: args.query, manualVersion: catalog.manualVersion, ...(args.category === undefined ? {} : { category: args.category }), logger: ctx.logger });
  if (outcome.kind === "UNAVAILABLE") return ok({ coverage: "UNAVAILABLE", passages: [], ...answer });
  const passages = passagesOf(outcome.chunks, catalog);
  // Scores only (never the query): the distribution `EV-01` recalibrates the threshold with.
  ctx.logger.info("knowledge.coverage", {
    coverage: passages.length > 0 ? "FOUND" : "NONE",
    scores: outcome.chunks.map((chunk) => Math.round(chunk.score * 1000) / 1000),
    threshold: catalog.threshold,
    thresholdVersion: catalog.thresholdVersion,
  });
  return ok({ coverage: passages.length > 0 ? "FOUND" : "NONE", passages, ...answer });
});
