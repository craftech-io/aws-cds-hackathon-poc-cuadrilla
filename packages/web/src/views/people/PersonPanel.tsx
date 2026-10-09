// One person in the side panel (FL-001, FL-005, FL-008): masked contacts, allow-list state and opt-in,
// "Desactivar" / "Volver a activar" with an optional reason (the open orders of a deactivated installer
// come back for reassignment), "Editar" and the join poster with its QR ("Envía ALTA a este número").
import { type ReactNode, useId, useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { RemoteBlock } from "../../components/RemoteBlock";
import { useSession } from "../../context/SessionContext";
import { useAction, useRemote } from "../../lib/use-remote";
import { QrCode } from "../../components/QrCode";
import { peopleCopy as copy } from "./copy";
import { type PersonRow, crewLabel, fullName, optInText, zoneLabel } from "./people-model";

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
    </div>
  );
}

function JoinPoster({ person }: { readonly person: PersonRow }) {
  const { trpc } = useSession();
  const poster = useRemote(`people.joinPoster:${person.personId}`, (signal) => trpc.people.joinPoster.query({ personId: person.personId }, { signal }));
  return (
    <section aria-labelledby="join-poster-title" className="rounded-card border border-mist bg-paper p-4">
      <h3 id="join-poster-title" className="text-base font-semibold text-navy">
        {copy.poster.title}
      </h3>
      <RemoteBlock state={poster.state} onRetry={poster.reload}>
        {(data) => (
          <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row">
            <QrCode value={data.qrText} label={copy.poster.qr(data.firstName)} />
            <div className="space-y-2 text-sm text-ink">
              <p className="text-lg font-semibold text-navy">{copy.poster.keyword}</p>
              <p>{copy.poster.lead(data.firstName)}</p>
              <p className="text-slate">{data.channel === "live" ? copy.poster.live : copy.poster.simulated}</p>
            </div>
          </div>
        )}
      </RemoteBlock>
    </section>
  );
}

interface PersonPanelProps {
  readonly person: PersonRow;
  readonly manage: boolean;
  readonly crewNames: Readonly<Record<string, string>>;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
  /** Open the poster right away (a person just created). */
  readonly showPoster?: boolean;
}

export function PersonPanel({ person, manage, crewNames, onEdit, onChanged, showPoster = false }: PersonPanelProps) {
  const { trpc } = useSession();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [poster, setPoster] = useState(showPoster);
  const toggle = useAction((active: boolean) => trpc.people.deactivate.mutate({ personId: person.personId, active, ...(reason.trim() === "" ? {} : { reason: reason.trim() }) }));
  const outcome = toggle.state.status === "done" ? toggle.state.data : undefined;

  const run = async (active: boolean) => {
    const result = await toggle.run(active);
    if (result) onChanged();
  };

  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Fact label={copy.table.name}>{fullName(person)}</Fact>
        <Fact label={copy.table.role}>{copy.roles[person.role]}</Fact>
        <Fact label={person.role === "ZONE_CHIEF" ? copy.form.zone : copy.table.crew}>
          {person.crewId ? crewLabel(person.crewId, crewNames) : person.zoneId ? zoneLabel(person.zoneId) : copy.noValue}
        </Fact>
        <Fact label={copy.table.phone}>{person.phoneMasked ?? copy.noValue}</Fact>
        <Fact label={copy.form.email}>{person.emailMasked ?? copy.noValue}</Fact>
        <Fact label={copy.table.allowList}>
          <Badge tone={person.active ? "success" : "neutral"}>{person.active ? copy.allowList.active : copy.allowList.inactive}</Badge>
        </Fact>
        <Fact label={copy.table.optIn}>{optInText(person.optIn)}</Fact>
      </dl>
      {outcome ? (
        <Callout tone={outcome.person.active ? "success" : "info"}>
          {outcome.person.active ? copy.drawer.activated : copy.drawer.deactivated}
          {outcome.needsReassignment.length > 0 ? ` ${copy.drawer.reassign(outcome.needsReassignment.length)}` : ""}
        </Callout>
      ) : null}
      {toggle.state.status === "error" ? <ApiErrorNotice error={toggle.state.error} /> : null}
      {manage ? (
        <div className="flex flex-col gap-3">
          {person.active ? (
            <label htmlFor={reasonId} className={LABEL_CLASS}>
              {copy.drawer.deactivateReason}
              <input id={reasonId} value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} className={FIELD_CLASS} />
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onEdit}>
              {copy.drawer.edit}
            </Button>
            <Button variant={person.active ? "danger" : "primary"} disabled={toggle.state.status === "running"} onClick={() => void run(!person.active)}>
              {person.active ? copy.drawer.deactivate : copy.drawer.activate}
            </Button>
          </div>
        </div>
      ) : null}
      {person.role === "ZONE_CHIEF" ? null : poster ? (
        <JoinPoster person={person} />
      ) : (
        <div>
          <Button variant="secondary" onClick={() => setPoster(true)}>
            {copy.drawer.poster}
          </Button>
        </div>
      )}
    </div>
  );
}
