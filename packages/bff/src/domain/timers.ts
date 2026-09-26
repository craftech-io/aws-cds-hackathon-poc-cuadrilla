// Timers (docs/architecture.md §8, ADR-0004): everything that has to happen at a simulated instant.
// A timer lives in the partition of what it belongs to: an order (`WorkOrders`), a case (`Cases`) or
// an installer without orders that day (`People`, `DAY_START` only). While `SCHEDULED` it carries the
// sparse `clockDueKey`, which the world clock queries to fire what is due, in order.
import { z } from "zod";
import { CaseId, ClockId, IsoInstant, PersonId, TimerFiredBy, TimerKind, TimerStatus, WorkOrderId } from "@cuadrilla/shared";
import { JsonObject, defineEntity } from "./common";

/** The item a timer belongs to, which decides its table and partition. */
export const TimerHome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("WORK_ORDER"), id: WorkOrderId }),
  z.object({ kind: z.literal("CASE"), id: CaseId }),
  z.object({ kind: z.literal("PERSON"), id: PersonId }),
]);
export type TimerHome = z.infer<typeof TimerHome>;

/** Timer ids are ours: letters, digits, `_` and `-` (they end up in a Scheduler schedule name). */
export const TimerId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "expected a timer id of letters, digits, _ or -");
export type TimerId = z.infer<typeof TimerId>;

export const Timer = defineEntity("Timer", {
  timerId: TimerId,
  kind: TimerKind,
  home: TimerHome,
  clockId: ClockId,
  dueAtSim: IsoInstant,
  status: TimerStatus,
  firedBy: TimerFiredBy.optional(),
  firedAtSim: IsoInstant.optional(),
  /** EventBridge Scheduler schedule (`tm-<w>-<timerId>`), only while the world clock is RUNNING. */
  scheduleName: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  reason: z.string().max(200).optional(),
  payload: JsonObject.default({}),
});
export type Timer = z.infer<typeof Timer>;
