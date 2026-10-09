// Cases (`/app/cases` and `/app/cases/:caseId`, docs/design-brief.md §6; FL-051, FL-055, FL-065): the
// inbox by status and reason, newest first, and the detail of one case with its ladder, its bridge and
// "Tomar" / "Cerrar". Both refresh with the shell's clock poll.
import { useState } from "react";
import type { CaseReason } from "@cuadrilla/shared";
import { Badge } from "../../components/Badge";
import { DataTable } from "../../components/DataTable";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { SelectField } from "../../components/SelectField";
import type { Column } from "../../components/Table";
import { Link, useRouter } from "../../lib/router";
import { dataOf } from "../../lib/use-remote";
import type { ViewProps } from "../../lib/view-registry";
import { clockTime } from "../orders/format";
import { caseReasonLabel, caseStatusLabel, caseStatusTone, rungLabel } from "../orders/labels";
import { useLiveQuery } from "../orders/use-field-data";
import { CaseDetailBody, caseTitle } from "./CaseDetail";
import { CASES_HOME, CASES_PROCEDURES, CaseDetail, CaseList, type CaseSummary, type StatusFilter, caseHref, filterCases, isConsoleOnly, matchesStatus, reasonsOf } from "./cases-model";
import { casesCopy as copy } from "./copy";

const STATUS_FILTERS: readonly StatusFilter[] = ["ACTIVE", "OPEN", "TAKEN", "CLOSED", "ALL"];

const COLUMNS: readonly Column<CaseSummary>[] = [
  {
    id: "reason",
    header: copy.columns.reason,
    cell: (row) => (
      <span className="flex flex-col items-start gap-1">
        <span className="font-semibold text-navy">{caseReasonLabel[row.reason]}</span>
        {isConsoleOnly(row.reason) ? <Badge tone="info">{copy.consoleOnly}</Badge> : null}
      </span>
    ),
  },
  { id: "order", header: copy.columns.order, cell: (row) => copy.order(row.workOrderNumber) },
  { id: "installer", header: copy.columns.installer, cell: (row) => row.installer ?? "—" },
  {
    id: "rung",
    header: copy.columns.rung,
    cell: (row) => (
      <span className="flex flex-col">
        <span>{rungLabel[row.rung]}</span>
        {row.takenBy ? <span className="text-xs text-slate">{copy.takenBy(row.takenBy)}</span> : null}
      </span>
    ),
  },
  { id: "status", header: copy.columns.status, cell: (row) => <Badge tone={caseStatusTone[row.status]}>{caseStatusLabel[row.status]}</Badge> },
  { id: "opened", header: copy.columns.opened, cell: (row) => <span className="tabular-nums">{clockTime(row.createdAtSim)}</span> },
];

function Inbox({ rows }: { readonly rows: readonly CaseSummary[] }) {
  const { navigate } = useRouter();
  const [status, setStatus] = useState<StatusFilter>("ACTIVE");
  const [reason, setReason] = useState<CaseReason | "ALL">("ALL");
  const reasons = reasonsOf(rows.filter((row) => matchesStatus(row, status)));
  // A reason the status filter left without cases falls back to every reason.
  const reasonFilter = reasons.some((option) => option.reason === reason) ? reason : "ALL";
  const shown = filterCases(rows, status, reasonFilter);
  const statusOptions = STATUS_FILTERS.map((value) => ({ value, label: copy.statusFilters[value], count: rows.filter((row) => matchesStatus(row, value)).length }));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <FilterPills label={copy.statusLabel} options={statusOptions} value={status} onChange={setStatus} />
        <SelectField
          label={copy.reasonLabel}
          value={reasonFilter}
          options={[{ value: "ALL" as const, label: copy.allReasons }, ...reasons.map((option) => ({ value: option.reason, label: `${caseReasonLabel[option.reason]} (${option.count})` }))]}
          onChange={setReason}
          className="min-w-64"
        />
      </div>
      <DataTable caption={copy.caption} columns={COLUMNS} rows={shown} keyOf={(row) => row.caseId} emptyTitle={copy.emptyTitle} emptyLead={copy.emptyLead} onRowClick={(row) => navigate(caseHref(row.caseId))} />
    </div>
  );
}

function CaseInbox() {
  const remote = useLiveQuery(CASES_PROCEDURES.list, undefined, CaseList);
  return (
    <div>
      <PageHeader title={copy.title} description={copy.description} />
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(rows) => <Inbox rows={rows} />}
      </RemoteBlock>
    </div>
  );
}

function OneCase({ caseId }: { readonly caseId: string }) {
  const remote = useLiveQuery(CASES_PROCEDURES.get, { caseId }, CaseDetail);
  const detail = dataOf(remote.state);
  return (
    <div>
      <Link to={CASES_HOME} className="mb-3 inline-block text-sm font-semibold text-cyan-deep underline">
        {copy.detail.back}
      </Link>
      <PageHeader title={caseTitle(detail)} {...(detail?.workOrderNumber ? { description: copy.order(detail.workOrderNumber) } : {})} />
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(data) => <CaseDetailBody detail={data} onChanged={remote.reload} />}
      </RemoteBlock>
    </div>
  );
}

export default function CasesView({ params }: ViewProps) {
  return params.caseId ? <OneCase caseId={params.caseId} /> : <CaseInbox />;
}
