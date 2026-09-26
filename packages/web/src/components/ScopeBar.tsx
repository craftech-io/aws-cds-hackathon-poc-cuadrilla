// The scope a list of field work is looked at through: a field crew (or every crew) and a day of the
// world clock. The scope itself lives in IspContext, so the orders, the cases and the people of the
// same session share it; the crews and days on offer, and every text, arrive by props.
import type { WorkScope } from "../context/IspContext";
import { SelectField, type SelectOption } from "./SelectField";

/** Value of the "every crew" option: a select needs a string, the scope has no crew. */
const ALL_CREWS = "";

interface ScopeBarProps {
  /** Accessible name of the bar ("Alcance"). */
  readonly label: string;
  readonly crews: {
    readonly label: string;
    /** "Todos los equipos". */
    readonly allLabel: string;
    readonly options: readonly SelectOption<string>[];
  };
  readonly days: {
    readonly label: string;
    /** Calendar days (`YYYY-MM-DD`) with their label ("mar 13/10 (hoy)"). */
    readonly options: readonly [SelectOption<string>, ...SelectOption<string>[]];
  };
  readonly value: WorkScope;
  readonly onChange: (scope: WorkScope) => void;
}

function withCrew(scope: WorkScope, crewId: string): WorkScope {
  if (crewId !== ALL_CREWS) return { ...scope, crewId };
  return scope.day === undefined ? {} : { day: scope.day };
}

export function ScopeBar({ label, crews, days, value, onChange }: ScopeBarProps) {
  const crewOptions: SelectOption<string>[] = [{ value: ALL_CREWS, label: crews.allLabel }, ...crews.options];
  const day = value.day ?? days.options[0].value;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-end gap-4">
      <SelectField label={crews.label} value={value.crewId ?? ALL_CREWS} options={crewOptions} onChange={(crewId) => onChange(withCrew(value, crewId))} className="min-w-56" />
      <SelectField label={days.label} value={day} options={days.options} onChange={(next) => onChange({ ...value, day: next })} className="min-w-44" />
    </div>
  );
}
