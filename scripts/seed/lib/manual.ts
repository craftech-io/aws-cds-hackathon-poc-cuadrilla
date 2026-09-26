// File format of the manual (docs/seed-spec.md §8, docs/architecture-integrations.md §8): one Markdown
// file per section whose first line is `# <sectionId> · <title>`, a version line, the body, and a
// sidecar `<sectionId>.md.metadata.json` with the filterable attributes of the Knowledge Base. The
// generator writes it, `npm run manual:check` and `seed:validate` read it back, and `seed:load`
// uploads both files to `Manual/manual/v<nnn>/`.
import { z } from "zod";
import { ManualCategory, ManualSectionId, VersionTag, manualCategoryOf } from "@cuadrilla/shared";

/** Second line of every section: the version and the synthetic-demo label. */
export const VERSION_LINE = "_Manual v1 · demo sintética: procedimientos generales y políticas comerciales inventadas._";

/** The number of sections of v001 (docs/seed-spec.md §8). */
export const MANUAL_SECTION_COUNT = 32;

const HEADING = /^# ([A-Z]+-\d{2}) · (.+)$/;

export const ManualSidecar = z
  .object({
    metadataAttributes: z
      .object({
        sectionId: ManualSectionId,
        title: z.string().trim().min(1).max(200),
        manualVersion: VersionTag,
        category: ManualCategory,
        ispScope: z.literal("all"),
      })
      .strict(),
  })
  .strict();
export type ManualSidecar = z.infer<typeof ManualSidecar>;

export function renderSectionFile(sectionId: string, title: string, body: string): string {
  return `# ${sectionId} · ${title}\n\n${VERSION_LINE}\n\n${body.trim()}\n`;
}

export function sidecarOf(sectionId: string, title: string, manualVersion: string): ManualSidecar {
  return { metadataAttributes: { sectionId, title, manualVersion, category: manualCategoryOf(sectionId), ispScope: "all" } };
}

export interface ParsedSection {
  readonly sectionId: string;
  readonly title: string;
  readonly hasVersionLine: boolean;
  /** Everything after the version line. */
  readonly body: string;
}

/** The heading, version line and body of a section file; `undefined` when the first line is not a heading. */
export function parseSectionFile(text: string): ParsedSection | undefined {
  const lines = text.split("\n");
  const heading = HEADING.exec(lines[0] ?? "");
  if (heading === null) return undefined;
  const rest = lines.slice(1);
  const versionIndex = rest.findIndex((line) => line.trim() !== "");
  const hasVersionLine = versionIndex >= 0 && rest[versionIndex]?.trim() === VERSION_LINE;
  const body = (hasVersionLine ? rest.slice(versionIndex + 1) : rest).join("\n").trim();
  return { sectionId: heading[1] ?? "", title: (heading[2] ?? "").trim(), hasVersionLine, body };
}

/** Paragraphs of a body: blocks separated by blank lines, trimmed. */
export function paragraphsOf(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
}
