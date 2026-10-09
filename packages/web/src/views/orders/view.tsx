// The day's work orders (`/app/orders`, docs/design-brief.md §6; FL-080): one row per order with its
// installer, fictitious customer, window, status, the five checklist marks, the ONU's last reading and
// its open cases. Order 24817 comes pinned first as the main story. The scope (field crew and day) is
// shared with the other views (IspContext); status and open cases filter on screen, counted. A row
// opens the detail of the order. It refreshes with the shell's clock poll.
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { type Column } from "../../components/Table";
import { DataTable } from "../../components/DataTable";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { ScopeBar } from "../../components/ScopeBar";
import { useIsp } from "../../context/IspContext";
import { useRouter } from "../../lib/router";
import { dataOf } from "../../lib/use-remote";
import type { ViewProps } from "../../lib/view-registry";
import { ChecklistMarks } from "./ChecklistMarks";
import { ordersCopy as copy } from "./copy";
import { dayLabel, dbm, nearbyDays, windowText } from "./format";
import { onuStateLabel, workOrderStatusLabel, workOrderStatusTone } from "./labels";
import {
  type CaseFilter,
  ORDERS_PROCEDURES,
  type OrderRow,
  OrdersPage,
  type StatusFilter,
  checklistProgress,
  crewIdsOf,
  inScope,
  crewLabel,
  filterOptions,
  filterRows,
  fullName,
  orderHref,
} from "./orders-model";
import { useCrewNames } from "./use-crew-names";
import { useLiveQuery } from "./use-field-data";

function OnuCell({ row }: { readonly row: OrderRow }) {
  if (row.onu === null) return <span className="text-slate">{copy.onuUnknown}</span>;
  return (
    <span className="flex flex-col">
      <span>{onuStateLabel[row.onu.operState]}</span>
      {row.onu.rxPowerDbm === undefined ? null : (
        <span className={`tabular-nums text-xs ${row.onu.inRange ? "text-slate" : "text-danger"}`}>
          {dbm(row.onu.rxPowerDbm)}
          {row.onu.inRange ? "" : ` · ${copy.onuOutOfRange}`}
        </span>
      )}
    </span>
  );
}

function columnsOf(crewOf: (crewId: string) => string): Column<OrderRow>[] {
  return [
    {
      id: "order",
      header: copy.columns.order,
      cell: (row) => (
        <span className="flex flex-col items-start gap-1">
          <span className="font-semibold text-navy">{row.workOrderNumber}</span>
          {row.mainStory ? <Badge tone="brand">{copy.mainStory}</Badge> : null}
        </span>
      ),
    },
    {
      id: "installer",
      header: copy.columns.installer,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{fullName(row.installer)}</span>
          <span className="text-xs text-slate">{crewOf(row.crewId)}</span>
        </span>
      ),
    },
    {
      id: "customer",
      header: copy.columns.customer,
      cell: (row) => (
        <span className="flex flex-col">
          <span>{fullName(row.customer)}</span>
          {row.customer ? <span className="text-xs text-slate">{row.customer.neighborhood}</span> : null}
        </span>
      ),
    },
    { id: "window", header: copy.columns.window, cell: (row) => <span className="tabular-nums">{windowText(row.window)}</span> },
    {
      id: "status",
      header: copy.columns.status,
      cell: (row) => (
        <span className="flex flex-col items-start gap-1">
          <Badge tone={workOrderStatusTone[row.status]}>{workOrderStatusLabel[row.status]}</Badge>
          {row.onHoldSafety ? <Badge tone="danger">{copy.onHoldSafety}</Badge> : null}
        </span>
      ),
    },
    {
      id: "checklist",
      header: copy.columns.checklist,
      cell: (row) => {
        const progress = checklistProgress(row.checklist);
        return (
          <span className="flex flex-col gap-1">
            <ChecklistMarks checklist={row.checklist} label={`${copy.columns.checklist} · ${copy.checklistProgress(progress.done, progress.total)}`} />
            <span className="text-xs text-slate">{copy.checklistProgress(progress.done, progress.total)}</span>
          </span>
        );
      },
    },
    { id: "onu", header: copy.columns.onu, cell: (row) => <OnuCell row={row} /> },
    {
      id: "cases",
      header: copy.columns.cases,
      cell: (row) => (row.openCases > 0 ? <Badge tone="warning">{copy.openCases(row.openCases)}</Badge> : <span className="text-slate">{copy.noCases}</span>),
    },
  ];
}

interface OrdersTableProps {
  readonly rows: readonly OrderRow[];
  readonly crewOf: (crewId: string) => string;
}

function OrdersTable({ rows: all, crewOf }: OrdersTableProps) {
  const { navigate } = useRouter();
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [cases, setCases] = useState<CaseFilter>("ALL");
  const { statusOptions, caseOptions } = filterOptions(all, status, cases, copy.filters);
  const rows = filterRows(all, status, cases);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <FilterPills label={copy.filters.statusLabel} options={statusOptions} value={status} onChange={setStatus} />
        <FilterPills label={copy.filters.casesLabel} options={caseOptions} value={cases} onChange={setCases} variant="segmented" />
      </div>
      <p className="text-xs text-slate">{copy.checklistLegend}</p>
      <DataTable
        caption={copy.caption}
        columns={columnsOf(crewOf)}
        rows={rows}
        keyOf={(row) => row.workOrderId}
        emptyTitle={copy.emptyTitle}
        emptyLead={copy.emptyLead}
        onRowClick={(row) => navigate(orderHref(row.workOrderId))}
      />
    </div>
  );
}

export default function OrdersView(_props: ViewProps) {
  const { scope, setScope } = useIsp();
  // The crew filters on screen, so the crews of the whole day stay on offer while one is chosen.
  const remote = useLiveQuery(ORDERS_PROCEDURES.list, scope.day === undefined ? undefined : { day: scope.day }, OrdersPage);
  const page = dataOf(remote.state);
  const today = page?.simNow.slice(0, 10);
  const crews = page ? crewIdsOf(page.workOrders) : [];
  const names = useCrewNames(crews);
  const crewOf = (crewId: string) => crewLabel(crewId, names, crews, copy.scope.crewFallback);
  const days = today === undefined ? undefined : nearbyDays(today);

  return (
    <div>
      <PageHeader title={copy.title} description={copy.description} />
      {days && today ? (
        <div className="mb-4">
          <ScopeBar
            label={copy.scope.label}
            crews={{ label: copy.scope.crews, allLabel: copy.scope.allCrews, options: crews.map((crewId) => ({ value: crewId, label: crewOf(crewId) })) }}
            days={{
              label: copy.scope.day,
              options: [
                { value: days[0], label: dayLabel(days[0], today, copy.scope.today) },
                ...[...days.slice(1)].sort().map((day) => ({ value: day, label: dayLabel(day, today, copy.scope.today) })),
              ],
            }}
            value={scope.day === undefined ? { ...scope, day: page?.day ?? today } : scope}
            onChange={setScope}
          />
        </div>
      ) : null}
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(data) => <OrdersTable rows={inScope(data.workOrders, scope.crewId)} crewOf={crewOf} />}
      </RemoteBlock>
    </div>
  );
}
