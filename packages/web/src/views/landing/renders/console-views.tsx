// The gallery's renders: the console's views of docs/design-brief.md §6 in a fixed state of the main
// story (the day's orders, the timeline of order 24817, the manual section it cites, the metrics, the
// decision log and the simulated clock), built with the console's components (PageHeader, Table, Badge,
// StatTile, RuleChips, ClockBanner) and the texts of copy/, the story and the seed's manual. Each one is
// drawn at the width of a desktop console; the gallery scales it down. WP-44 replaces them with captures.
import { type ReactNode, createContext, useContext } from "react";
import { Badge } from "../../../components/Badge";
import { ClockBanner } from "../../../components/ClockBanner";
import { PageHeader } from "../../../components/PageHeader";
import { RuleChips } from "../../../components/RuleChips";
import { StatGrid, StatTile } from "../../../components/StatTile";
import { Table } from "../../../components/Table";
import { firstNameOf, AUDIT_DECISIONS, CLOCK_TEXTS, ORDER_COLUMNS, VIEW_TEXTS, clockOf, manualBlocks, metricAreas, orderLabel, orderTimeline, simTimeText, storyEntry, storyOrders } from "./sources";
import type { StoryEntry } from "./sources";

/** How wide a console page draws: a desktop console's column, or the narrower one a gallery thumbnail reflows into. */
export type ConsolePageWidth = "page" | "thumbnail";

export const CONSOLE_PAGE_WIDTHS: Readonly<Record<ConsolePageWidth, number>> = { page: 960, thumbnail: 600 };

const ConsolePageWidthContext = createContext<ConsolePageWidth>("page");

export const ConsolePageWidthProvider = ConsolePageWidthContext.Provider;

/** A console page: the paper background and the view's padding, at the width of its context. */
function ConsolePage({ children }: { readonly children: ReactNode }) {
  const width = useContext(ConsolePageWidthContext);
  return <div className={`${width === "thumbnail" ? "w-150" : "w-240"} bg-paper p-6 text-left`}>{children}</div>;
}

function GalleryOrders() {
  const rows = storyOrders();
  return (
    <ConsolePage>
      <PageHeader title={VIEW_TEXTS.orders.title} description={VIEW_TEXTS.orders.description} />
      <Table
        rows={rows}
        keyOf={(row) => row.workOrderNumber}
        emptyTitle={VIEW_TEXTS.orders.title}
        caption={VIEW_TEXTS.orders.title}
        columns={[
          { id: "order", header: ORDER_COLUMNS.order, cell: (row) => <span className="font-semibold text-navy">{orderLabel(row.workOrderNumber)}</span> },
          { id: "installer", header: ORDER_COLUMNS.installer, cell: (row) => row.installer },
          { id: "customer", header: ORDER_COLUMNS.customer, cell: (row) => row.customer },
          { id: "status", header: ORDER_COLUMNS.checklist, cell: (row) => <Badge tone={row.status.tone}>{row.status.text}</Badge> },
        ]}
      />
    </ConsolePage>
  );
}

function timelineText(entry: StoryEntry): string {
  return entry.text;
}

function GalleryOrderDetail() {
  const entries = orderTimeline();
  const order = entries[0]?.workOrderNumber ?? "";
  return (
    <ConsolePage>
      <PageHeader title={`${VIEW_TEXTS["order-detail"].title} · ${orderLabel(order)}`} description={VIEW_TEXTS["order-detail"].description} />
      <ol className="space-y-2 rounded-card border border-mist bg-white p-4 shadow-card">
        {entries.map((entry) => (
          <li key={entry.id} className="grid grid-cols-12 gap-3 border-b border-mist pb-2 text-sm last:border-b-0 last:pb-0">
            <span className="col-span-1 font-mono text-xs tabular-nums text-slate">{clockOf(entry)}</span>
            <span className="col-span-2 truncate font-semibold text-navy">{firstNameOf(entry.from)}</span>
            <span className="col-span-9 flex items-start gap-2 text-ink">
              {entry.kind === "PHOTO" ? <span aria-hidden="true">{entry.reaction}</span> : null}
              <span className="line-clamp-2">{timelineText(entry)}</span>
            </span>
          </li>
        ))}
      </ol>
    </ConsolePage>
  );
}

