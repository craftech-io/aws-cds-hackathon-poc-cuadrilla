// "Roster por turno" (FL-007): who supervises each field crew on the world's day, on duty and as backup,
// with the shift's hours and how many dated changes it keeps. Supervisors and guests change it
// (`people.roster.set`); the cases already open keep the roster they were opened with.
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { EmptyState } from "../../components/EmptyState";
import { Section } from "../../components/Section";
import { SelectField } from "../../components/SelectField";
import { useSession } from "../../context/SessionContext";
import type { RouterOutputs } from "../../lib/trpc-router";
import { useAction } from "../../lib/use-remote";
import { simTimeParts } from "../../lib/world-clock";
import { peopleCopy as copy } from "./copy";
import { type PersonRow, dayLabel, fullName, reasonText } from "./people-model";

export type CrewRoster = RouterOutputs["people"]["roster"]["get"];

interface RosterSectionProps {
  readonly rosters: readonly CrewRoster[];
  readonly people: readonly PersonRow[];
  readonly manage: boolean;
  readonly onSaved: () => void;
}

function RosterEditor({ roster, supervisors, onSaved }: { readonly roster: CrewRoster & { readonly roster: NonNullable<CrewRoster["roster"]> }; readonly supervisors: readonly PersonRow[]; readonly onSaved: () => void }) {
  const { trpc } = useSession();
  const [primaryId, setPrimary] = useState(roster.roster.primaryId);
  const [secondaryId, setSecondary] = useState(roster.roster.secondaryId);
  const save = useAction(() => trpc.people.roster.set.mutate({ crewId: roster.crewId, date: roster.date, primaryId, secondaryId }));
  const options = supervisors.map((person) => ({ value: person.personId, label: fullName(person) }));
  const unchanged = primaryId === roster.roster.primaryId && secondaryId === roster.roster.secondaryId;
  const error = save.state.status === "error" ? save.state.error : undefined;
  const own = error ? reasonText(error.reason) : undefined;

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-mist pt-4">
      <div className="flex flex-wrap items-end gap-4">
        <SelectField label={copy.roster.primary} value={primaryId} options={options} onChange={setPrimary} className="min-w-56" />
        <SelectField label={copy.roster.secondary} value={secondaryId} options={options} onChange={setSecondary} className="min-w-56" />
        <Button
          disabled={unchanged || save.state.status === "running"}
          onClick={() =>
            void save.run(undefined).then((saved) => {
              if (saved) onSaved();
            })
          }
        >
          {copy.roster.save}
        </Button>
      </div>
      {unchanged ? <p className="text-xs text-slate">{copy.roster.unchanged}</p> : null}
      {error ? own ? <Callout tone="warning">{own}</Callout> : <ApiErrorNotice error={error} /> : null}
    </div>
  );
}

export function RosterSection({ rosters, people, manage, onSaved }: RosterSectionProps) {
  const [crewId, setCrewId] = useState(rosters[0]?.crewId ?? "");
  const [savedCrew, setSavedCrew] = useState<string | undefined>(undefined);
  const selected = rosters.find((roster) => roster.crewId === crewId) ?? rosters[0];
  const supervisors = people.filter((person) => person.role === "SUPERVISOR" && person.active);
  const nameOf = (personId: string, fallback: string | null) => {
    const person = people.find((candidate) => candidate.personId === personId);
    return person ? fullName(person) : (fallback ?? copy.noValue);
  };

  return (
    <Section id="roster" title={copy.roster.title} description={copy.roster.description}>
      {selected === undefined ? (
        <EmptyState title={copy.roster.noCrews} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <SelectField label={copy.roster.crew} value={selected.crewId} options={rosters.map((roster) => ({ value: roster.crewId, label: roster.crewName }))} onChange={(next) => {
                setCrewId(next);
                setSavedCrew(undefined);
              }}
              className="min-w-56"
            />
            <p className="text-sm text-slate">
              {copy.roster.date}: <span className="font-semibold text-ink">{dayLabel(selected.date)}</span>
            </p>
          </div>
          {selected.roster === null ? (
            <p className="mt-4 text-sm text-slate">{copy.roster.none}</p>
          ) : (
            <>
              <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.roster.primary}</dt>
                  <dd className="text-ink">{nameOf(selected.roster.primaryId, selected.roster.primaryName)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.roster.secondary}</dt>
                  <dd className="text-ink">{nameOf(selected.roster.secondaryId, selected.roster.secondaryName)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{copy.roster.shift}</dt>
                  <dd className="text-ink">
                    {simTimeParts(selected.roster.startsAtSim).time}–{simTimeParts(selected.roster.endsAtSim).time} · {copy.roster.changes(selected.roster.changes.length)}
                  </dd>
                </div>
              </dl>
              {manage && supervisors.length >= 2 ? (
                <RosterEditor
                  key={`${selected.crewId}:${selected.roster.primaryId}:${selected.roster.secondaryId}`}
                  roster={{ ...selected, roster: selected.roster }}
                  supervisors={supervisors}
                  onSaved={() => {
                    setSavedCrew(selected.crewId);
                    onSaved();
                  }}
                />
              ) : null}
              {savedCrew === selected.crewId ? (
                <div className="mt-3">
                  <Callout tone="success">{copy.roster.saved}</Callout>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </Section>
  );
}
