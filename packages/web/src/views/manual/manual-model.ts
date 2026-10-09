// The manual viewer's reading of a section (`manual.section`, Markdown as it is in the Knowledge Base):
// headings, paragraphs and lists as blocks, `_…_` as emphasis and every `§ID` as a link to that section,
// so a citation of the copilot ("(Manual v1, §COM-04)") and a cross reference inside a section both open
// in the viewer. No HTML is ever produced from the text: the view renders these pieces as React nodes.
// Pure: tested without a browser.
import type { RouterOutputs } from "../../lib/trpc-router";
import { manualCopy as copy } from "./copy";

export type SectionSummary = RouterOutputs["manual"]["sections"]["sections"][number];

export type Inline = { readonly kind: "text"; readonly text: string } | { readonly kind: "em"; readonly text: string } | { readonly kind: "ref"; readonly sectionId: string };

export type Block =
  | { readonly kind: "heading"; readonly inlines: readonly Inline[] }
  | { readonly kind: "paragraph"; readonly inlines: readonly Inline[] }
  | { readonly kind: "list"; readonly items: ReadonlyArray<readonly Inline[]> };

const SECTION_REF = /§([A-Z]{2,4}-\d{2})/g;
const EMPHASIS = /_([^_]+)_/g;

function withRefs(text: string): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(SECTION_REF)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: text.slice(last, index) });
    parts.push({ kind: "ref", sectionId: match[1] ?? "" });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** One line of text as inline pieces: emphasis and section references. */
export function inlinesOf(text: string): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(...withRefs(text.slice(last, index)));
    parts.push({ kind: "em", text: match[1] ?? "" });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(...withRefs(text.slice(last)));
  return parts;
}

/** The blocks of a section's Markdown; its first heading (the section's own title) is left out. */
export function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: Inline[][] | undefined;
  let titleSkipped = false;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", inlines: inlinesOf(paragraph.join(" ")) });
    paragraph = [];
    if (list !== undefined) blocks.push({ kind: "list", items: list });
    list = undefined;
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (line === "") flush();
    else if (heading) {
      flush();
      if (titleSkipped) blocks.push({ kind: "heading", inlines: inlinesOf(heading[1] ?? "") });
      titleSkipped = true;
    } else if (item) {
      if (paragraph.length > 0) flush();
      list = [...(list ?? []), inlinesOf(item[1] ?? "")];
    } else {
      if (list !== undefined) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

export interface CategoryGroup {
  readonly category: string;
  readonly title: string;
  readonly sections: readonly SectionSummary[];
}

/** The sections grouped by category, in the order of the categories of the manual. */
export function groupedSections(sections: readonly SectionSummary[]): CategoryGroup[] {
  const order = Object.keys(copy.categories);
  const groups = new Map<string, SectionSummary[]>();
  for (const section of sections) groups.set(section.category, [...(groups.get(section.category) ?? []), section]);
  return [...groups.entries()]
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? order.length : order.indexOf(a)) - (order.indexOf(b) === -1 ? order.length : order.indexOf(b)))
    .map(([category, list]) => ({ category, title: copy.categories[category] ?? copy.otherCategory, sections: list }));
}

/** The section the route asks for, when the manual in force has it. */
export function selectedSection(sections: readonly SectionSummary[], sectionId: string | undefined): SectionSummary | undefined {
  return sectionId === undefined ? undefined : sections.find((section) => section.sectionId === sectionId);
}
