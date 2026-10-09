// How the decisions log reads `audit.list`, `audit.violations` and `audit.decisionsByRule`
// (packages/bff/src/routers/audit.ts): codes and actors in words (an actor's id is never shown), the
// decision filter, the rules on offer and the totals of the summary. Pure: tested without a browser.
import type { BadgeTone } from "../../components/Badge";
import type { RouterInputs, RouterOutputs } from "../../lib/trpc-router";
import { codeLabel } from "../../lib/code-label";
import { auditCopy as copy } from "./copy";

export type DecisionRow = RouterOutputs["audit"]["list"]["decisions"][number];
export type ByRule = RouterOutputs["audit"]["decisionsByRule"];
type ListInput = Exclude<RouterInputs["audit"]["list"], void | undefined>;
export type DecisionKind = NonNullable<ListInput["decision"]>;
export type DecisionFilter = DecisionKind | "ALL";

export const DECISION_FILTERS: readonly DecisionFilter[] = ["ALL", "ALLOW", "DENY", "DEFER", "ACTION", "VIOLATION"];

/** Who decided, in words: the kind of actor, never its id (`PERSON:inst-…` reads "Persona del mundo"). */
export function actorText(actor: string): string {
  const kind = actor.split(":")[0] ?? actor;
  return copy.actors[kind] ?? codeLabel({}, kind);
}

export function actionText(action: string): string {
  return codeLabel(copy.actions, action);
}

export function triggerText(trigger: string | null): string {
  return trigger === null ? copy.noValue : codeLabel(copy.triggers, trigger);
}

/** A reason code in words; a reason with free text is left out (the log keeps codes, not messages). */
export function reasonText(reason: string | null): string {
  if (reason === null || !/^[A-Z][A-Z0-9_-]*$/.test(reason)) return copy.noValue;
  return codeLabel(copy.reasons, reason);
}

const TONES: Readonly<Record<string, BadgeTone>> = { ALLOW: "success", DENY: "danger", DEFER: "warning", ACTION: "info", VIOLATION: "danger" };

export function decisionTone(decision: string): BadgeTone {
  return TONES[decision] ?? "neutral";
}

/** The input of `audit.list` for a filter. */
export function listInput(decision: DecisionFilter, ruleId: string): ListInput {
  return { ...(decision === "ALL" ? {} : { decision }), ...(ruleId === "" ? {} : { ruleId }) };
}

/** The rules a decision can be filtered by: the ones the month's decisions name, without the "no rule" bucket. */
export function ruleOptions(byRule: ByRule | undefined): string[] {
  return (byRule?.rules ?? []).map((rule) => rule.ruleId).filter((ruleId) => ruleId !== "NONE");
}

export function totals(byRule: ByRule): { readonly deny: number; readonly defer: number } {
  return byRule.rules.reduce((sum, rule) => ({ deny: sum.deny + rule.DENY, defer: sum.defer + rule.DEFER }), { deny: 0, defer: 0 });
}

/** `2026-10` → "10/2026". */
export function monthLabel(month: string): string {
  const [year, number] = month.split("-");
  return `${number ?? ""}/${year ?? ""}`;
}
