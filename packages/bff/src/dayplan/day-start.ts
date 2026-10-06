// `fire_day_start` (docs/tool-catalog.md, docs/architecture.md §8; FL-009, FL-012, FL-014): what the
// 07:30 `TIMER#DAY_START` of an installer does when it fires (by the Scheduler, by the clock moving or
// forced by `clock.fireDayStart`):
//
//   1. count the installer's orders of the day still to do (`WorkOrders GSI1`: a rescheduled order
//      counts on its new day; a cancelled or reassigned one does not);
//   2. with at least one: the `ordenes_del_dia` template (first name, how many, first window) with the
//      "Ver órdenes" button, through the outbound pipeline, whose policy may deny it (`CP-OPTIN`,
//      `CP-OPTOUT`, `CP-ONE-DAYSTART`…: a second start the same day never sends twice);
//   3. with none: nothing is sent; the timer ends `SKIPPED` with `NO_WORK_ORDERS`;
//   4. always: `plan_day(day + 1)` for every active installer of the world (idempotent).
//
// Parameters are built by code from the stored orders, never by a model.
import { type CalendarDate, CalendarDate as CalendarDateSchema, InstallerId, addCalendarDays } from "@cuadrilla/shared";
import { z } from "zod";
import { timerRefKey } from "../connector/keys";
import type { Timer } from "../domain/timers";
import type { WorkOrder } from "../domain/work-orders";
import { MEXICO_CITY_TIME_ZONE } from "../services/business-hours/zoned-time";
import { windowText } from "../agent-tools/orders/time-text";
import { PENDING_STATUSES, installerDayOrders } from "./active-order";
import { type PlanDayResult, planDay } from "./plan-day";
import type { DayStartDeps, DayStartSendOutcome } from "./ports";

export const DAY_START_SKIPPED = "DAY_START_SKIPPED";

export type DayStartSkipReason = "NO_WORK_ORDERS" | "INSTALLER_NOT_FOUND";

/** What a `DAY_START` timer carries (docs/seed-spec.md §3: `payload {installerId, date}`). */
export const DayStartPayload = z.object({ installerId: InstallerId, date: CalendarDateSchema });

export interface FireDayStartRequest {
  readonly clockId: string;
  readonly installerId: string;
  readonly date: CalendarDate;
  /** `dueAtSim` when the clock reached it, `simNow` when forced. */
  readonly eventAtSim: string;
  readonly correlationId: string;
  /** The timer as `TimerPort.fire` left it (`FIRED`); absent when a person forced the start. */
  readonly timer?: Timer;
}

export type FireDayStartOutcome = (
  | DayStartSendOutcome
  | { readonly status: "SKIPPED"; readonly reason: DayStartSkipReason }
) & { readonly workOrderIds: readonly string[]; readonly nextDay?: PlanDayResult };

/** The request of a fired `DAY_START` timer; throws on a timer that is not one. */
export function dayStartRequestOf(timer: Timer, eventAtSim: string, correlationId: string): FireDayStartRequest {
  if (timer.kind !== "DAY_START") throw new RangeError(`timer ${timer.timerId} is ${timer.kind}, not DAY_START`);
  const { installerId, date } = DayStartPayload.parse(timer.payload);
  return { clockId: timer.clockId, installerId, date, eventAtSim, correlationId, timer };
}

const byWindow = (a: WorkOrder, b: WorkOrder): number => Date.parse(a.appointmentWindow.startSim) - Date.parse(b.appointmentWindow.startSim);

async function skip(deps: DayStartDeps, request: FireDayStartRequest, ispId: string | undefined, reason: DayStartSkipReason): Promise<void> {
  const { timer } = request;
  if (timer !== undefined && (timer.status === "FIRED" || timer.status === "SCHEDULED")) {
    try {
      await deps.connector.timers.setTimerStatus(timer, { status: "SKIPPED", reason, firedAtSim: request.eventAtSim }, timer.version);
    } catch (error) {
      deps.logger.warn("dayplan.skip_not_recorded", { timerId: timer.timerId, error });
    }
  }
  if (ispId === undefined) return;
  try {
    await deps.connector.audit.append({
      ispId,
      clockId: request.clockId,
      atSim: request.eventAtSim,
      decision: "ACTION",
      action: DAY_START_SKIPPED,
      actor: "SYSTEM",
      reason,
      refs: { installerId: request.installerId, ...(timer === undefined ? {} : { timerKey: timerRefKey(timer) }) },
      detail: { date: request.date },
    });
  } catch (error) {
    deps.logger.error("dayplan.audit_failed", { action: DAY_START_SKIPPED, error });
  }
}

/** `plan_day(día + 1)`; a failure here is logged and never undoes the start that already happened. */
async function planNextDay(deps: DayStartDeps, ispId: string, request: FireDayStartRequest): Promise<PlanDayResult | undefined> {
  try {
    return await planDay(deps, { ispId, clockId: request.clockId, date: addCalendarDays(request.date, 1), atSim: request.eventAtSim, actor: "SYSTEM" });
  } catch (error) {
    deps.logger.error("dayplan.next_day_failed", { date: request.date, error });
    return undefined;
  }
}

export async function fireDayStart(deps: DayStartDeps, request: FireDayStartRequest): Promise<FireDayStartOutcome> {
  const installer = await deps.connector.people.getPerson(request.installerId);
  if (installer === undefined || installer.clockId !== request.clockId || installer.role !== "INSTALLER") {
    deps.logger.warn("dayplan.installer_missing", { installerId: request.installerId });
    await skip(deps, request, installer?.clockId === request.clockId ? installer.ispId : undefined, "INSTALLER_NOT_FOUND");
    return { status: "SKIPPED", reason: "INSTALLER_NOT_FOUND", workOrderIds: [] };
  }
  const { ispId } = installer;
  const settings = await deps.connector.isps.getSettings(ispId);
  const timeZone = settings?.timezone ?? MEXICO_CITY_TIME_ZONE;
  const orders = (await installerDayOrders(deps, { ispId, clockId: request.clockId, installerId: installer.personId }, request.date)).filter((order) => PENDING_STATUSES.has(order.status)).sort(byWindow);
  const workOrderIds = orders.map((order) => order.workOrderId);
  const [first] = orders;

  let sent: FireDayStartOutcome;
  if (first === undefined) {
    await skip(deps, request, ispId, "NO_WORK_ORDERS");
    sent = { status: "SKIPPED", reason: "NO_WORK_ORDERS", workOrderIds };
  } else {
    const outcome = await deps.sender.sendDayStart({
      ispId,
      clockId: request.clockId,
      installerId: installer.personId,
      date: request.date,
      eventAtSim: request.eventAtSim,
      correlationId: request.correlationId,
      kind: "DAY_START",
      templateName: "ordenes_del_dia",
      params: [installer.firstName, String(orders.length), windowText(first.appointmentWindow, timeZone)],
      buttons: [{ action: "VIEW_ORDERS", object: { kind: "DAY", id: request.date } }],
      workOrderIds,
      ...(request.timer === undefined ? {} : { timerKey: timerRefKey(request.timer) }),
    });
    sent = { ...outcome, workOrderIds };
  }
  deps.logger.info("dayplan.day_start", { date: request.date, status: sent.status, orders: workOrderIds.length, ...("ruleIds" in sent ? { ruleIds: sent.ruleIds } : {}) });
  const nextDay = await planNextDay(deps, ispId, request);
  return nextDay === undefined ? sent : { ...sent, nextDay };
}
