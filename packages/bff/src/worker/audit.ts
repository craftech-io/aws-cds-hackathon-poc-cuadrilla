// The worker's own decisions in `AuditLog` (docs/architecture.md §7 and §9.1): turns refused by the kill
// switch or a cap, guardrail blocks and masks, failed turns, fallbacks, session resets and dead-lettered
// events. Each one is written at most once per event and action (`IDEMP#AUDIT:<action>#<eventId>`), so
// a retried event never doubles a row; a failed write gives the mark back. Actor `WORKER`: deterministic
// code decided, never the agent.
import type { TurnTrigger } from "@cuadrilla/shared";
import type { AuditPort, RuntimePort } from "../connector/ports";
import type { AuditRefs } from "../domain/audit";
import type { JsonObject } from "../domain/common";

/** Actions the worker writes (labelled by the console's audit view). */
export const WORKER_ACTIONS = {
  killSwitch: "KILL_SWITCH_ACTIVE",
  turnCap: "TURN_CAP",
  guardrailBlock: "GUARDRAIL_BLOCK",
  guardrailMask: "GUARDRAIL_MASK",
  turnFailed: "TURN_FAILED",
  agentFallback: "AGENT_FALLBACK",
  sessionReset: "SESSION_RESET",
  physicalAction: "PHYSICAL_ACTION_REPORTED",
  timerStale: "TIMER_STALE",
  deadLettered: "EVENT_DEAD_LETTERED",
} as const;
export type WorkerAction = (typeof WORKER_ACTIONS)[keyof typeof WORKER_ACTIONS];

export interface WorkerDecision {
  readonly action: WorkerAction;
  readonly eventId: string;
  readonly ispId: string;
  readonly clockId: string;
  /** Simulated instant of the event: the decision's place in the order's timeline. */
  readonly atSim?: string;
  readonly decision?: "ACTION" | "DENY";
  readonly trigger?: TurnTrigger;
  readonly ruleIds?: readonly string[];
  readonly refs?: AuditRefs;
  readonly messageId?: string;
  readonly reason?: string;
  readonly detail?: JsonObject;
}

export type WorkerAudit = Pick<AuditPort, "append"> & { readonly runtime: Pick<RuntimePort, "claimIdempotency" | "releaseIdempotency"> };

const markSource = (action: WorkerAction): string => `AUDIT:${action}`;

/** Writes the decision once per event and action; a repeat returns `false` and writes nothing. */
export async function auditOnce(audit: WorkerAudit, decision: WorkerDecision): Promise<boolean> {
  const source = markSource(decision.action);
  if (!(await audit.runtime.claimIdempotency(source, decision.eventId))) return false;
  try {
    await audit.append({
      ispId: decision.ispId,
      clockId: decision.clockId,
      ...(decision.atSim === undefined ? {} : { atSim: decision.atSim }),
      decision: decision.decision ?? "ACTION",
      action: decision.action,
      ruleIds: [...(decision.ruleIds ?? [])],
      actor: "WORKER",
      refs: { ...decision.refs, eventId: decision.eventId },
      ...(decision.trigger === undefined ? {} : { trigger: decision.trigger }),
      ...(decision.messageId === undefined ? {} : { messageId: decision.messageId }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      ...(decision.detail === undefined ? {} : { detail: decision.detail }),
    });
  } catch (error) {
    await audit.runtime.releaseIdempotency(source, decision.eventId);
    throw error;
  }
  return true;
}

/** The audit port of a connector, for `auditOnce`. */
export function workerAudit(data: { readonly audit: Pick<AuditPort, "append">; readonly runtime: Pick<RuntimePort, "claimIdempotency" | "releaseIdempotency"> }): WorkerAudit {
  return { append: (input) => data.audit.append(input), runtime: data.runtime };
}
