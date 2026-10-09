// The detail of a case (`/app/cases/:caseId`; FL-051, FL-055, FL-065): the verified summary, the ladder
// rung by rung (who was notified and how, which timeout is pending, which rung was skipped and why, who
// took it), the bridge with its messages in both threads, and "Tomar" / "Cerrar" for supervisors and
// guests. The console never changes the case itself: the action is queued in the installer's order of
// events and the worker applies it, so the view says so and refreshes with the clock poll.
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { ApiErrorNotice, describeApiError } from "../../components/ApiErrorNotice";
import { EmptyState } from "../../components/EmptyState";
import { Section } from "../../components/Section";
import { usePrincipal } from "../../context/SessionContext";
import { Link } from "../../lib/router";
import { useAction } from "../../lib/use-remote";
import { clockTime, simDateTime } from "../orders/format";
import {
  caseKindLabel,
  caseReasonLabel,
  caseStatusLabel,
  caseStatusTone,
  hazardLabel,
  labelOf,
  messageKindLabel,
  rungChannelLabel,
  rungLabel,
  rungOutcomeLabel,
  rungOutcomeTone,
  rungReasonLabel,
  templateLabel,
} from "../orders/labels";
import { orderHref } from "../orders/orders-model";
import { useConsoleApi } from "../orders/use-field-data";
import { casesCopy } from "./copy";
import { CASES_PROCEDURES, CaseActionQueued, type CaseDetail as CaseDetailData, type RungView, caseActions, isConsoleOnly, ladderOf } from "./cases-model";

const copy = casesCopy.detail;

