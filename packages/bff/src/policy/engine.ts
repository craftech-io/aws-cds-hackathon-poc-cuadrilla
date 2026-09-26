// The contact policy (docs/design-brief.md §5.7, ADR-0012): a pure function from one message, its
// recipient and the facts at one instant to a decision. The fifteen `CP-*` rules run in the fixed
// order of `ContactRule` (packages/shared/src/rules.ts); the first one that denies decides, the rest
// are recorded as `SKIP`. A denial by time (quiet hours) is a `DEFER` with `nextAllowedAt`: the
// message waits for `TIMER#DEFERRED_SEND`, it is not dropped. The decision lists every rule with its
// result and the clock the time rules used, which `AuditLog.evaluated` stores and `PolicyAudit`
// compares when it re-evaluates a sent message (as-of.ts).
//
// Callers: the outbound pipeline (every send, including system messages, the ladder, the bridge and
// the certificate), `fire_day_start`, `InboundWhatsApp` (replies to unknown numbers) and `PolicyAudit`.
import { ContactRule } from "@cuadrilla/shared";
import type { EvaluatedRule } from "../domain/audit";
import type { PolicyClock, RuleCheck, RuleOutcome } from "./check";
import { type PolicyReason, REASON_RULE } from "./reasons";
import { AUDIENCE_CHECKS } from "./rules-audience";
import { CONTENT_CHECKS } from "./rules-content";
import { TIME_CHECKS } from "./rules-time";
import { PolicyInput, type PolicyInputShape, type PolicyInstant } from "./types";

const CHECKS: Readonly<Record<ContactRule, RuleCheck>> = { ...AUDIENCE_CHECKS, ...TIME_CHECKS, ...CONTENT_CHECKS };

/** The fifteen rules in evaluation order (docs/design-brief.md §5.7). */
export const RULE_ORDER: readonly ContactRule[] = ContactRule.options;

/** `AuditLog.decision` of a policy decision. */
export type PolicyOutcome = "ALLOW" | "DENY" | "DEFER";

export interface PolicyDecision {
  readonly outcome: PolicyOutcome;
  readonly allowed: boolean;
  /** ALLOW: the rules that applied and passed. DENY and DEFER: the rule that decided. */
  readonly ruleIds: readonly ContactRule[];
  readonly deniedBy?: ContactRule;
  readonly reason?: PolicyReason;
  /** DEFER only: when the message may go, on `nextAllowedClock`. */
  readonly nextAllowedAt?: string;
  readonly nextAllowedClock?: PolicyClock;
  /** All fifteen rules in order; after the rule that decided, `SKIP`. */
  readonly evaluated: readonly EvaluatedRule[];
  /** The instant the decision was taken at, on both clocks. */
  readonly at: PolicyInstant;
}

const DETAIL_MAX = 200;

function entryOf(ruleId: ContactRule, outcome: RuleOutcome): EvaluatedRule {
  return {
    ruleId,
    result: outcome.result,
    ...(outcome.clock === undefined ? {} : { clock: outcome.clock }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail.slice(0, DETAIL_MAX) }),
  };
}

/**
 * Decides whether one message may leave now. Throws a `ZodError` on a malformed input: that is a
 * bug of the caller, and nothing is sent without a decision.
 */
export function evaluate(raw: PolicyInputShape): PolicyDecision {
  const input = PolicyInput.parse(raw);
  const evaluated: EvaluatedRule[] = [];
  const passed: ContactRule[] = [];
  let decided: { readonly ruleId: ContactRule; readonly outcome: RuleOutcome } | undefined;
  for (const ruleId of RULE_ORDER) {
    if (decided !== undefined) {
      evaluated.push({ ruleId, result: "SKIP" });
      continue;
    }
    const outcome = CHECKS[ruleId](input);
    evaluated.push(entryOf(ruleId, outcome));
    if (outcome.result === "PASS") passed.push(ruleId);
    if (outcome.result === "FAIL") decided = { ruleId, outcome };
  }
  const at = { sim: input.facts.now.sim, real: input.facts.now.real };
  if (decided === undefined) return { outcome: "ALLOW", allowed: true, ruleIds: passed, evaluated, at };

  const { ruleId, outcome } = decided;
  if (outcome.reason === undefined || REASON_RULE[outcome.reason] !== ruleId) {
    throw new RangeError(`${ruleId} denied with reason ${outcome.reason ?? "(none)"}, which belongs to another rule`);
  }
  const defer = outcome.deferUntil;
  return {
    outcome: defer === undefined ? "DENY" : "DEFER",
    allowed: false,
    ruleIds: [ruleId],
    deniedBy: ruleId,
    reason: outcome.reason,
    ...(defer === undefined ? {} : { nextAllowedAt: defer.at.toISOString(), nextAllowedClock: defer.clock }),
    evaluated,
    at,
  };
}

/** The entry of one rule in a decision (its result, clock and detail). */
export function ruleEntry(decision: PolicyDecision, ruleId: ContactRule): EvaluatedRule {
  const entry = decision.evaluated.find((candidate) => candidate.ruleId === ruleId);
  if (entry === undefined) throw new RangeError(`${ruleId} is not a contact rule`);
  return entry;
}
