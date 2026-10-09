// The form of a new person or of an edit (FL-001): role (only for a new one), name, crew or zone by role,
// phone and email. It sends `people.upsert`; a refusal shows the people service's own words (the phone
// already taken in this world, a phone outside the world's synthetic block, an email outside its fence).
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { HINT_CLASS, FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { SelectField } from "../../components/SelectField";
import { useSession } from "../../context/SessionContext";
import { useAction } from "../../lib/use-remote";
import { peopleCopy as copy } from "./copy";
import { type PersonForm as Form, type PersonRow, STAFF_ROLES, crewLabel, reasonText, upsertInputOf, zoneLabel } from "./people-model";

function TextInput({ label, value, onChange, hint, type = "text", autoComplete = "off" }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly hint?: string; readonly type?: string; readonly autoComplete?: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className={LABEL_CLASS}>
      {label}
      <input id={id} type={type} value={value} autoComplete={autoComplete} onChange={(event) => onChange(event.target.value)} className={FIELD_CLASS} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint ? (
        <span id={`${id}-hint`} className={HINT_CLASS}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

interface PersonFormProps {
  readonly initial: Form;
  /** The person being edited; absent for a new one. */
  readonly person?: PersonRow;
  readonly crews: readonly string[];
  readonly zones: readonly string[];
  readonly crewNames: Readonly<Record<string, string>>;
  readonly onSaved: (person: PersonRow["personId"], created: boolean) => void;
  readonly onCancel: () => void;
}

export function PersonForm({ initial, person, crews, zones, crewNames, onSaved, onCancel }: PersonFormProps) {
  const { trpc } = useSession();
  const [form, setForm] = useState<Form>(initial);
  const [missing, setMissing] = useState(false);
  const save = useAction((input: NonNullable<ReturnType<typeof upsertInputOf>>) => trpc.people.upsert.mutate(input));
  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => setForm((current) => ({ ...current, [key]: value }));
  const zoneChief = form.role === "ZONE_CHIEF";

  const submit = async () => {
    const input = upsertInputOf(form, person?.personId);
    setMissing(input === undefined);
    if (input === undefined) return;
    const saved = await save.run(input);
    if (saved) onSaved(saved.person.personId, saved.created);
  };

  const error = save.state.status === "error" ? save.state.error : undefined;
  const ownReason = error ? reasonText(error.reason) : undefined;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {person === undefined ? (
        <SelectField label={copy.form.role} value={form.role} options={STAFF_ROLES.map((role) => ({ value: role, label: copy.roles[role] }))} onChange={set("role")} />
      ) : (
        <p className="text-sm text-slate">
          {copy.form.role}: <span className="font-semibold text-ink">{copy.roles[person.role]}</span>
        </p>
      )}
      <TextInput label={copy.form.firstName} value={form.firstName} onChange={set("firstName")} autoComplete="given-name" />
      <TextInput label={copy.form.lastName} value={form.lastName} onChange={set("lastName")} autoComplete="family-name" />
      {zoneChief ? (
        <SelectField label={copy.form.zone} value={form.zoneId} options={zones.map((zoneId) => ({ value: zoneId, label: zoneLabel(zoneId) }))} onChange={set("zoneId")} />
      ) : (
        <SelectField label={copy.form.crew} value={form.crewId} options={crews.map((crewId) => ({ value: crewId, label: crewLabel(crewId, crewNames) }))} onChange={set("crewId")} />
      )}
      <TextInput label={copy.form.phone} type="tel" value={form.phone} onChange={set("phone")} hint={person?.phoneMasked ? `${copy.form.phoneKeep} ${copy.form.phoneHint}` : copy.form.phoneHint} />
      <TextInput label={copy.form.email} type="email" value={form.email} onChange={set("email")} hint={copy.form.emailHint} />
      {missing ? <Callout tone="warning">{copy.form.missing}</Callout> : null}
      {error ? ownReason ? <Callout tone="warning">{ownReason}</Callout> : <ApiErrorNotice error={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.state.status === "running"}>
          {save.state.status === "running" ? copy.form.saving : copy.form.save}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {copy.form.cancel}
        </Button>
      </div>
    </form>
  );
}
