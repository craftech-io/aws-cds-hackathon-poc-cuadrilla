// `audit` router of the console (docs/tool-catalog.md; FL-088): the world's decisions log.
//
//   list              decisions with their rules, trigger and actor, newest first, filtered by decision,
//                     action and rule (the world's simulated month unless asked)
//   violations        what `PolicyAudit` found (`VIOLATION`; it must be 0)
//   decisionsByRule   next to the violations: ALLOW, DENY and DEFER per rule, and blocks by origin
//                     (guardrails, policy, rate limits, the fence)
//
// Rows are ids and codes only (the audit log never holds a message or an address).
import { z } from "zod";
import { AuditDecision, RuleId } from "@cuadrilla/shared";
import type { Decision } from "../domain/audit";
import { inWorldTime, worldToday } from "./console-ports";
import { type IspContext, ispProcedure, router } from "./trpc";

const Month = z.string().regex(/^\d{4}-\d{2}$/);
const ListInput = z
  .object({ month: Month.optional(), decision: AuditDecision.optional(), action: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(), ruleId: RuleId.optional(), limit: z.number().int().min(1).max(500).optional() })
  .strict()
  .optional();
const MonthInput = z.object({ month: Month.optional() }).strict().optional();

type Ctx = Pick<IspContext, "deps" | "world">;

/** The actions that are a block, and the origin they count under. */
const BLOCK_ORIGINS: Readonly<Record<string, string>> = {
  GUARDRAIL_BLOCK: "GUARDRAIL",
  GUARDRAIL_MASK: "GUARDRAIL",
  CROSS_ISP: "FENCE",
  RECIPIENT_NOT_ALLOWED: "FENCE",
  RATE_LIMIT: "RATE_LIMIT",
  KILL_SWITCH_ACTIVE: "KILL_SWITCH",
  CAP_REACHED: "COST_CAP",
};

export function rowOf(decision: Decision) {
  return {
    decisionId: decision.decisionId,
    ts: decision.ts,
    atSim: decision.atSim ?? null,
    decision: decision.decision,
    action: decision.action,
    ruleIds: decision.ruleIds,
    trigger: decision.trigger ?? null,
    actor: decision.actor,
    reason: decision.reason ?? null,
    messageId: decision.messageId ?? null,
    workOrderId: typeof decision.refs.workOrderId === "string" ? decision.refs.workOrderId : null,
    caseId: typeof decision.refs.caseId === "string" ? decision.refs.caseId : null,
  };
}

async function monthOf(ctx: Ctx, month: string | undefined): Promise<string> {
  return month ?? (await worldToday(ctx)).day.slice(0, 7);
}

async function decisionsOf(ctx: Ctx, month: string): Promise<Decision[]> {
  const rows = await ctx.deps.connector.audit.listByMonth(ctx.world.ispId, month, { descending: true });
  return rows.filter((row) => row.clockId === undefined || row.clockId === ctx.world.clockId);
}

/** ALLOW, DENY and DEFER per rule, and blocks by origin. */
export function byRule(decisions: readonly Decision[]) {
  const rules = new Map<string, { ALLOW: number; DENY: number; DEFER: number }>();
  const blocks = new Map<string, number>();
  for (const row of decisions) {
    if (row.decision === "ALLOW" || row.decision === "DENY" || row.decision === "DEFER") {
      const failed = row.decision === "ALLOW" ? row.ruleIds : row.evaluated.length > 0 ? row.evaluated.filter((rule) => rule.result === "FAIL").map((rule) => rule.ruleId) : row.ruleIds;
      for (const ruleId of failed.length > 0 ? failed : ["NONE"]) {
        const counts = rules.get(ruleId) ?? { ALLOW: 0, DENY: 0, DEFER: 0 };
        counts[row.decision] += 1;
        rules.set(ruleId, counts);
      }
    }
    const origin = BLOCK_ORIGINS[row.action] ?? (row.decision === "DENY" && row.reason !== undefined ? BLOCK_ORIGINS[row.reason] : undefined);
    if (origin !== undefined) blocks.set(origin, (blocks.get(origin) ?? 0) + 1);
  }
  return {
    rules: [...rules.entries()].map(([ruleId, counts]) => ({ ruleId, ...counts })).sort((a, b) => b.DENY + b.DEFER - (a.DENY + a.DEFER) || a.ruleId.localeCompare(b.ruleId)),
    blocks: [...blocks.entries()].map(([origin, count]) => ({ origin, count })).sort((a, b) => b.count - a.count),
  };
}

export const auditRouter = router({
  list: ispProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const month = await monthOf(ctx, input?.month);
    const rows = (await decisionsOf(ctx, month)).filter(
      (row) =>
        (input?.decision === undefined || row.decision === input.decision) &&
        (input?.action === undefined || row.action === input.action) &&
        (input?.ruleId === undefined || row.ruleIds.includes(input.ruleId) || row.evaluated.some((rule) => rule.ruleId === input.ruleId)),
    );
    return inWorldTime(ctx, { month, decisions: rows.slice(0, input?.limit ?? 200).map(rowOf), total: rows.length });
  }),
  violations: ispProcedure.input(MonthInput).query(async ({ ctx }) => {
    const rows = (await ctx.deps.connector.audit.listByDecision(ctx.world.ispId, "VIOLATION")).filter((row) => row.clockId === undefined || row.clockId === ctx.world.clockId);
    return inWorldTime(ctx, { count: rows.length, violations: rows.map((row) => ({ ...rowOf(row), check: typeof row.detail?.check === "string" ? row.detail.check : null })) });
  }),
  decisionsByRule: ispProcedure.input(MonthInput).query(async ({ ctx, input }) => {
    const month = await monthOf(ctx, input?.month);
    const decisions = await decisionsOf(ctx, month);
    const violations = decisions.filter((row) => row.decision === "VIOLATION").length;
    return { month, violations, ...byRule(decisions) };
  }),
});
