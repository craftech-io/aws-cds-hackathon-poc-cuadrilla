// Evidence review (`/app/evidence`, docs/design-brief.md §5.10 and §6; FL-043, FL-044, ADR-0011): the photo
// items of the day's open orders that the validator was unsure about (first) or rejected, each with the
// photo, the rubric of the item and what the validator said (verdict, reason, readings, confidence and
// the deterministic checks that hardened it). Nothing here decides by itself: a supervisor or a guest
// validates by hand with a reason; operations staff only look.
import { type ReactNode, useState } from "react";
import { Badge } from "../../components/Badge";
import { Callout } from "../../components/Callout";
import { EmptyState } from "../../components/EmptyState";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { RuleChips } from "../../components/RuleChips";
import { usePrincipal } from "../../context/SessionContext";
import { Link } from "../../lib/router";
import type { ViewProps } from "../../lib/view-registry";
import { RemoteMedia } from "../order-detail/RemoteMedia";
import { canValidate } from "../order-detail/order-detail-model";
import { dbm, simDateTime } from "../orders/format";
import { checklistItemLabel, checklistStatusLabel, checklistStatusTone, rejectReasonLabel, verdictLabel, verdictTone } from "../orders/labels";
import { orderHref } from "../orders/orders-model";
import { describeRule } from "../orders/rule-meanings";
import { useLiveQuery } from "../orders/use-field-data";
import { evidenceCopy as copy } from "./copy";
import { EVIDENCE_PROCEDURES, type QueueFilter, type ReviewItem, ReviewQueue, matchesQueue, percent, reviewKey } from "./evidence-model";
import { ManualValidation } from "./ManualValidation";

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <dt className="font-semibold text-slate">{label}:</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

function ValidatorOutput({ item }: { readonly item: ReviewItem }) {
  const validation = item.validation;
  if (validation === null) return null;
  const { readings } = validation;
  return (
    <dl className="flex flex-col gap-1">
      <Line label={copy.verdict}>
        <Badge tone={verdictTone[validation.verdict]}>{verdictLabel[validation.verdict]}</Badge>
      </Line>
      {validation.modelVerdict ? <Line label={copy.modelVerdict}>{verdictLabel[validation.modelVerdict]}</Line> : null}
      {validation.reasonCode ? <Line label={copy.reason}>{rejectReasonLabel[validation.reasonCode]}</Line> : null}
      <Line label={copy.confidence}>{percent(validation.confidence)}</Line>
      {readings.readingDbm !== undefined ? <Line label={copy.reading}>{dbm(readings.readingDbm)}</Line> : null}
      {readings.wavelengthNm !== undefined ? <Line label={copy.wavelength}>{`${readings.wavelengthNm} nm`}</Line> : null}
      {readings.serial !== undefined ? (
        <Line label={copy.serial}>
          <span className="font-mono">{readings.serial}</span>
          {readings.serialMatches === undefined ? null : <span className="text-slate"> · {readings.serialMatches ? copy.serialMatches : copy.serialDiffers}</span>}
        </Line>
      ) : null}
      <Line label={copy.checks}>
        <RuleChips ruleIds={validation.checks} label={copy.checks} describe={describeRule} emptyText={copy.noChecks} />
      </Line>
      <p className="text-xs text-slate">{simDateTime(validation.atSim)}</p>
    </dl>
  );
}

function ReviewCard({ item, canAct, onValidated }: { readonly item: ReviewItem; readonly canAct: boolean; readonly onValidated: (notice: string) => void }) {
  const label = checklistItemLabel[item.item];
  const evidenceId = item.validation?.evidenceId ?? null;
  return (
    <li className="rounded-card border border-mist bg-white p-5 shadow-card">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-navy">
            {label} · {copy.order(item.workOrderNumber)}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate">
            <Badge tone={checklistStatusTone[item.status]}>{checklistStatusLabel[item.status]}</Badge>
            {item.attempts > 0 ? <span>{copy.attempts(item.attempts)}</span> : null}
          </p>
        </div>
        <Link to={orderHref(item.workOrderId)} className="text-sm font-semibold text-cyan-deep underline">
          {copy.openOrder}
        </Link>
      </header>
      {item.status === "IN_REVIEW" ? (
        <div className="mb-4">
          <Callout tone="warning">{copy.unsureNote}</Callout>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <section aria-label={copy.photo} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-navy">{copy.photo}</h3>
          {evidenceId ? (
            <RemoteMedia workOrderId={item.workOrderId} media={{ evidenceId }} kind="IMAGE" openLabel={copy.photo} description={copy.photoAlt(label, item.workOrderNumber)} auto />
          ) : (
            <p className="text-sm text-slate">{copy.noPhoto}</p>
          )}
        </section>
        <section aria-label={copy.rubric} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-navy">{copy.rubric}</h3>
          {item.rubric ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
              {item.rubric.mustShow.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate">{copy.noRubric}</p>
          )}
        </section>
        <section aria-label={copy.validator} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-navy">{copy.validator}</h3>
          <ValidatorOutput item={item} />
        </section>
      </div>
      {canAct ? (
        <div className="mt-4 border-t border-mist pt-4">
          <ManualValidation workOrderId={item.workOrderId} workOrderNumber={item.workOrderNumber} item={item.item} itemLabel={label} onValidated={onValidated} />
        </div>
      ) : null}
    </li>
  );
}

function Queue({ data, onValidated }: { readonly data: ReviewQueue; readonly onValidated: () => void }) {
  const { role } = usePrincipal();
  const [filter, setFilter] = useState<QueueFilter>("ALL");
  const [notice, setNotice] = useState<string | null>(null);
  const validated = (text: string) => {
    setNotice(text);
    onValidated();
  };
  const options = (["ALL", "UNSURE", "REJECTED"] as const).map((value) => ({ value, label: copy.filters[value], count: data.items.filter((item) => matchesQueue(item, value)).length }));
  const shown = data.items.filter((item) => matchesQueue(item, filter));
  return (
    <div className="flex flex-col gap-4">
      {notice ? <Callout tone="success">{notice}</Callout> : null}
      <FilterPills label={copy.filterLabel} options={options} value={filter} onChange={setFilter} />
      {!canValidate(role) && data.items.length > 0 ? <Callout tone="neutral">{copy.readOnly}</Callout> : null}
      {shown.length === 0 ? (
        <EmptyState title={copy.emptyTitle} lead={copy.emptyLead} />
      ) : (
        <ul aria-label={copy.caption} className="flex flex-col gap-4">
          {shown.map((item) => (
            <ReviewCard key={reviewKey(item)} item={item} canAct={canValidate(role)} onValidated={validated} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function EvidenceView(_props: ViewProps) {
  const remote = useLiveQuery(EVIDENCE_PROCEDURES.queue, undefined, ReviewQueue);
  return (
    <div>
      <PageHeader title={copy.title} description={copy.description} />
      <RemoteBlock state={remote.state} onRetry={remote.reload}>
        {(data) => <Queue data={data} onValidated={remote.reload} />}
      </RemoteBlock>
    </div>
  );
}
