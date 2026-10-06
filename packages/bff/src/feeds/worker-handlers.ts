// `apply_dispatch_event` as the `InstallerWorker` calls it (worker/ports.ts `EventHandlers`): the change
// is applied in the group of the order's installer (feeds/apply-dispatch.ts) at the world's simulated
// "now", and each installer whose current day it touches gets `AGENT_TURN(WORK_ORDER_CHANGED)` on their
// own group through the worker's sink, so the follow-up is in flight before this event leaves it. The
// turn decides what to say; the contact policy decides whether it goes out (`CP-WA-24H`). A world that
// no longer exists drops the event (logged).
import { createHash } from "node:crypto";
import type { WorldTimeReader } from "../channels/whatsapp/ports";
import type { DispatchEvent } from "../worker/events";
import type { EventHandlers, WorkerContext } from "../worker/ports";
import { type ApplyDispatchDeps, type DispatchTurn, applyDispatchEvent } from "./apply-dispatch";

export interface DispatchHandlerDeps extends ApplyDispatchDeps {
  readonly worldTime: WorldTimeReader;
}

/** One turn per installer and dispatcher's event: a redelivery asks for the same turn. */
export function workOrderChangedEventId(eventId: string, installerId: string): string {
  return `woc-${createHash("sha256").update(`${eventId}\n${installerId}`, "utf8").digest("hex").slice(0, 40)}`;
}

async function askForTurn(event: DispatchEvent, turn: DispatchTurn, eventAtSim: string, ctx: WorkerContext): Promise<void> {
  await ctx.sink.enqueue({
    type: "AGENT_TURN",
    eventId: workOrderChangedEventId(event.eventId, turn.installerId),
    clockId: event.clockId,
    ispId: event.ispId,
    installerId: turn.installerId,
    trigger: "WORK_ORDER_CHANGED",
    workOrderId: turn.workOrderId,
    eventAtSim,
    ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
  });
}

export function dispatchEventHandler(deps: DispatchHandlerDeps): Pick<EventHandlers, "applyDispatchEvent"> {
  return {
    async applyDispatchEvent(event, ctx) {
      const world = await deps.worldTime(event.clockId);
      if (world === undefined) {
        ctx.log.warn("dispatch_event.world_gone", { eventId: event.eventId, clockId: event.clockId });
        return;
      }
      const outcome = await applyDispatchEvent(event, { simNow: world.simNow, timeZone: world.timeZone }, deps);
      ctx.log.info("dispatch_event.applied", { eventId: event.eventId, workOrderId: event.workOrderId, change: event.change, status: outcome.status, ...(outcome.status === "IGNORED" ? { reason: outcome.reason } : { turns: outcome.turns.length }) });
      if (outcome.status !== "APPLIED") return;
      for (const turn of outcome.turns) await askForTurn(event, turn, world.simNow.toISOString(), ctx);
    },
  };
}
