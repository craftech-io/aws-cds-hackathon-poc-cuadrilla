// `AuditLog` table (docs/architecture.md §5): append-only decisions. Every policy decision, action
// with effects, denial and violation is one row, partitioned by operator and month and indexed by
// order and by decision. `PolicyAudit` reads them back; the console draws `ruleIds` as chips.
import { z } from "zod";
import { AuditDecision, ClockId, IsoInstant, IspId, RuleId, TurnTrigger } from "@cuadrilla/shared";
import { Actor, JsonObject, defineEntity } from "./common";

/** One rule the policy evaluated for this decision and what it said. */
export const EvaluatedRule = z.object({
  ruleId: RuleId,
  result: z.enum(["PASS", "FAIL", "SKIP", "NOT_APPLICABLE", "NOT_APPLICABLE_LEASE"]),
  clock: z.enum(["WORLD", "REAL"]).optional(),
  detail: z.string().max(200).optional(),
});
export type EvaluatedRule = z.infer<typeof EvaluatedRule>;

/** Upper-case action names (`SEND_WHATSAPP`, `CASE_TAKEN`, `GUARDRAIL_BLOCK`, `SEED_LOADED`…). */
export const AuditAction = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "expected an upper-case action name");
export type AuditAction = z.infer<typeof AuditAction>;

/** References of a decision; ids only, never personal data. */
export const AuditRefs = z
  .object({
    workOrderId: z.string().optional(),
    caseId: z.string().optional(),
    turnId: z.string().optional(),
    eventId: z.string().optional(),
    timerKey: z.string().optional(),
    mailId: z.string().optional(),
  })
  .catchall(z.unknown());
export type AuditRefs = z.infer<typeof AuditRefs>;

export const Decision = defineEntity("Decision", {
  decisionId: z.string().min(1).max(64),
  ispId: IspId,
  clockId: ClockId.optional(),
  /** Sort instant (UTC ISO): the simulated instant of the world, or real time outside a world. */
  ts: IsoInstant,
  atSim: IsoInstant.optional(),
  atReal: IsoInstant,
  decision: AuditDecision,
  action: AuditAction,
  ruleIds: z.array(RuleId).default([]),
  evaluated: z.array(EvaluatedRule).default([]),
  messageId: z.string().min(1).max(200).optional(),
  trigger: TurnTrigger.optional(),
  actor: Actor,
  refs: AuditRefs.default({}),
  reason: z.string().max(200).optional(),
  detail: JsonObject.optional(),
});
export type Decision = z.infer<typeof Decision>;
