// One rule that decided something (`CP-WA-24H`, `LAM-SCOPE`, `G2`): the id, coloured by its family
// (contact policy, Cedar, Lambda fences, guardrails, safety, photo checks, ladder), with what the
// rule means as its accessible description and tooltip. The meaning arrives by props: the views
// that show decisions own those texts.
import { RuleId, type RuleFamily, ruleFamilyOf } from "@cuadrilla/shared";

const FAMILY_TONE: Readonly<Record<RuleFamily, string>> = {
  CP: "border-info/30 bg-info-soft text-info",
  CED: "border-navy/20 bg-mist text-navy",
  LAM: "border-slate/30 bg-paper text-slate",
  G: "border-warning/30 bg-warning-soft text-warning",
  SAFE: "border-danger/30 bg-danger-soft text-danger",
  VAL: "border-cyan-deep/30 bg-cyan-soft text-cyan-deep",
  LAD: "border-success/30 bg-success-soft text-success",
};

const UNKNOWN_TONE = "border-mist bg-white text-slate";

/** Tone of a rule id by its family; an id that is not a rule id is drawn neutral, never dropped. */
export function ruleTone(ruleId: string): string {
  return RuleId.safeParse(ruleId).success ? FAMILY_TONE[ruleFamilyOf(ruleId)] : UNKNOWN_TONE;
}

interface RuleChipProps {
  readonly ruleId: string;
  /** What the rule means ("Ventana de 24 h de WhatsApp"). */
  readonly description?: string;
}

export function RuleChip({ ruleId, description }: RuleChipProps) {
  return (
    <span title={description} className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-xs font-semibold ${ruleTone(ruleId)}`}>
      {ruleId}
      {description ? <span className="sr-only">: {description}</span> : null}
    </span>
  );
}
