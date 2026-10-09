// Métricas (`/app/metrics`, docs/design-brief.md §8; FL-087): the five tabs of `metrics.summary` — "Este
// mundo", "Medición del manual", "Medición de fotos", "Latencia y costo" (p50 and p95, the day's use of
// the global ceiling and the state of the cut) and "Política" — every KPI with its N, source, target and
// label. "Exportar CSV" downloads the same figures (`metrics.export`). The figures follow the shell's
// clock poll.
import { useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { EmptyState } from "../../components/EmptyState";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { StatGrid, StatTile } from "../../components/StatTile";
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { useAction, useRemote } from "../../lib/use-remote";
import type { ViewProps } from "../../lib/view-registry";
import { metricsCopy as copy } from "./copy";
import { type MetricsTab, type TabId, formatValue, kpiHint, kpiTone, orderedTabs } from "./metrics-model";

function download(fileName: string, contentType: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function TabBody({ tab }: { readonly tab: MetricsTab }) {
  if (tab.kpis.length === 0) return <EmptyState title={copy.empty} />;
  const cut = tab.kpis.find((kpi) => kpi.id === "killSwitch");
  return (
    <section aria-labelledby="metrics-tab-title" className="flex flex-col gap-4">
      <h2 id="metrics-tab-title" className="text-lg font-semibold text-navy">
        {tab.title.es}
      </h2>
      {cut ? <Callout tone={cut.value === 0 ? "success" : "danger"} title={copy.ceilingTitle}>{cut.value === 0 ? copy.cutOff : copy.cutOn}</Callout> : null}
      <StatGrid>
        {tab.kpis.map((kpi) => (
          <StatTile key={kpi.id} label={kpi.label.es} value={formatValue(kpi)} hint={kpiHint(kpi)} tone={kpiTone(kpi)} />
        ))}
      </StatGrid>
    </section>
  );
}

export default function MetricsView(_props: ViewProps) {
  const { trpc } = useSession();
  const { tick } = useWorldClock();
  const [tab, setTab] = useState<TabId>("WORLD");
  const summary = useRemote(`metrics.summary:${tick}`, (signal) => trpc.metrics.summary.query(undefined, { signal }));
  const exporter = useAction(async (selected: TabId) => {
    const file = await trpc.metrics.export.query({ tab: selected });
    download(file.fileName, file.contentType, file.csv);
    return file.fileName;
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={consoleCopy.views.metrics.title}
        description={consoleCopy.views.metrics.description}
        actions={
          <Button variant="secondary" disabled={exporter.state.status === "running"} onClick={() => void exporter.run(tab)}>
            {exporter.state.status === "running" ? copy.exporting : copy.export}
          </Button>
        }
      />
      <p className="text-sm text-slate">{copy.legend}</p>
      {exporter.state.status === "done" ? <p className="text-sm text-success">{copy.exported(exporter.state.data)}</p> : null}
      {exporter.state.status === "error" ? <ApiErrorNotice error={exporter.state.error} /> : null}
      <RemoteBlock state={summary.state} onRetry={summary.reload}>
        {(data) => {
          const tabs = orderedTabs(data.tabs);
          const current = tabs.find((candidate) => candidate.tab === tab) ?? tabs[0];
          return (
            <div className="flex flex-col gap-4">
              <FilterPills label={copy.tabs} value={current?.tab ?? tab} onChange={setTab} options={tabs.map((candidate) => ({ value: candidate.tab, label: candidate.title.es }))} />
              {current ? <TabBody tab={current} /> : <EmptyState title={copy.empty} />}
            </div>
          );
        }}
      </RemoteBlock>
    </div>
  );
}
