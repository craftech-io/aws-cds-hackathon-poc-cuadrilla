// What one `CP-*` rule answers for one message. A rule never throws and never reads anything but the
// policy input: it passes, fails with a reason (a failure by time also says until when), or does not
// apply to that message. A phone bound by code answers `NOT_APPLICABLE_LEASE` to quiet hours, so the
// decision records that the rule was skipped on purpose (ADR-0002).
import type { ContactRule } from "@cuadrilla/shared";
import type { PolicyReason } from "./reasons";
import type { PolicyInput } from "./types";

/** Which clock a time rule measured with: the world's simulated time or real time (ADR-0002). */
export type PolicyClock = "WORLD" | "REAL";

export type RuleResult = "PASS" | "FAIL" | "NOT_APPLICABLE" | "NOT_APPLICABLE_LEASE";

export interface RuleOutcome {
  readonly result: RuleResult;
  /** Only with `FAIL`. */
  readonly reason?: PolicyReason;
  readonly clock?: PolicyClock;
  /** Ids, instants and pattern ids only: never personal data (≤ 200 characters). */
  readonly detail?: string;
  /** A failure by time: the message waits until this instant of `clock` instead of being dropped. */
  readonly deferUntil?: { readonly at: Date; readonly clock: PolicyClock };
}

export type RuleCheck = (input: PolicyInput) => RuleOutcome;

export type RuleChecks<R extends ContactRule> = Readonly<Record<R, RuleCheck>>;

interface Extra {
  readonly clock?: PolicyClock;
  readonly detail?: string;
}

export function pass(extra: Extra = {}): RuleOutcome {
  return { result: "PASS", ...extra };
}

export function fail(reason: PolicyReason, extra: Extra = {}): RuleOutcome {
  return { result: "FAIL", reason, ...extra };
}

export function notApplicable(extra: Extra = {}): RuleOutcome {
  return { result: "NOT_APPLICABLE", ...extra };
}