function GalleryManual() {
  const blocks = manualBlocks();
  return (
    <ConsolePage>
      <PageHeader title={VIEW_TEXTS.manual.title} description={VIEW_TEXTS.manual.description} />
      <article className="rounded-card border border-mist bg-white p-6 shadow-card">
        {blocks.map((block, index) => {
          if (block.kind === "heading") return <h3 key={index} className="font-display text-xl font-semibold text-navy">{block.text}</h3>;
          if (block.kind === "note") return <p key={index} className="mt-1 text-xs italic text-slate">{block.text}</p>;
          if (block.kind === "step") return <p key={index} className="mt-2 border-l-2 border-info pl-3 text-sm text-ink">{block.text}</p>;
          return <p key={index} className="mt-3 text-sm text-ink">{block.text}</p>;
        })}
      </article>
    </ConsolePage>
  );
}

function GalleryMetrics() {
  return (
    <ConsolePage>
      <PageHeader title={VIEW_TEXTS.metrics.title} description={VIEW_TEXTS.metrics.description} />
      <StatGrid>
        {metricAreas().map((area) => (
          <StatTile key={area} label={area} value="—" />
        ))}
      </StatGrid>
    </ConsolePage>
  );
}

function GalleryAudit() {
  return (
    <ConsolePage>
      <PageHeader title={VIEW_TEXTS.audit.title} description={VIEW_TEXTS.audit.description} />
      <ol className="space-y-2 rounded-card border border-mist bg-white p-4 shadow-card">
        {AUDIT_DECISIONS.map(({ entryId, ruleIds }) => {
          const entry = storyEntry(entryId);
          return (
            <li key={entryId} className="grid grid-cols-12 items-start gap-3 border-b border-mist pb-2 text-sm last:border-b-0 last:pb-0">
              <span className="col-span-1 font-mono text-xs tabular-nums text-slate">{clockOf(entry)}</span>
              <span className="col-span-2 text-xs font-semibold text-navy">{orderLabel(entry.workOrderNumber)}</span>
              <span className="col-span-3">
                <RuleChips ruleIds={ruleIds} label={VIEW_TEXTS.audit.title} />
              </span>
              <span className="col-span-6 line-clamp-2 text-ink">{entry.text}</span>
            </li>
          );
        })}
      </ol>
    </ConsolePage>
  );
}

function GalleryClock() {
  const onSite = storyEntry("s1-voice-note");
  const noop = () => undefined;
  return (
    <ConsolePage>
      <div className="-mx-6 -mt-6 mb-6">
        <ClockBanner
          label={CLOCK_TEXTS.label}
          time={simTimeText(onSite)}
          mode={CLOCK_TEXTS.paused}
          actionsLabel={CLOCK_TEXTS.controls}
          actions={[
            { id: "next", label: CLOCK_TEXTS.advanceToNext, onClick: noop },
            { id: "10", label: CLOCK_TEXTS.advance[10], onClick: noop },
            { id: "60", label: CLOCK_TEXTS.advance[60], onClick: noop },
          ]}
        />
      </div>
      <PageHeader title={VIEW_TEXTS.clock.title} description={VIEW_TEXTS.clock.description} />
    </ConsolePage>
  );
}

export const GALLERY_RENDERS = {
  "gallery-orders": GalleryOrders,
  "gallery-order-detail": GalleryOrderDetail,
  "gallery-manual": GalleryManual,
  "gallery-metrics": GalleryMetrics,
  "gallery-audit": GalleryAudit,
  "gallery-clock": GalleryClock,
} as const;
