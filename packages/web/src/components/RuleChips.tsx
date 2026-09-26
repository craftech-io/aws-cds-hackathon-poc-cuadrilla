// The rules of one decision, in the order the decision recorded them, as a named list of chips.
// Repeated ids are shown once; without rules the list says so instead of rendering nothing.
import { RuleChip } from "./RuleChip";

interface RuleChipsProps {
  readonly ruleIds: readonly string[];
  /** Accessible name of the list ("Reglas de la decisión"). */
  readonly label: string;
  /** Meaning of each rule, when the view knows it. */
  readonly describe?: (ruleId: string) => string | undefined;
  /** What an empty list reads ("Sin reglas registradas"). */
  readonly emptyText?: string;
}

export function RuleChips({ ruleIds, label, describe, emptyText }: RuleChipsProps) {
  const unique = [...new Set(ruleIds)];
  if (unique.length === 0) return emptyText ? <span className="text-xs text-slate">{emptyText}</span> : null;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1">
      {unique.map((ruleId) => {
        const description = describe?.(ruleId);
        return (
          <li key={ruleId}>
            <RuleChip ruleId={ruleId} {...(description !== undefined ? { description } : {})} />
          </li>
        );
      })}
    </ul>
  );
}
