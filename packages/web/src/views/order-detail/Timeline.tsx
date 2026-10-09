// The unified timeline of a work order (docs/design-brief.md §6; FL-080): WhatsApp in and out with the
// transcript and the player of each voice note, photos with their verdict and reason, troubleshooting
// steps, manual citations linked to their section, the assistant's internal notes, decisions with their
// rules, emails, and what the world's clock still has pending for the order.
import { useState } from "react";
import { BUTTON_LABELS } from "@cuadrilla/bff/copy/buttons";
import { WaButtonAction } from "@cuadrilla/shared";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { FilterPills } from "../../components/FilterPills";
import { RuleChips } from "../../components/RuleChips";
import { Link } from "../../lib/router";
import { clockTime, simDateTime } from "../orders/format";
import {
  auditActionLabel,
  auditDecisionLabel,
  auditDecisionTone,
  checklistItemLabel,
  emailStatusLabel,
  labelOf,
  messageKindLabel,
  rejectReasonLabel,
  stepOutcomeLabel,
  symptomLabel,
  templateLabel,
  timerKindLabel,
  triggerLabel,
  verdictLabel,
  verdictTone,
  deliveryTargetLabel,
} from "../orders/labels";
import { describeRule } from "../orders/rule-meanings";
import { detailCopy } from "./copy";
import { type MessageEntry, type Timeline as TimelineData, type TimelineEntry, type TimelineFilter, entryKey, manualHref, matchesTimeline, sectionLabel, speakerOf, visibleEntries } from "./order-detail-model";
import { RemoteMedia } from "./RemoteMedia";

const copy = detailCopy.timeline;

function Citations({ citations }: { readonly citations: readonly string[] }) {
  if (citations.length === 0) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate">
      <span>{copy.citations}:</span>
      {citations.map((section) => {
        const href = manualHref(section);
        return href ? (
          <Link key={section} to={href} className="font-semibold text-cyan-deep underline">
            {sectionLabel(section)}
          </Link>
        ) : (
          <span key={section}>{sectionLabel(section)}</span>
        );
      })}
    </p>
  );
}

function buttonLabel(action: string): string {
  const parsed = WaButtonAction.safeParse(action);
  return parsed.success ? BUTTON_LABELS[parsed.data].es : copy.template;
}

function MessageBody({ entry, workOrderId }: { readonly entry: MessageEntry; readonly workOrderId: string }) {
  const media = entry.hasMedia && entry.mediaKind !== null ? entry.mediaKind : null;
  return (
    <div className="flex flex-col gap-2">
      {entry.templateName ? <p className="text-xs font-semibold text-slate">{labelOf(templateLabel, entry.templateName, copy.template)}</p> : null}
      {entry.buttonAction ? <p className="text-sm text-ink">{copy.buttonTap(buttonLabel(entry.buttonAction))}</p> : null}
      {entry.text ? <p className="whitespace-pre-line text-sm text-ink">{entry.text}</p> : null}
      {media === "AUDIO" ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold text-slate">{copy.voiceNote}</p>
          <RemoteMedia workOrderId={workOrderId} media={{ messageId: entry.messageId }} kind="AUDIO" openLabel={copy.listen} description={copy.voiceNote} />
        </div>
      ) : null}
      {media === "IMAGE" ? <RemoteMedia workOrderId={workOrderId} media={{ messageId: entry.messageId }} kind="IMAGE" openLabel={`${copy.photo}: ${detailCopy.checklist.viewPhoto}`} description={copy.photo} /> : null}
      {media === "DOCUMENT" ? <RemoteMedia workOrderId={workOrderId} media={{ messageId: entry.messageId }} kind="DOCUMENT" openLabel={copy.openDocument} description={copy.document} /> : null}
      {entry.transcript ? (
        <blockquote className="rounded-md border-l-4 border-cyan bg-paper px-3 py-2 text-sm text-ink">
          <p className="text-xs font-semibold text-slate">
            {copy.transcript} · {copy.confidence(Math.round(entry.transcript.confidence * 100))}
          </p>
          <p className="mt-1">{entry.transcript.text}</p>
        </blockquote>
      ) : null}
      <Citations citations={entry.citations} />
      {entry.ruleIds.length > 0 ? <RuleChips ruleIds={entry.ruleIds} label={copy.rules} describe={describeRule} /> : null}
    </div>
  );
}

interface EntryView {
  readonly title: string;
  readonly badge?: { readonly text: string; readonly tone: Parameters<typeof Badge>[0]["tone"] };
  readonly side: "in" | "out" | "event";
}

