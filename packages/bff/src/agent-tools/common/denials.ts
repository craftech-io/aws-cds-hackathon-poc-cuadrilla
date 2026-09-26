// `AuditLog DENY` of a refused tool call (docs/tool-catalog.md, Convenciones): an id outside the
// session's scope (`LAM-SCOPE`), an undeclared or denied argument (`LAM-STRICT` with the Cedar rule
// that forbids the field). One row per refusal with the rules that decided it, the tool and the
// turn; never the refused value when it could carry personal data. A failed write is logged and the
// call is refused all the same.
import type { AuditRefs } from "../../domain/audit";
import type { JsonObject } from "../../domain/common";
import type { ToolContext } from "./context";

/** Action of every refusal row; `ruleIds` says which fence refused. */
export const TOOL_DENIED_ACTION = "TOOL_DENIED";

export type DenialContext = Pick<ToolContext, "tool" | "scope" | "identity" | "actor" | "deps" | "logger">;

export interface ToolDenial {
  readonly ruleIds: readonly string[];
  readonly reason: string;
  readonly refs?: AuditRefs;
  readonly detail?: JsonObject;
}

export async function auditToolDenial(ctx: DenialContext, denial: ToolDenial): Promise<void> {
  const { scope } = ctx;
  try {
    await ctx.deps.connector.audit.append({
      ispId: scope.ispId,
      clockId: scope.clockId,
      ...(scope.eventAtSim === undefined ? {} : { atSim: scope.eventAtSim }),
      ...(ctx.identity.kind === "HARNESS" ? { trigger: ctx.identity.session.trigger } : {}),
      decision: "DENY",
      action: TOOL_DENIED_ACTION,
      ruleIds: [...denial.ruleIds],
      actor: ctx.actor,
      reason: denial.reason,
      refs: {
        tool: ctx.tool,
        ...(scope.turnId === undefined ? {} : { turnId: scope.turnId }),
        ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
        ...(scope.workOrderId === undefined ? {} : { workOrderId: scope.workOrderId }),
        ...denial.refs,
      },
      ...(denial.detail === undefined ? {} : { detail: denial.detail }),
    });
  } catch (error) {
    ctx.logger.error("tool.audit.failed", { tool: ctx.tool, auditAction: TOOL_DENIED_ACTION, ruleIds: denial.ruleIds, error });
  }
  ctx.logger.warn("tool.denied", { tool: ctx.tool, ruleIds: denial.ruleIds, reason: denial.reason });
}
