// The blocks of the detail of an order that are not the timeline: the summary, the closing checklist with
// the manual validation of a photo (supervisors and guests), the ONU read live from the simulated
// network, the order's cases and the certificate with its deliveries and download.
import type { ReactNode } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { EmptyState } from "../../components/EmptyState";
import { RemoteBlock } from "../../components/RemoteBlock";
import { type Column, Table } from "../../components/Table";
import { Link } from "../../lib/router";
import { type ActionState, useRemote } from "../../lib/use-remote";
import { ManualValidation } from "../evidence/ManualValidation";
import { dbm, rangeText, simDateTime, windowText } from "../orders/format";
import {
  CHECKLIST_ORDER,
  caseReasonLabel,
  caseStatusLabel,
  caseStatusTone,
  checklistItemLabel,
  checklistStatusLabel,
  checklistStatusTone,
  deliveryTargetLabel,
  emailStatusLabel,
  labelOf,
  onuStateLabel,
  rejectReasonLabel,
  rungLabel,
  workOrderStatusLabel,
} from "../orders/labels";
import { fullName } from "../orders/orders-model";
import { useConsoleApi } from "../orders/use-field-data";
import { caseHref } from "../cases/cases-model";
import { detailCopy } from "./copy";
import { type ChecklistEntryView, DETAIL_PROCEDURES, OnuStatus, type OrderDetail, isReviewable } from "./order-detail-model";
import { RemoteMedia } from "./RemoteMedia";

const copy = detailCopy;

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function Summary({ order }: { readonly order: OrderDetail }) {
  const s = copy.summary;
  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label={s.installer}>{fullName(order.installer)}</Field>
      <Field label={s.customer}>{fullName(order.customer)}</Field>
      <Field label={s.address}>{order.customer ? `${order.customer.addressLine}, ${order.customer.neighborhood}` : "—"}</Field>
      <Field label={s.window}>{windowText(order.window)}</Field>
      <Field label={s.plan}>{order.plan}</Field>
      <Field label={s.status}>{workOrderStatusLabel[order.status]}</Field>
      <Field label={s.onuSerial}>
        <span className="font-mono">{order.onuSerial}</span>
      </Field>
      <Field label={s.opticalClass}>{order.opticalClass}</Field>
      <Field label={s.range}>{rangeText(order.acceptanceRange)}</Field>
      {order.closedAtSim ? <Field label={s.closedAt}>{simDateTime(order.closedAtSim)}</Field> : null}
    </dl>
  );
}

interface ChecklistProps {
  readonly order: OrderDetail;
  readonly canValidate: boolean;
  readonly onChanged: (notice: string) => void;
}

function ChecklistRow({ entry, order, canValidate, onChanged }: ChecklistProps & { readonly entry: ChecklistEntryView }) {
  const label = checklistItemLabel[entry.item];
  return (
    <li className="flex flex-col gap-2 rounded-md border border-mist px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-navy">
          {label}
          <Badge tone={checklistStatusTone[entry.status]}>{checklistStatusLabel[entry.status]}</Badge>
        </p>
        {entry.attempts > 0 ? <p className="text-xs text-slate">{copy.checklist.attempts(entry.attempts)}</p> : null}
        {entry.lastRejectReason && entry.status !== "PASSED" && entry.status !== "OVERRIDDEN" ? (
          <p className="text-xs text-ink">
            {copy.checklist.lastReason}: {rejectReasonLabel[entry.lastRejectReason]}
          </p>
        ) : null}
        {entry.override ? <p className="text-xs text-ink">{copy.checklist.overriddenBy(entry.override.by, simDateTime(entry.override.atSim))} · «{entry.override.reason}»</p> : null}
        {entry.evidenceId ? (
          <RemoteMedia workOrderId={order.workOrderId} media={{ evidenceId: entry.evidenceId }} kind="IMAGE" openLabel={copy.checklist.viewPhoto} description={`${label} · ${copy.title(order.workOrderNumber)}`} />
        ) : null}
      </div>
      {canValidate && isReviewable(entry, order.status) ? (
        <ManualValidation workOrderId={order.workOrderId} workOrderNumber={order.workOrderNumber} item={entry.item} itemLabel={label} onValidated={onChanged} />
      ) : null}
    </li>
  );
}