function Rung({ view }: { readonly view: RungView }) {
  return (
    <li className={`rounded-md border px-4 py-3 ${view.current ? "border-cyan bg-cyan-soft" : view.ahead ? "border-dashed border-mist bg-paper" : "border-mist bg-white"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-navy">{rungLabel[view.rung]}</span>
        <span className="text-sm text-ink">· {copy.rungPerson(view.person)}</span>
        {view.current ? <Badge tone="brand">{copy.current}</Badge> : null}
        {view.ahead ? <Badge>{copy.ahead}</Badge> : null}
      </div>
      {view.steps.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-sm text-ink">
          {view.steps.map((step) => (
            <li key={`${step.outcome}-${step.atSim}`} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs tabular-nums text-slate">{clockTime(step.atSim)}</span>
              <Badge tone={rungOutcomeTone[step.outcome]}>{rungOutcomeLabel[step.outcome]}</Badge>
              {step.channel ? <span className="text-xs text-slate">{copy.via(labelOf(rungChannelLabel, step.channel, copy.otherChannel))}</span> : null}
              {step.reason && labelOf(rungReasonLabel, step.reason, "") !== "" ? <span className="text-xs text-slate">{copy.skippedBecause(labelOf(rungReasonLabel, step.reason, ""))}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view.pendingDueAtSim ? <p className="mt-2 text-xs font-semibold text-warning">{copy.timeoutAt(clockTime(view.pendingDueAtSim))}</p> : null}
    </li>
  );
}

function Bridge({ detail }: { readonly detail: CaseDetailData }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-slate">{detail.bridge.open ? copy.bridgeOpen : copy.bridgeClosed}</p>
      {detail.bridge.pendingRelays > 0 ? <Callout tone="info">{copy.pendingRelays(detail.bridge.pendingRelays)}</Callout> : null}
      {detail.messages.length === 0 ? (
        <EmptyState title={copy.noMessages} />
      ) : (
        <ol className="flex flex-col gap-2">
          {detail.messages.map((message) => (
            <li key={message.messageId} className={`rounded-md border px-3 py-2 ${message.direction === "IN" ? "border-mist bg-white" : "border-cyan/40 bg-cyan-soft"}`}>
              <p className="flex flex-wrap items-center gap-2 text-xs text-slate">
                <span className="font-mono tabular-nums">{clockTime(message.sentAtSim)}</span>
                <span>{labelOf(messageKindLabel, message.kind, "")}</span>
              </p>
              {message.templateName ? <p className="text-xs font-semibold text-slate">{labelOf(templateLabel, message.templateName, "")}</p> : null}
              {message.text ? <p className="mt-1 whitespace-pre-line text-sm text-ink">{message.text}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Actions({ detail, onQueued }: { readonly detail: CaseDetailData; readonly onQueued: () => void }) {
  const { role } = usePrincipal();
  const api = useConsoleApi();
  const allowed = caseActions(role, detail.status);
  const action = useAction(async (which: "take" | "close") => {
    const result = await api.mutation(which === "take" ? CASES_PROCEDURES.take : CASES_PROCEDURES.close, { caseId: detail.caseId }, CaseActionQueued);
    onQueued();
    return result;
  });
  if (role === "OPS") return <Callout tone="neutral">{copy.readOnly}</Callout>;
  const failure = action.state.status === "error" ? action.state.error : undefined;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {allowed.take ? (
          <Button onClick={() => void action.run("take")} disabled={action.state.status === "running"}>
            {action.state.status === "running" ? copy.sending : copy.take}
          </Button>
        ) : null}
        {allowed.close ? (
          <Button onClick={() => void action.run("close")} disabled={action.state.status === "running"}>
            {action.state.status === "running" ? copy.sending : copy.close}
          </Button>
        ) : null}
      </div>
      {action.state.status === "done" ? <Callout tone="success">{action.state.data.action === "TAKE_CASE" ? copy.takeQueued : copy.closeQueued}</Callout> : null}
      {failure ? failure.kind === "conflict" ? <Callout tone="warning">{(failure.reason !== null ? copy.byReason[failure.reason] : undefined) ?? describeApiError(failure)}</Callout> : <ApiErrorNotice error={failure} /> : null}
    </div>
  );
}

export function CaseDetailBody({ detail, onChanged }: { readonly detail: CaseDetailData; readonly onChanged: () => void }) {
  const { role } = usePrincipal();
  const allowed = caseActions(role, detail.status);
  return (
    <div className="flex flex-col gap-6">
      <Section
        id="caso-resumen"
        title={copy.summary}
        actions={
          <>
            <Badge>{caseKindLabel[detail.kind]}</Badge>
            <Badge tone={caseStatusTone[detail.status]}>{caseStatusLabel[detail.status]}</Badge>
          </>
        }
      >
        <p className="whitespace-pre-line text-sm text-ink">{detail.summary}</p>
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.installer}</dt>
            <dd>{detail.installer ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.opened}</dt>
            <dd>{simDateTime(detail.createdAtSim)}</dd>
          </div>
          {detail.closedAtSim ? (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.closed}</dt>
              <dd>{simDateTime(detail.closedAtSim)}</dd>
            </div>
          ) : null}
          {detail.hazardCategory ? (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.hazard}</dt>
              <dd>{hazardLabel[detail.hazardCategory]}</dd>
            </div>
          ) : null}
        </dl>
        {detail.workOrderNumber ? (
          <Link to={orderHref(detail.workOrderId)} className="mt-4 inline-block text-sm font-semibold text-cyan-deep underline">
            {copy.openOrder(detail.workOrderNumber)}
          </Link>
        ) : null}
        {isConsoleOnly(detail.reason) ? (
          <div className="mt-4">
            <Callout tone="info">{copy.consoleOnlyNote}</Callout>
          </div>
        ) : null}
        {detail.closeSummary ? (
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.closeSummary}</p>
            <p className="mt-1 whitespace-pre-line text-sm text-ink">{detail.closeSummary}</p>
          </div>
        ) : null}
      </Section>
      {allowed.take || allowed.close || role === "OPS" ? (
        <Section id="caso-acciones" title={copy.actions}>
          <Actions detail={detail} onQueued={onChanged} />
        </Section>
      ) : null}
      <Section id="caso-escalera" title={copy.ladder} description={copy.ladderLead}>
        <ol aria-label={copy.ladder} className="flex flex-col gap-2">
          {ladderOf(detail).map((view) => (
            <Rung key={view.rung} view={view} />
          ))}
        </ol>
      </Section>
      <Section id="caso-puente" title={copy.bridge}>
        <Bridge detail={detail} />
      </Section>
    </div>
  );
}

export function caseTitle(detail: Pick<CaseDetailData, "reason"> | undefined): string {
  return detail ? copy.title(caseReasonLabel[detail.reason]) : copy.fallbackTitle;
}
