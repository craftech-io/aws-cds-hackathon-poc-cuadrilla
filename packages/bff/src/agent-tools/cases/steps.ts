// `record_troubleshooting_step` (docs/tool-catalog.md, target `cases`): the agent records a step it
// indicated from the manual and what happened. The step must name a section the manual returned in this
// session: in this turn's `search_procedures`, a section the agent cited to the installer on this order,
// or a step already on the order (a `PENDING` step whose outcome arrives in the next turn). A step that
// resolves a `PENDING` one of the same symptom and section updates it; any other is a new step. The
// third `NO_CHANGE`/`WORSE` of the same symptom opens the `DIAGNOSIS_ATTEMPTS` case by itself (code,
// never the model, FL-023). Nothing is recorded while the order is on hold for safety.
import { z } from "zod";
import { ManualSectionId, ToolError } from "@cuadrilla/shared";
import { esMX } from "../../copy/es-MX";
import type { TroubleshootingStep, WorkOrder } from "../../domain/work-orders";
import { openCase, openCaseOf } from "../../cases/open";
import { failedStepsBySymptom, fixedSummary } from "../../cases/summary";
import { implementTool } from "../common/context";
import { requireActiveWorkOrder } from "../common/scope";
import { recordTroubleshootingStepTool } from "./schema";
import { type CasesContext, caseDepsOf } from "./runtime";

/** Failed steps of one symptom that open the case. */
export const DIAGNOSIS_ATTEMPTS_LIMIT = 3;

/** How far back the agent's cited sections count (the order's conversation of the day). */
const CITATIONS_LOOKBACK_MS = 24 * 3_600_000;

const SearchOutput = z.object({ passages: z.array(z.object({ sectionId: ManualSectionId }).loose()).default([]) }).loose();

/** `DIAG-02-a` → `DIAG-02`: the manual section a step (or sub-step) belongs to. */
export function sectionOf(stepRef: string): string {
  return stepRef.split("-").slice(0, 2).join("-");
}

/** Sections the manual returned to this session for the order. */
async function knownSections(ctx: CasesContext, order: WorkOrder, steps: readonly TroubleshootingStep[], atSim: string): Promise<Set<string>> {
  const { connector } = ctx.deps;
  const known = new Set(steps.map((step) => sectionOf(step.stepRef)));
  if (ctx.scope.turnId !== undefined) {
    for (const result of await connector.runtime.listTurnResults(ctx.scope.turnId, "search_procedures")) {
      const parsed = SearchOutput.safeParse(result.output);
      if (parsed.success) for (const passage of parsed.data.passages) known.add(passage.sectionId);
    }
  }
  const fromSim = new Date(Date.parse(atSim) - CITATIONS_LOOKBACK_MS).toISOString();
  const thread = await connector.conversations.listMessages(order.installerId, { fromSim, toSim: atSim });
  for (const message of thread) {
    if (message.direction !== "OUT" || message.author !== "AGENT" || message.workOrderId !== order.workOrderId) continue;
    const cited = message.refs?.citations;
    if (Array.isArray(cited)) for (const section of cited) if (typeof section === "string") known.add(section);
  }
  return known;
}

export const recordTroubleshootingStep = implementTool(recordTroubleshootingStepTool, async (args, ctx: CasesContext) => {
  const order = await requireActiveWorkOrder(ctx);
  if (order.onHoldSafety) throw new ToolError("ON_HOLD_SAFETY", "the order is on hold for safety until a supervisor closes its case", "ON_HOLD_SAFETY");
  const atSim = ctx.scope.eventAtSim;
  if (atSim === undefined) throw new ToolError("INVALID", "a step is recorded inside a turn", "NO_TURN");
  const { workOrders, audit, people } = ctx.deps.connector;
  const steps = await workOrders.listSteps(order.workOrderId);
  if (!(await knownSections(ctx, order, steps, atSim)).has(sectionOf(args.stepRef))) {
    throw new ToolError("INVALID", "stepRef must be a manual section search_procedures returned in this session", "STEP_REF_UNKNOWN");
  }

  const pending = steps.find((step) => step.symptom === args.symptom && step.stepRef === args.stepRef && step.outcome === "PENDING");
  const transition = { actor: ctx.actor, atSim, reason: args.outcome };
  const step =
    pending !== undefined && args.outcome !== "PENDING"
      ? await workOrders.updateStepOutcome(order.workOrderId, pending.seq, args.outcome, transition)
      : await workOrders.appendStep({ workOrderId: order.workOrderId, clockId: order.clockId, symptom: args.symptom, stepRef: args.stepRef, outcome: args.outcome, recordedAtSim: atSim, ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }) });
  const failed = args.outcome === "NO_CHANGE" || args.outcome === "WORSE";
  if (failed) await people.recordProfileEvent(order.installerId, order.clockId, { kind: "STEP", code: args.symptom, atSim, workOrderId: order.workOrderId });

  const allSteps = await workOrders.listSteps(order.workOrderId);
  const failedAttempts = failedStepsBySymptom(allSteps).get(args.symptom)?.length ?? 0;
  await audit.append({
    ispId: order.ispId,
    clockId: order.clockId,
    atSim,
    decision: "ACTION",
    action: "STEP_RECORDED",
    actor: ctx.actor,
    ...(ctx.identity.kind === "HARNESS" ? { trigger: ctx.identity.session.trigger } : {}),
    refs: { workOrderId: order.workOrderId, ...(ctx.scope.turnId === undefined ? {} : { turnId: ctx.scope.turnId }) },
    detail: { seq: step.seq, symptom: args.symptom, stepRef: args.stepRef, outcome: args.outcome, failedAttempts },
  });

  const base = { stepId: `step-${step.seq}`, failedAttempts };
  if (failedAttempts < DIAGNOSIS_ATTEMPTS_LIMIT) return { ok: true, ...base };
  const deps = caseDepsOf(ctx);
  const already = await openCaseOf(deps, order.workOrderId, "DIAGNOSIS_ATTEMPTS");
  if (already !== undefined) return { ok: true, ...base, caseOpened: { caseId: already.caseId, reason: already.reason } };
  if (!failed) return { ok: true, ...base };
  const reasonText = esMX.caseReason({ reason: "DIAGNOSIS_ATTEMPTS", symptom: args.symptom });
  const summary = fixedSummary({ reason: "DIAGNOSIS_ATTEMPTS", reasonText, workOrder: order, steps: allSteps.filter((item) => item.symptom === args.symptom) });
  const opened = await openCase(deps, { workOrderId: order.workOrderId, reason: "DIAGNOSIS_ATTEMPTS", summary, atSim, actor: "SYSTEM" });
  return { ok: true, ...base, caseOpened: { caseId: opened.caseItem.caseId, reason: opened.caseItem.reason } };
});
