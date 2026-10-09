// The world's next events and the demo controls (FL-060, FL-084): "Forzar vencimiento del caso" on an open
// case (its rung times out now and the case climbs the ladder) and the simulated state of the WhatsApp
// templates (approved, pending, rejected) to try the plan B. Both are closed while the world is busy.
import { useState } from "react";
import { TemplateName, TemplateStatus } from "@cuadrilla/shared";
import { Button } from "../../components/Button";
import { RemoteBlock } from "../../components/RemoteBlock";
import { Section } from "../../components/Section";
import { SelectField } from "../../components/SelectField";
import { Table } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import type { RouterOutputs } from "../../lib/trpc-router";
import { useRemote } from "../../lib/use-remote";
import { type UpcomingEvent, formatSimTime } from "../../lib/world-clock";
import { clockCopy as copy } from "./copy";
import { CommandOutcome } from "./parts";
import { useClockCommand } from "./use-clock-command";

type OpenCase = RouterOutputs["cases"]["list"][number];

export function EventsSection() {
  const { clock } = useWorldClock();
  return (
    <Section id="clock-events" title={copy.events.title} description={copy.events.description}>
      <Table<UpcomingEvent>
        caption={copy.events.title}
        columns={[
          { id: "when", header: copy.events.when, cell: (event) => <span className="tabular-nums">{formatSimTime(event.dueAtSim, consoleCopy.clock.weekdays)}</span> },
          { id: "kind", header: copy.events.kind, cell: (event) => copy.events.kinds[event.kind] },
        ]}
        rows={clock?.next ?? []}
        keyOf={(event) => `${event.kind}:${event.dueAtSim}`}
        emptyTitle={copy.events.empty}
      />
    </Section>
  );
}

function caseLabel(found: OpenCase): string {
  return copy.cases.label(found.workOrderNumber ?? "—", copy.cases.reasons[found.reason], copy.cases.rungs[found.rung]);
}

function ForceTimeout({ cases, locked }: { readonly cases: readonly OpenCase[]; readonly locked: boolean }) {
  const { trpc } = useSession();
  const command = useClockCommand();
  const [caseId, setCaseId] = useState(cases[0]?.caseId ?? "");
  const selected = cases.find((found) => found.caseId === caseId) ?? cases[0];
  if (selected === undefined) return <p className="text-sm text-slate">{copy.cases.none}</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField label={copy.cases.select} value={selected.caseId} options={cases.map((found) => ({ value: found.caseId, label: caseLabel(found) }))} onChange={setCaseId} className="min-w-72" />
        <Button variant="secondary" disabled={locked || command.running} onClick={() => command.run(() => trpc.clock.forceCaseTimeout.mutate({ caseId: selected.caseId }), () => copy.cases.forced)}>
          {copy.cases.force}
        </Button>
      </div>
      <CommandOutcome command={command} />
    </div>
  );
}

function Templates({ locked }: { readonly locked: boolean }) {
  const { trpc } = useSession();
  const command = useClockCommand();
  const [name, setName] = useState<TemplateName>("ordenes_del_dia");
  const [status, setStatus] = useState<TemplateStatus>("PENDING");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField label={copy.templates.template} value={name} options={TemplateName.options.map((value) => ({ value, label: copy.templates.names[value] }))} onChange={setName} className="min-w-56" />
        <SelectField label={copy.templates.status} value={status} options={TemplateStatus.options.map((value) => ({ value, label: copy.templates.statuses[value] }))} onChange={setStatus} className="min-w-40" />
        <Button
          variant="secondary"
          disabled={locked || command.running}
          onClick={() => command.run(() => trpc.clock.setTemplateStatus.mutate({ name, status }), () => copy.templates.applied(copy.templates.names[name], copy.templates.statuses[status]))}
        >
          {copy.templates.apply}
        </Button>
      </div>
      <CommandOutcome command={command} />
    </div>
  );
}

export function DemoControlsSection() {
  const { trpc } = useSession();
  const { clock, tick } = useWorldClock();
  const locked = clock === undefined || clock.busy;
  const cases = useRemote(`cases.list:OPEN:${tick}`, (signal) => trpc.cases.list.query({ status: "OPEN" }, { signal }));
  return (
    <>
      <Section id="clock-cases" title={copy.cases.title} description={copy.cases.description}>
        <RemoteBlock state={cases.state} onRetry={cases.reload}>
          {(open) => <ForceTimeout cases={open} locked={locked} />}
        </RemoteBlock>
      </Section>
      <Section id="clock-templates" title={copy.templates.title} description={copy.templates.description}>
        <Templates locked={locked} />
      </Section>
    </>
  );
}
