// `evidence` router of the console (docs/tool-catalog.md; FL-043, FL-044, ADR-0011): the photos a person
// has to look at and the manual validation.
//
//   queue      photo items `IN_REVIEW` (the validator was unsure) or `REJECTED` of the world's open
//              orders of the day, each with its latest validation (verdict, reason, readings, checks)
//              and the rubric of the item; nothing automatic decides them afterwards
//   override   S R: a supervisor or a guest, with a sign-in of the last 15 minutes and a reason, marks
//              the item `OVERRIDDEN` (services/evidence-override); the agent then tells the installer
//              what is left (`AGENT_TURN(EVIDENCE_OVERRIDDEN)` on the installer's queue)
import { z } from "zod";
import { CalendarDate, PhotoItem, WorkOrderId } from "@cuadrilla/shared";
import { NonEmptyText } from "../domain/common";
import type { PhotoValidation, WorkOrder } from "../domain/work-orders";
import { OPEN_ORDER_STATUSES, overrideEvidence } from "../services/evidence-override/override";
import { consoleCall, inWorldTime, worldToday } from "./console-ports";
import { type IspContext, ispProcedure, recentLoginProcedure, router } from "./trpc";

const PHOTO_ITEMS: ReadonlySet<string> = new Set(PhotoItem.options);
const REVIEWABLE: ReadonlySet<string> = new Set(["IN_REVIEW", "REJECTED"]);
const DEFAULT_RUBRIC = "v001";

const QueueInput = z.object({ day: CalendarDate.optional() }).strict().optional();
const OverrideInput = z.object({ workOrderId: WorkOrderId, item: PhotoItem, reason: NonEmptyText.min(3).max(500) }).strict();

type Ctx = Pick<IspContext, "deps" | "world">;

function latest(validations: readonly PhotoValidation[], item: string): PhotoValidation | undefined {
  return validations.filter((found) => found.item === item).sort((a, b) => b.atSim.localeCompare(a.atSim))[0];
}

async function itemsOf(ctx: Ctx, order: WorkOrder) {
  const data = ctx.deps.connector;
  const [checklist, validations] = await Promise.all([data.workOrders.listChecklist(order.workOrderId), data.workOrders.listValidations(order.workOrderId)]);
  const waiting = checklist.filter((entry) => PHOTO_ITEMS.has(entry.item) && REVIEWABLE.has(entry.status));
  return Promise.all(
    waiting.map(async (entry) => {
      const validation = latest(validations, entry.item);
      const rubric = await data.reference.getRubric(validation?.rubricVersion ?? DEFAULT_RUBRIC, PhotoItem.parse(entry.item));
      return {
        workOrderId: order.workOrderId,
        workOrderNumber: order.workOrderNumber,
        installerId: order.installerId,
        item: entry.item,
        status: entry.status,
        attempts: entry.attempts,
        lastRejectReason: entry.lastRejectReason ?? null,
        validation:
          validation === undefined
            ? null
            : {
                validationId: validation.validationId,
                verdict: validation.verdict,
                modelVerdict: validation.modelVerdict ?? null,
                reasonCode: validation.reasonCode ?? null,
                readings: validation.readings,
                checks: validation.checks,
                confidence: validation.confidence ?? null,
                evidenceId: validation.evidenceId ?? null,
                atSim: validation.atSim,
              },
        rubric: rubric === undefined ? null : { version: rubric.rubricVersion, mustShow: rubric.mustShow },
      };
    }),
  );
}

async function reviewQueue(ctx: Ctx, input: z.infer<typeof QueueInput>) {
  const today = await worldToday(ctx);
  const day = input?.day ?? today.day;
  const orders = (await ctx.deps.connector.workOrders.listIspDay(ctx.world.ispId, day)).filter((order) => order.clockId === ctx.world.clockId && OPEN_ORDER_STATUSES.has(order.status));
  const items = (await Promise.all(orders.map((order) => itemsOf(ctx, order)))).flat();
  // Unsure first (a person decides them), then the rejected ones, oldest first.
  items.sort((a, b) => Number(b.status === "IN_REVIEW") - Number(a.status === "IN_REVIEW") || (a.validation?.atSim ?? "").localeCompare(b.validation?.atSim ?? ""));
  return { day, items };
}

export const evidenceRouter = router({
  queue: ispProcedure.input(QueueInput).query(async ({ ctx, input }) => inWorldTime(ctx, await reviewQueue(ctx, input))),
  override: recentLoginProcedure.input(OverrideInput).mutation(async ({ ctx, input }) => {
    const { ports, caller } = consoleCall(ctx);
    const result = await overrideEvidence({ ...ports.services, queue: ports.queue }, caller, input);
    ctx.log.info("evidence.overridden", { workOrderId: result.workOrderId, item: result.item, eventId: result.eventId });
    return inWorldTime(ctx, result);
  }),
});
