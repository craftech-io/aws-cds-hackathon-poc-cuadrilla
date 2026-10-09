// `manual` router of the console (docs/tool-catalog.md; FL-090): the operator's procedures manual in
// force, read only, with the id of each section (the target of every citation's link: "(Manual v1,
// §COM-04)" opens `COM-04`).
//
//   sections   the version in force (`Reference/MANUALINDEX#v<nnn>`, knowledge/catalog.ts) and its
//              sections by id, with the operator's visible name and, in co-branding, the synthetic-demo
//              disclaimer the viewer must show (ADR-0018)
//   section    the text of one section (`Manual/manual/<version>/<sectionId>.md`)
import { z } from "zod";
import { ManualSectionId, ToolError } from "@cuadrilla/shared";
import { createKnowledgeCatalog, manualLabel } from "../knowledge/catalog";
import { brandView } from "./brand";
import { consoleCall } from "./console-ports";
import { type IspContext, ispProcedure, router } from "./trpc";

const BySection = z.object({ sectionId: ManualSectionId }).strict();

type Ctx = Pick<IspContext, "deps" | "world" | "principal">;

async function catalogOf(ctx: Ctx) {
  const { ports } = consoleCall(ctx);
  return createKnowledgeCatalog(ctx.deps.connector.reference, ports.services.realClock).current();
}

async function operatorOf(ctx: Ctx) {
  const { ports } = consoleCall(ctx);
  const [isp, brand] = await Promise.all([ctx.deps.connector.isps.getIsp(ctx.world.ispId), brandView(ports)]);
  return { operatorName: isp?.displayName ?? brand.displayName, mode: brand.mode, disclaimer: brand.disclaimer, notice: brand.notice };
}

export const manualRouter = router({
  sections: ispProcedure.query(async ({ ctx }) => {
    const [catalog, operator] = await Promise.all([catalogOf(ctx), operatorOf(ctx)]);
    return {
      manualVersion: catalog.manualVersion,
      label: manualLabel(catalog.manualVersion),
      operator,
      sections: [...catalog.sections.values()].sort((a, b) => a.sectionId.localeCompare(b.sectionId)).map((section) => ({ sectionId: section.sectionId, title: section.title, category: section.category })),
    };
  }),
  section: ispProcedure.input(BySection).query(async ({ ctx, input }) => {
    const catalog = await catalogOf(ctx);
    const section = catalog.sections.get(input.sectionId);
    if (section === undefined) throw new ToolError("NOT_FOUND", "the manual in force has no such section");
    const text = await consoleCall(ctx).ports.objects.manualText(catalog.manualVersion, section.sectionId);
    if (text === undefined) throw new ToolError("NOT_FOUND", "the text of this section is not loaded");
    return { manualVersion: catalog.manualVersion, label: manualLabel(catalog.manualVersion), sectionId: section.sectionId, title: section.title, category: section.category, text };
  }),
});
