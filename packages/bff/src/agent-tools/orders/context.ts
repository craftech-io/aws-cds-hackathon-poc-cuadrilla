// What the `orders` target adds to every tool runtime: the network orchestrator's client and the port
// that opens the `NOT_PROVISIONED` case (FL-022), plus the world time of a call. Business time is the
// world's (ADR-0010): the simulated instant of the turn for the Harness, the world clock for a direct
// caller (the console, the worker), both on the operator's wall clock.
import { type CalendarDate, ToolError } from "@cuadrilla/shared";
import type { ActiveOrderRequest } from "../../dayplan/active-order";
import type { Actor } from "../../domain/common";
import { worldClock } from "../../lib/clock";
import type { NetworkClient } from "../../network/client";
import { MEXICO_CITY_TIME_ZONE, localDateOf } from "../../services/business-hours/zoned-time";
import type { ToolContext, ToolRuntime } from "../common/context";
import type { CaseOpened } from "../common/fields";

/** The order and the reading that showed the ONU unprovisioned twice in a row. */
export interface NotProvisionedCaseRequest {
  readonly ispId: string;
  readonly clockId: string;
  readonly installerId: string;
  readonly workOrderId: string;
  readonly atSim: string;
  readonly actor: Actor;
  readonly correlationId: string;
  readonly turnId?: string;
}

/**
 * `open_case(NOT_PROVISIONED)` of cases/ (WP-34): idempotent by order and reason, with the roster in
 * force and the ladder's first rung; returns the case opened (or the one already open).
 */
export interface NotProvisionedCases {
  open(request: NotProvisionedCaseRequest): Promise<CaseOpened>;
}

export interface OrdersRuntime extends ToolRuntime {
  readonly network: NetworkClient;
  /** Absent until cases/ is wired: the second reading is then logged and no case is opened. */
  readonly notProvisionedCases?: NotProvisionedCases;
}

export type OrdersContext = ToolContext<OrdersRuntime>;

export interface WorldTime {
  readonly now: Date;
  readonly timeZone: string;
  /** Local calendar day of `now`. */
  readonly today: CalendarDate;
}

/** "Now" of the call on the operator's wall clock. */
export async function worldTimeOf(ctx: Pick<ToolContext, "scope" | "deps">): Promise<WorldTime> {
  const settings = await ctx.deps.connector.isps.getSettings(ctx.scope.ispId);
  const timeZone = settings?.timezone ?? MEXICO_CITY_TIME_ZONE;
  const now =
    ctx.scope.eventAtSim !== undefined
      ? new Date(ctx.scope.eventAtSim)
      : await worldClock(ctx.scope.clockId, { readClock: (clockId) => ctx.deps.connector.runtime.getClock(clockId), realClock: ctx.deps.realClock }).now();
  return { now, timeZone, today: localDateOf(now, timeZone) };
}

/** The installer of the call: the session's, or the subject a direct caller named. */
export function requireInstallerId(ctx: Pick<ToolContext, "scope">): string {
  const { installerId } = ctx.scope;
  if (installerId === undefined) throw new ToolError("INVALID", "name the installer of the call", "NO_INSTALLER");
  return installerId;
}

/** The request of `set_active_work_order` made on behalf of this call. */
export function activeOrderRequestOf(ctx: Pick<ToolContext, "scope" | "actor">, installerId: string, atSim: string): ActiveOrderRequest {
  const { scope } = ctx;
  const refs = {
    ...(scope.turnId === undefined ? {} : { turnId: scope.turnId }),
    ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
    ...(scope.sourceMessageId === undefined ? {} : { messageId: scope.sourceMessageId }),
  };
  return { ispId: scope.ispId, clockId: scope.clockId, installerId, atSim, actor: ctx.actor, refs };
}
