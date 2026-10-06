// `plan_day` (docs/tool-catalog.md "Handlers de invocación directa", docs/architecture.md §8): one
// `TIMER#DAY_START` at 07:30 of the day for **every active installer of the allow list** of the world,
// with or without orders and with or without opt-in (the firing decides the template, the policy's
// denial or `SKIPPED NO_WORK_ORDERS`). The timer lives on the installer's first order of that day or,
// with no order, on the person (the shape the seed writes, docs/seed-spec.md §3). Planning is idempotent:
// an installer whose day already has its timer, on any of those homes, is left as it is. Called by the
// world factory and by `fire_day_start` for the next day.
import { type CalendarDate, ToolError } from "@cuadrilla/shared";
import type { TimerHome } from "../domain/timers";
import type { WorkOrder } from "../domain/work-orders";
import { MEXICO_CITY_TIME_ZONE, zonedInstant } from "../services/business-hours/zoned-time";
import { installerDayOrders } from "./active-order";
import type { DayPlanDeps } from "./ports";

export const DAY_START_TIME = "07:30";
export const DAY_START_REASON = "Inicio del día";
export const DAY_PLANNED = "DAY_PLANNED";

/** Orders that no longer belong to the installer's day do not hold its timer. */
const GONE: ReadonlySet<WorkOrder["status"]> = new Set<WorkOrder["status"]>(["CANCELLED", "REASSIGNED"]);

/** `day-start-<date>-<installerId>`: one per installer and day (the seed's id). */
export function dayStartTimerId(installerId: string, date: CalendarDate): string {
  return `day-start-${date}-${installerId}`;
}

export interface PlanDayRequest {
  readonly ispId: string;
  readonly clockId: string;
  readonly date: CalendarDate;
  /** Simulated instant of the planning (audit row). */
  readonly atSim: string;
  readonly actor: "SYSTEM" | "WORKER" | "SCHEDULER" | "SEED" | "QA";
}

export interface PlanDayResult {
  readonly date: CalendarDate;
  readonly dueAtSim: string;
  /** Installers whose timer this call created. */
  readonly planned: readonly string[];
  /** Installers whose day already had its timer. */
  readonly existing: readonly string[];
}

async function hasDayStart(deps: DayPlanDeps, homes: readonly TimerHome[], timerId: string): Promise<boolean> {
  const found = await Promise.all(homes.map((home) => deps.connector.timers.getTimer({ home, kind: "DAY_START", timerId })));
  return found.some((timer) => timer !== undefined);
}

export async function planDay(deps: DayPlanDeps, request: PlanDayRequest): Promise<PlanDayResult> {
  const settings = await deps.connector.isps.getSettings(request.ispId);
  if (settings !== undefined && settings.clockId !== request.clockId) throw new ToolError("FORBIDDEN", "the operator belongs to another world", "CROSS_WORLD");
  const dueAtSim = zonedInstant(request.date, DAY_START_TIME, settings?.timezone ?? MEXICO_CITY_TIME_ZONE).toISOString();
  const installers = (await deps.connector.people.listPeople(request.ispId, "INSTALLER")).filter((person) => person.active && person.clockId === request.clockId);
  const planned: string[] = [];
  const existing: string[] = [];
  for (const installer of installers) {
    const orders = (await installerDayOrders(deps, { ispId: request.ispId, clockId: request.clockId, installerId: installer.personId }, request.date)).filter((order) => !GONE.has(order.status));
    const timerId = dayStartTimerId(installer.personId, request.date);
    const personHome: TimerHome = { kind: "PERSON", id: installer.personId };
    const orderHomes: TimerHome[] = orders.map((order) => ({ kind: "WORK_ORDER", id: order.workOrderId }));
    if (await hasDayStart(deps, [personHome, ...orderHomes], timerId)) {
      existing.push(installer.personId);
      continue;
    }
    await deps.timers.arm({
      home: orderHomes[0] ?? personHome,
      kind: "DAY_START",
      timerId,
      clockId: request.clockId,
      dueAtSim,
      reason: DAY_START_REASON,
      payload: { installerId: installer.personId, date: request.date },
    });
    planned.push(installer.personId);
  }
  if (planned.length > 0) {
    try {
      await deps.connector.audit.append({
        ispId: request.ispId,
        clockId: request.clockId,
        atSim: request.atSim,
        decision: "ACTION",
        action: DAY_PLANNED,
        actor: request.actor,
        detail: { date: request.date, dueAtSim, planned: planned.length, existing: existing.length },
      });
    } catch (error) {
      deps.logger.error("dayplan.audit_failed", { action: DAY_PLANNED, error });
    }
  }
  deps.logger.info("dayplan.planned", { date: request.date, planned: planned.length, existing: existing.length });
  return { date: request.date, dueAtSim, planned, existing };
}