export function Checklist(props: ChecklistProps & { readonly notice: string | null }) {
  const entries = CHECKLIST_ORDER.flatMap((item) => props.order.checklist.filter((entry) => entry.item === item));
  const reviewable = entries.some((entry) => isReviewable(entry, props.order.status));
  return (
    <div className="flex flex-col gap-3">
      {props.notice ? <Callout tone="success">{props.notice}</Callout> : null}
      {!props.canValidate && reviewable ? <Callout tone="neutral">{copy.checklist.readOnly}</Callout> : null}
      <ul className="flex flex-col gap-2">
        {entries.map((entry) => (
          <ChecklistRow key={entry.item} entry={entry} {...props} />
        ))}
      </ul>
    </div>
  );
}

export function OnuLive({ workOrderId, tick }: { readonly workOrderId: string; readonly tick: number }) {
  const api = useConsoleApi();
  const remote = useRemote(`onu:${workOrderId}:${tick}`, (signal) => api.query(DETAIL_PROCEDURES.onuStatus, { workOrderId }, OnuStatus, signal));
  return (
    <div className="flex flex-col gap-3">
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(onu) =>
          onu.available ? (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label={copy.onu.state}>{onuStateLabel[onu.operState]}</Field>
              <Field label={copy.onu.power}>
                <span className="tabular-nums">{dbm(onu.rxPowerDbm)}</span>
              </Field>
              <Field label={copy.summary.range}>
                {rangeText(onu.acceptanceRange)} · <Badge tone={onu.inRange ? "success" : "danger"}>{onu.inRange ? copy.onu.inRange : copy.onu.outOfRange}</Badge>
              </Field>
            </dl>
          ) : (
            <Callout tone="warning">{copy.onu.unavailable}</Callout>
          )
        }
      </RemoteBlock>
      <div>
        <Button variant="secondary" onClick={remote.reload}>
          {copy.onu.refresh}
        </Button>
      </div>
    </div>
  );
}

export function OrderCases({ order }: { readonly order: OrderDetail }) {
  if (order.cases.length === 0) return <EmptyState title={copy.cases.empty} />;
  return (
    <ul className="flex flex-col gap-2">
      {order.cases.map((found) => (
        <li key={found.caseId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-mist px-4 py-3">
          <span className="flex flex-col">
            <span className="text-sm font-semibold text-navy">{caseReasonLabel[found.reason]}</span>
            <span className="text-xs text-slate">
              {simDateTime(found.createdAtSim)} · {rungLabel[found.rung]}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <Badge tone={caseStatusTone[found.status]}>{caseStatusLabel[found.status]}</Badge>
            <Link to={caseHref(found.caseId)} className="text-sm font-semibold text-cyan-deep underline">
              {copy.cases.open}
            </Link>
          </span>
        </li>
      ))}
    </ul>
  );
}

type Delivery = NonNullable<OrderDetail["certificate"]>["deliveries"][number];

const DELIVERY_COLUMNS: readonly Column<Delivery>[] = [
  { id: "to", header: copy.certificate.deliveries, cell: (row) => labelOf(deliveryTargetLabel, row.to, copy.certificate.deliveries) },
  { id: "status", header: copy.timeline.status, cell: (row) => <Badge tone={row.status === "DELIVERED" || row.status === "READ" ? "success" : row.status === "BOUNCED" || row.status === "COMPLAINED" || row.status === "FAILED" ? "danger" : "neutral"}>{labelOf(emailStatusLabel, row.status, copy.timeline.status)}</Badge> },
  { id: "at", header: copy.summary.closedAt, cell: (row) => simDateTime(row.updatedAtSim) },
];

interface CertificateProps {
  readonly order: OrderDetail;
  readonly download: ActionState<unknown>;
  readonly onDownload: () => void;
}

export function CertificateBlock({ order, download, onDownload }: CertificateProps) {
  const certificate = order.certificate;
  if (certificate === null) return <EmptyState title={copy.certificate.none} />;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink">{copy.certificate.issued(certificate.n, simDateTime(certificate.issuedAtSim))}</p>
      {certificate.available ? (
        <div>
          <Button onClick={onDownload} disabled={download.status === "running"}>
            {download.status === "running" ? copy.certificate.downloading : copy.certificate.download}
          </Button>
        </div>
      ) : (
        <Callout tone="neutral">{copy.certificate.notStored}</Callout>
      )}
      <Table variant="inset" columns={DELIVERY_COLUMNS} rows={certificate.deliveries} keyOf={(row) => `${row.to}-${row.channel}`} emptyTitle={copy.certificate.deliveries} />
    </div>
  );
}
