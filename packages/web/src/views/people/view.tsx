// Personal (`/app/people`, docs/design-brief.md §6; FL-001, FL-005, FL-007, FL-008): installers,
// supervisors and zone chiefs of the world with the masked phone, the allow-list state and the opt-in
// (date and version of the text, or the opt-out), the join poster, and the roster of each crew. Supervisors
// and guests add, edit, deactivate and change rosters; operations staff only look. The list follows the
// shell's clock poll, so an "ALTA" or a "BAJA" sent from the simulator shows up on its own.
import { useMemo, useState } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { Drawer } from "../../components/Drawer";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { dataOf, useRemote } from "../../lib/use-remote";
import type { ViewProps } from "../../lib/view-registry";
import { peopleCopy as copy } from "./copy";
import { type PersonRow, type RoleFilter, STAFF_ROLES, canManage, crewLabel, crewsOf, emptyForm, formOf, fullName, optInText, roleCounts, sortedPeople, zoneLabel, zonesOf } from "./people-model";
import { PersonForm } from "./PersonForm";
import { PersonPanel } from "./PersonPanel";
import { type CrewRoster, RosterSection } from "./RosterSection";

type Panel = { readonly kind: "new" } | { readonly kind: "show"; readonly personId: string; readonly created?: boolean } | { readonly kind: "edit"; readonly personId: string };

export default function PeopleView(_props: ViewProps) {
  const { trpc } = useSession();
  const { role } = usePrincipal();
  const { tick } = useWorldClock();
  const manage = canManage(role);
  const [filter, setFilter] = useState<RoleFilter>("ALL");
  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const people = useRemote(`people.list:${tick}:${version}`, (signal) => trpc.people.list.query(undefined, { signal }));
  const list = dataOf(people.state);
  const crews = useMemo(() => crewsOf(list ?? []), [list]);
  const zones = useMemo(() => zonesOf(list ?? []), [list]);
  const rosters = useRemote(crews.length === 0 ? null : `people.roster:${crews.join(",")}:${version}`, (signal) =>
    Promise.all(crews.map((crewId): Promise<CrewRoster> => trpc.people.roster.get.query({ crewId }, { signal }))),
  );
  const rosterList = dataOf(rosters.state);
  const crewNames = useMemo(() => Object.fromEntries((rosterList ?? []).map((roster) => [roster.crewId, roster.crewName])), [rosterList]);
  const changed = () => setVersion((value) => value + 1);
  const close = () => setPanel(undefined);
  const current = panel !== undefined && panel.kind !== "new" ? list?.find((person) => person.personId === panel.personId) : undefined;

  const columns = [
    { id: "name", header: copy.table.name, cell: (person: PersonRow) => <span className="font-medium text-ink">{fullName(person)}</span> },
    { id: "role", header: copy.table.role, cell: (person: PersonRow) => copy.roles[person.role] },
    { id: "crew", header: copy.table.crew, cell: (person: PersonRow) => (person.crewId ? crewLabel(person.crewId, crewNames) : person.zoneId ? zoneLabel(person.zoneId) : copy.noValue) },
    { id: "phone", header: copy.table.phone, cell: (person: PersonRow) => <span className="font-mono text-xs">{person.phoneMasked ?? copy.noValue}</span> },
    { id: "allow", header: copy.table.allowList, cell: (person: PersonRow) => <Badge tone={person.active ? "success" : "neutral"}>{person.active ? copy.allowList.active : copy.allowList.inactive}</Badge> },
    { id: "optin", header: copy.table.optIn, cell: (person: PersonRow) => <span className="text-xs">{optInText(person.optIn)}</span> },
  ];
  const counts = roleCounts(list ?? []);
  const title = panel?.kind === "new" ? copy.drawer.newTitle : panel?.kind === "edit" ? copy.drawer.editTitle : current ? fullName(current) : copy.drawer.detailTitle;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={consoleCopy.views.people.title}
        description={consoleCopy.views.people.description}
        actions={
          manage ? (
            <Button disabled={list === undefined} onClick={() => setPanel({ kind: "new" })}>
              {copy.newPerson}
            </Button>
          ) : (
            <p className="max-w-xs text-xs text-slate">{copy.onlySupervisors}</p>
          )
        }
      />
      <FilterPills
        label={copy.filter.label}
        value={filter}
        onChange={setFilter}
        options={[{ value: "ALL", label: copy.filter.all, count: counts.ALL }, ...STAFF_ROLES.map((value) => ({ value, label: copy.filter[value], count: counts[value] }))]}
      />
      <RemoteBlock state={people.state} onRetry={people.reload}>
        {(rows) => (
          <DataTable
            caption={copy.table.caption}
            columns={columns}
            rows={sortedPeople(rows, filter)}
            keyOf={(person) => person.personId}
            emptyTitle={copy.table.empty}
            emptyLead={copy.table.emptyLead}
            onRowClick={(person) => setPanel({ kind: "show", personId: person.personId })}
            {...(current ? { activeKey: current.personId } : {})}
          />
        )}
      </RemoteBlock>
      {list !== undefined && rosterList !== undefined ? <RosterSection rosters={rosterList} people={list} manage={manage} onSaved={changed} /> : null}
      <Drawer open={panel !== undefined} title={title} onClose={close} closeLabel={copy.drawer.close}>
        {panel?.kind === "new" ? (
          <PersonForm
            initial={emptyForm(crews, zones)}
            crews={crews}
            zones={zones}
            crewNames={crewNames}
            onCancel={close}
            onSaved={(personId) => {
              changed();
              setPanel({ kind: "show", personId, created: true });
            }}
          />
        ) : null}
        {panel?.kind === "edit" && current ? (
          <PersonForm
            initial={formOf(current)}
            person={current}
            crews={crews}
            zones={zones}
            crewNames={crewNames}
            onCancel={() => setPanel({ kind: "show", personId: current.personId })}
            onSaved={(personId) => {
              changed();
              setPanel({ kind: "show", personId });
            }}
          />
        ) : null}
        {panel?.kind === "show" && current ? (
          <div className="flex flex-col gap-4">
            {panel.created ? <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">{copy.form.created}</p> : null}
            <PersonPanel person={current} manage={manage} crewNames={crewNames} onEdit={() => setPanel({ kind: "edit", personId: current.personId })} onChanged={changed} showPoster={panel.created === true} />
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
