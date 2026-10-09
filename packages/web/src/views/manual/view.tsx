// Manual (`/app/manual` and `/app/manual/:sectionId`, docs/design-brief.md §6; FL-028, FL-090): the
// operator's procedures manual in force, read only, with the visible name of the operator and the
// synthetic-demo notice (in co-branding, the mandatory disclaimer, ADR-0018). Every section shows its id:
// it is the target of each citation's link ("(Manual v1, §COM-04)" opens `/app/manual/COM-04`), and a
// `§ID` inside a section opens that one.
import { Fragment } from "react";
import { Callout } from "../../components/Callout";
import { EmptyState } from "../../components/EmptyState";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { useSession } from "../../context/SessionContext";
import { copy as consoleCopy } from "../../copy/console";
import { Link } from "../../lib/router";
import { useRemote, useRemoteInput } from "../../lib/use-remote";
import type { ViewProps } from "../../lib/view-registry";
import { pathOf } from "../../routes";
import { manualCopy as copy } from "./copy";
import { type Block, type Inline, type SectionSummary, blocksOf, groupedSections, selectedSection } from "./manual-model";

const sectionPath = (sectionId: string) => `${pathOf("manual")}/${sectionId}`;

function Inlines({ parts }: { readonly parts: readonly Inline[] }) {
  return (
    <>
      {parts.map((part, index) => {
        const key = `${part.kind}-${index}`;
        if (part.kind === "em") return <em key={key}>{part.text}</em>;
        if (part.kind === "ref")
          return (
            <Link key={key} to={sectionPath(part.sectionId)} className="font-semibold text-cyan-deep underline">
              §{part.sectionId}
            </Link>
          );
        return <Fragment key={key}>{part.text}</Fragment>;
      })}
    </>
  );
}

function SectionBody({ blocks }: { readonly blocks: readonly Block[] }) {
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-ink">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "heading")
          return (
            <h3 key={key} className="mt-2 text-base font-semibold text-navy">
              <Inlines parts={block.inlines} />
            </h3>
          );
        if (block.kind === "list")
          return (
            <ul key={key} className="list-disc space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>
                  <Inlines parts={item} />
                </li>
              ))}
            </ul>
          );
        return (
          <p key={key}>
            <Inlines parts={block.inlines} />
          </p>
        );
      })}
    </div>
  );
}

function SectionText({ section }: { readonly section: SectionSummary }) {
  const { trpc } = useSession();
  const text = useRemoteInput("manual.section", { sectionId: section.sectionId }, (input, signal) => trpc.manual.section.query(input, { signal }));
  return (
    <article aria-labelledby="manual-section-title" className="rounded-card border border-mist bg-white p-5 shadow-card">
      <h2 id="manual-section-title" className="text-lg font-semibold text-navy">
        {copy.sectionLabel(section.sectionId, section.title)}
      </h2>
      <div className="mt-3">
        <RemoteBlock state={text.state} onRetry={text.reload}>
          {(data) => <SectionBody blocks={blocksOf(data.text)} />}
        </RemoteBlock>
      </div>
    </article>
  );
}

export default function ManualView({ params }: ViewProps) {
  const { trpc } = useSession();
  const manual = useRemote("manual.sections", (signal) => trpc.manual.sections.query(undefined, { signal }));
  const sectionId = params.sectionId;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={consoleCopy.views.manual.title} description={consoleCopy.views.manual.description} />
      <RemoteBlock state={manual.state} onRetry={manual.reload}>
        {(data) => {
          const selected = selectedSection(data.sections, sectionId);
          return (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <p className="text-base font-semibold text-navy">{copy.operator(data.operator.operatorName)}</p>
                <p className="text-sm text-slate">
                  {copy.version(data.label)} · {copy.readOnly}
                </p>
                <Callout tone={data.operator.mode === "cobrand" ? "warning" : "info"}>{data.operator.notice.es}</Callout>
              </div>
              <div className="flex flex-col gap-6 lg:flex-row">
                <nav aria-label={copy.sections} className="lg:w-80 lg:shrink-0">
                  {groupedSections(data.sections).map((group) => (
                    <div key={group.category} className="mb-4">
                      <p className="text-xs font-semibold uppercase tracking-widest text-slate">{group.title}</p>
                      <ul className="mt-1 space-y-0.5">
                        {group.sections.map((section) => {
                          const active = section.sectionId === selected?.sectionId;
                          return (
                            <li key={section.sectionId}>
                              <Link
                                to={sectionPath(section.sectionId)}
                                aria-current={active ? "page" : undefined}
                                className={`block rounded-md px-2 py-1.5 text-sm ${active ? "bg-navy text-white" : "text-navy hover:bg-mist"}`}
                              >
                                {copy.sectionLabel(section.sectionId, section.title)}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </nav>
                <div className="min-w-0 flex-1">
                  {selected ? <SectionText key={selected.sectionId} section={selected} /> : <EmptyState title={sectionId === undefined ? copy.choose : copy.notFound} />}
                </div>
              </div>
            </div>
          );
        }}
      </RemoteBlock>
    </div>
  );
}