function viewOf(entry: TimelineEntry, installerId: string | undefined): EntryView {
  switch (entry.type) {
    case "MESSAGE": {
      const speaker = copy.speakers[speakerOf(entry, installerId)];
      const kind = entry.kind === null ? undefined : labelOf(messageKindLabel, entry.kind, "");
      return {
        title: `${speaker} · ${entry.direction === "IN" ? copy.incoming : copy.outgoing}${kind ? ` · ${kind}` : ""}`,
        badge: { text: labelOf(emailStatusLabel, entry.status, copy.status), tone: entry.status === "DENIED" || entry.status === "FAILED" ? "danger" : "neutral" },
        side: entry.direction === "IN" ? "in" : "out",
      };
    }
    case "EMAIL":
      return { title: `${copy.email} · ${labelOf(deliveryTargetLabel, entry.toRole, copy.email)}`, badge: { text: labelOf(emailStatusLabel, entry.status, copy.status), tone: entry.status === "DELIVERED" ? "success" : entry.status === "BOUNCED" || entry.status === "COMPLAINED" ? "danger" : "neutral" }, side: "event" };
    case "TURN_NOTE":
      return { title: `${copy.note} · ${copy.noteTrigger(labelOf(triggerLabel, entry.trigger, copy.status))}`, side: "event" };
    case "VALIDATION":
      return { title: `${copy.validation} · ${checklistItemLabel[entry.item]}`, badge: { text: verdictLabel[entry.verdict], tone: verdictTone[entry.verdict] }, side: "event" };
    case "STEP":
      return { title: `${copy.step(entry.seq)} · ${symptomLabel[entry.symptom]}`, badge: { text: stepOutcomeLabel[entry.outcome], tone: entry.outcome === "FIXED" ? "success" : entry.outcome === "PENDING" ? "neutral" : "warning" }, side: "event" };
    case "DECISION":
      return { title: `${copy.decision} · ${labelOf(auditActionLabel, entry.action, auditDecisionLabel[entry.decision])}`, badge: { text: auditDecisionLabel[entry.decision], tone: auditDecisionTone[entry.decision] }, side: "event" };
  }
}

function EntryBody({ entry, workOrderId }: { readonly entry: TimelineEntry; readonly workOrderId: string }) {
  switch (entry.type) {
    case "MESSAGE":
      return <MessageBody entry={entry} workOrderId={workOrderId} />;
    case "EMAIL":
      return (
        <p className="text-sm text-ink">
          {entry.subject}
          {entry.hasAttachment ? <span className="text-slate"> · {copy.attachment}</span> : null}
        </p>
      );
    case "TURN_NOTE":
      return <p className="whitespace-pre-line text-sm italic text-slate">{entry.note}</p>;
    case "VALIDATION":
      return (
        <div className="flex flex-col gap-2">
          {entry.reasonCode ? <p className="text-sm text-ink">{rejectReasonLabel[entry.reasonCode]}</p> : null}
          {entry.checks.length > 0 ? <RuleChips ruleIds={entry.checks} label={copy.validationChecks} describe={describeRule} /> : null}
          {entry.evidenceId ? (
            <RemoteMedia workOrderId={workOrderId} media={{ evidenceId: entry.evidenceId }} kind="IMAGE" openLabel={detailCopy.checklist.viewPhoto} description={`${copy.photo}: ${checklistItemLabel[entry.item]}`} />
          ) : null}
        </div>
      );
    case "STEP": {
      const href = manualHref(entry.stepRef);
      return (
        <p className="text-sm text-ink">
          {href ? (
            <Link to={href} className="font-semibold text-cyan-deep underline">
              {sectionLabel(entry.stepRef)}
            </Link>
          ) : (
            sectionLabel(entry.stepRef)
          )}
        </p>
      );
    }
    case "DECISION":
      return (
        <div className="flex flex-col gap-1">
          {entry.trigger ? <p className="text-xs text-slate">{copy.noteTrigger(labelOf(triggerLabel, entry.trigger, copy.status))}</p> : null}
          <RuleChips ruleIds={entry.ruleIds} label={copy.rules} describe={describeRule} emptyText={copy.noRules} />
        </div>
      );
  }
}

const SIDE: Readonly<Record<EntryView["side"], string>> = {
  in: "border-mist bg-white",
  out: "border-cyan/40 bg-cyan-soft",
  event: "border-dashed border-mist bg-paper",
};

export function Timeline({ data, installerId }: { readonly data: TimelineData; readonly installerId: string | undefined }) {
  const [filter, setFilter] = useState<TimelineFilter>("ALL");
  const entries = visibleEntries(data.entries);
  const options = (["ALL", "MESSAGES", "EVIDENCE", "DECISIONS"] as const).map((value) => ({ value, label: copy.filters[value], count: entries.filter((entry) => matchesTimeline(entry, value)).length }));
  const shown = entries.filter((entry) => matchesTimeline(entry, filter));
  return (
    <div className="flex flex-col gap-4">
      <FilterPills label={copy.filterLabel} options={options} value={filter} onChange={setFilter} />
      {shown.length === 0 ? (
        <EmptyState title={copy.empty} lead={copy.emptyLead} />
      ) : (
        <ol aria-label={detailCopy.sections.timeline} className="flex flex-col gap-3">
          {shown.map((entry) => {
            const view = viewOf(entry, installerId);
            return (
              <li key={entryKey(entry)} className={`rounded-card border px-4 py-3 ${SIDE[view.side]}`}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <time dateTime={entry.atSim} className="font-mono text-xs tabular-nums text-slate">
                    {clockTime(entry.atSim)}
                  </time>
                  <span className="text-sm font-semibold text-navy">{view.title}</span>
                  {view.badge && view.badge.text !== "" ? <Badge tone={view.badge.tone}>{view.badge.text}</Badge> : null}
                </div>
                <EntryBody entry={entry} workOrderId={data.workOrderId} />
              </li>
            );
          })}
        </ol>
      )}
      {data.pending.length > 0 ? (
        <div className="rounded-card border border-mist bg-white px-4 py-3">
          <p className="text-sm font-semibold text-navy">{copy.pending}</p>
          <p className="text-xs text-slate">{copy.pendingLead}</p>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-ink">
            {data.pending.map((item) => (
              <li key={`${item.kind}-${item.dueAtSim}`}>
                <span className="font-mono tabular-nums text-slate">{simDateTime(item.dueAtSim)}</span> · {labelOf(timerKindLabel, item.kind, copy.pending)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
