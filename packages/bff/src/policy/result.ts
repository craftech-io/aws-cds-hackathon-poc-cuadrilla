// A policy decision as the rest of the product records and answers it: the `PolicyResult` a tool
// returns (docs/tool-catalog.md), the `AuditLog` row (`ALLOW` with its `messageId` and the rules
// evaluated, `DENY`, `DEFER`), the `policy` of the `Conversations` message and the error code a tool
// answers the agent when its message is held back.
import { type ErrorCode, PolicyResult, type TurnTrigger } from "@cuadrilla/shared";
import type { DecisionInput } from "../connector/ports";
import type { AuditRefs } from "../domain/audit";
import type { Actor } from "../domain/common";
import type { MessagePolicy } from "../domain/conversations";
import type { PolicyDecision } from "./engine";

export function toPolicyResult(decision: PolicyDecision): PolicyResult {
  return PolicyResult.parse({
    allowed: decision.allowed,
    ruleIds: [...decision.ruleIds],
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.nextAllowedAt === undefined ? {} : { nextAllowedAt: decision.nextAllowedAt }),
  });
}

/** Who and what an audit row of a decision is about. */
export interface DecisionAudit {
  readonly ispId: string;
  readonly clockId?: string;
  /** `SEND_WHATSAPP`, `SEND_EMAIL`, `DAY_START`… */
  readonly action: string;
  readonly actor: Actor;
  readonly messageId?: string;
  readonly trigger?: TurnTrigger;
  readonly refs?: AuditRefs;
}

/** The `AuditLog` row of a decision (`connector.audit.append`). */
export function toDecisionInput(decision: PolicyDecision, audit: DecisionAudit): DecisionInput {
  return {
    ispId: audit.ispId,
    ...(audit.clockId === undefined ? {} : { clockId: audit.clockId }),
    atSim: decision.at.sim,
    decision: decision.outcome,
    action: audit.action,
    ruleIds: [...decision.ruleIds],
    evaluated: [...decision.evaluated],
    ...(audit.messageId === undefined ? {} : { messageId: audit.messageId }),
    ...(audit.trigger === undefined ? {} : { trigger: audit.trigger }),
    actor: audit.actor,
    ...(audit.refs === undefined ? {} : { refs: audit.refs }),
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(decision.nextAllowedAt === undefined ? {} : { detail: { nextAllowedAt: decision.nextAllowedAt, nextAllowedClock: decision.nextAllowedClock ?? "WORLD" } }),
  };
}

/** The `policy` of the `Conversations` message the decision was taken for. */
export function toMessagePolicy(decision: PolicyDecision, decisionId?: string): MessagePolicy {
  return { decision: decision.outcome, ruleIds: [...decision.ruleIds], ...(decisionId === undefined ? {} : { decisionId }) };
}

/** The error code of a tool whose message the policy held back; `undefined` when it may go. */
export function errorCodeOf(decision: PolicyDecision): ErrorCode | undefined {
  if (decision.allowed) return undefined;
  switch (decision.deniedBy) {
    case "CP-QUIET-HOURS":
      return "DEFERRED";
    case "CP-BRIDGE":
      return "BRIDGE_ACTIVE";
    case "CP-WA-24H":
      return "TEMPLATE_REQUIRED";
    case "CP-RECIPIENT-FENCE":
      return decision.reason === "EMAIL_CAP_REACHED" ? "CAP_REACHED" : "RECIPIENT_NOT_ALLOWED";
    case "CP-CITATION":
      return "GROUNDING_FAIL";
    default:
      return "POLICY_DENIED";
  }
}
