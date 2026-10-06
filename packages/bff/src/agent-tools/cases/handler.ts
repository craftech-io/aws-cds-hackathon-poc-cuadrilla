// `escalate_case` and `report_safety_hazard` (docs/tool-catalog.md, target `cases`) and the list of
// the target's four implementations. The agent opens cases and reports hazards; a person takes,
// declines and closes them (ADR-0011): `decision` is declared only so Cedar and `LAM-STRICT` refuse it.
//
//   escalate_case          one case per order and reason (the second call returns the existing one); the
//                          agent's summary is masked and checked by G2 and the deterministic fact check
//                          (`SummaryCheck`); a summary that does not pass is replaced by the fixed one
//                          built by code, and the case opens all the same
//   report_safety_hazard   the same handler as the lexicon (safety/handler.ts): the fixed instruction,
//                          the SAFETY case with both alerts in parallel and the hold; exempt from the
//                          kill switch (`LAM-KILL`), so physical safety is never cut
import { ToolError, fail } from "@cuadrilla/shared";
import { esMX } from "../../copy/es-MX";
import { openCase, openCaseOf } from "../../cases/open";
import { cleanSummary, fixedSummary } from "../../cases/summary";
import { handleSafety } from "../../safety/handler";
import { type ToolImplementation, implementTool } from "../common/context";
import { NO_ACTIVE_WORK_ORDER, requireActiveWorkOrder } from "../common/scope";
import { closeInstallation } from "./close";
import { type CasesContext, type CasesRuntime, caseDepsOf } from "./runtime";
import { escalateCaseTool, reportSafetyHazardTool } from "./schema";
import { recordTroubleshootingStep } from "./steps";

/** Longest agent summary kept (the schema's bound). */
const AGENT_SUMMARY_MAX = 500;

function turnAtSim(ctx: CasesContext): string {
  const atSim = ctx.scope.eventAtSim;
  if (atSim === undefined) throw new ToolError("INVALID", "this tool runs inside a turn", "NO_TURN");
  return atSim;
}

export const escalateCase = implementTool(escalateCaseTool, async (args, ctx: CasesContext) => {
  const order = await requireActiveWorkOrder(ctx);
  const atSim = turnAtSim(ctx);
  const deps = caseDepsOf(ctx);
  const existing = await openCaseOf(deps, order.workOrderId, args.reason);
  if (existing !== undefined) return { ok: true, caseId: existing.caseId, existing: true, rung: existing.rung };

  const masked = cleanSummary(args.summary, AGENT_SUMMARY_MAX);
  const check = await ctx.deps.summaries.verify({
    ispId: order.ispId,
    clockId: order.clockId,
    workOrderId: order.workOrderId,
    text: masked,
    ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }),
  });
  const summary = check.ok ? masked : fixedSummary({ reason: args.reason, reasonText: esMX.caseReason({ reason: args.reason }), workOrder: order });
  if (!check.ok) {
    ctx.logger.info("case.summary.replaced", { workOrderId: order.workOrderId, reason: check.reason ?? "REFUSED" });
    await ctx.deps.connector.audit.append({
      ispId: order.ispId,
      clockId: order.clockId,
      atSim,
      decision: "DENY",
      action: "CASE_SUMMARY_REPLACED",
      ruleIds: ["G2"],
      actor: ctx.actor,
      refs: { workOrderId: order.workOrderId, ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }) },
      ...(check.reason === undefined ? {} : { reason: check.reason }),
    });
  }
  const opened = await openCase(deps, { workOrderId: order.workOrderId, reason: args.reason, summary, atSim, actor: ctx.actor });
  const notified = opened.ladder?.notified;
  return {
    ok: true,
    caseId: opened.caseItem.caseId,
    existing: opened.existing,
    rung: opened.caseItem.rung,
    ...(notified === undefined ? {} : { notifiedFirstName: notified.firstName }),
  };
});

export const reportSafetyHazard = implementTool(reportSafetyHazardTool, async (args, ctx: CasesContext) => {
  const { scope } = ctx;
  if (scope.installerId === undefined) throw new ToolError("INVALID", "a hazard is reported for the installer of the session", "NO_INSTALLER");
  const outcome = await handleSafety(caseDepsOf(ctx), {
    ispId: scope.ispId,
    clockId: scope.clockId,
    installerId: scope.installerId,
    category: args.category,
    detectedBy: "AGENT",
    report: args.summary,
    atSim: turnAtSim(ctx),
    actor: ctx.actor,
    ...(scope.workOrderId === undefined ? {} : { workOrderId: scope.workOrderId }),
    ...(scope.sourceMessageId === undefined ? {} : { sourceMessageId: scope.sourceMessageId }),
    ...(scope.turnId === undefined ? {} : { turnId: scope.turnId }),
  });
  if (outcome.caseId === undefined) return fail("NOT_FOUND", "the safety instruction was sent; there is no order to open the case on", NO_ACTIVE_WORK_ORDER);
  return { ok: true, caseId: outcome.caseId, instructionSent: outcome.instructionSent };
});

/** The four tools of the `cases` target, implemented. */
export const CASES_IMPLEMENTATIONS: readonly ToolImplementation<CasesRuntime>[] = [recordTroubleshootingStep, escalateCase, reportSafetyHazard, closeInstallation];
