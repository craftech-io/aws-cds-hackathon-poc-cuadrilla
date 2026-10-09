// The five checklist items of an order as marks, in closing order: validated ✓, rejected ✗, in review ?,
// pending –. Each mark names its item and state for assistive technology and as a tooltip.
import type { MarkState } from "./orders-model";
import { type ChecklistMark, checklistMarks } from "./orders-model";

const GLYPH: Readonly<Record<MarkState, string>> = { done: "✓", rejected: "✗", review: "?", pending: "–" };

const TONE: Readonly<Record<MarkState, string>> = {
  done: "border-success/30 bg-success-soft text-success",
  rejected: "border-danger/30 bg-danger-soft text-danger",
  review: "border-warning/30 bg-warning-soft text-warning",
  pending: "border-mist bg-white text-slate",
};

export function ChecklistMarks({ checklist, label }: { readonly checklist: readonly ChecklistMark[]; readonly label: string }) {
  return (
    <ul aria-label={label} className="flex gap-1">
      {checklistMarks(checklist).map((mark) => (
        <li key={mark.item}>
          <span role="img" aria-label={mark.label} title={mark.label} className={`inline-flex size-6 items-center justify-center rounded-full border text-xs font-bold ${TONE[mark.state]}`}>
            {GLYPH[mark.state]}
          </span>
        </li>
      ))}
    </ul>
  );
}
