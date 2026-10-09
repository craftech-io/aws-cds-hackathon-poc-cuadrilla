// The worker's dispatch by event type (docs/architecture.md §7). What is the worker's own runs here or
// in its modules; what belongs to another module runs through its port (worker/ports.ts).
//
//   INBOUND_MESSAGE    voice, safety, physical action, bridge, turn          worker/inbound.ts
//   AGENT_TURN         gates and the Harness                                 turns/turn.ts
//   BUTTON_ACTION      the installer's tap on an order, no turn              channels/whatsapp/button-actions.ts
//   SUPERVISOR_ACTION  take, decline, close or relay                          CasePort
//   TIMER              `fire_timer`, then the handler of its `kind`; a timer not yet due is re-armed by the
//                      timer port and dispatches nothing; an old version is ignored and audited
//   DISPATCH_EVENT, EMAIL_EVENT, OUTBOUND_SEND                                EventHandlers
//   CASE_PRESET        the world factory's `case` preset                       CasePort
//   HEALTH_PROBE       `GET /v1/health` of the mocks with the worker's role → `Runtime/PROBE#<probeId>`
//   POISON             fails on purpose until the DLQ (only `qa-*` worlds, FL-099 d)
import type { NetworkClient } from "../network/client";
import { runButtonAction } from "../channels/whatsapp/button-actions";
import { simNowOf } from "../lib/clock";
import type { TurnDeps, TurnOutcome, TurnRequest } from "../turns/deps";
import { inboundOfMessage, supervisorSummary } from "../turns/facts";
import { runAgentTurn } from "../turns/turn";
import { WORKER_ACTIONS, auditOnce, workerAudit } from "./audit";
import type { AgentTurnEvent, HealthProbeEvent, InstallerQueueEvent, TimerEvent } from "./events";
import { handleInboundMessage } from "./inbound";
import type { WorkerContext, WorkerPorts } from "./ports";

export interface DispatchDeps {
  readonly turn: TurnDeps;
  readonly ports: WorkerPorts;
  readonly network: Pick<NetworkClient, "reportPhysicalAction">;
}

/** A poison event that reached the worker: it fails every attempt until the DLQ. */
export class PoisonEventError extends Error {
  override readonly name = "PoisonEventError";
}

/** `AGENT_TURN` from its producers: the order of the event, else of its message, else the installer's active one. */
async function agentTurn(deps: DispatchDeps, ctx: WorkerContext, event: AgentTurnEvent): Promise<TurnOutcome> {
  const { data } = deps.turn;
  const message = event.message === undefined ? undefined : await data.conversations.getMessage(event.message);
  const state = await data.worlds.getInstallerState(event.installerId);
  const workOrderId = event.workOrderId ?? message?.workOrderId ?? state?.activeWorkOrderId;
  let eventAtSim = event.eventAtSim ?? message?.sentAtSim;
  if (eventAtSim === undefined) {
    const clock = await data.runtime.getClock(event.clockId);
    eventAtSim = clock === undefined ? ctx.now().toISOString() : simNowOf(clock, ctx.now().getTime()).toISOString();
  }
  const caseItem = event.trigger === "CASE_CLOSED" && event.caseId !== undefined ? await data.cases.getCase(event.caseId) : undefined;
  const supervisor = caseItem?.installerId === event.installerId ? supervisorSummary(caseItem) : undefined;
  // ÓRDENES and "Ver órdenes" answer the installer's tap: the message is the reply's anchor, not a question.
  const own = message !== undefined && message.direction === "IN" && message.personId === event.installerId ? message : undefined;
  const fromInstaller = own !== undefined && event.trigger === "INSTALLER_MESSAGE" ? inboundOfMessage(own) : undefined;
  const inbound = supervisor ?? fromInstaller?.inbound;
  const block = fromInstaller?.block;
  const request: TurnRequest = {
    trigger: event.trigger,
    eventId: event.eventId,
    clockId: event.clockId,
    ispId: event.ispId,
    installerId: event.installerId,
    eventAtSim,
    ...(workOrderId === undefined ? {} : { workOrderId }),
    ...(own === undefined ? {} : { message: own }),
    ...(inbound === undefined ? {} : { inbound }),
    ...(event.caseId === undefined ? {} : { caseId: event.caseId }),
  };
  return runAgentTurn(deps.turn, ctx, request, block === undefined ? undefined : { kind: block.kind, policy: block.policy, entity: block.entity });
}

/** `fire_timer` and the handler of its kind; a stale or missing timer dispatches nothing. */
async function timer(deps: DispatchDeps, ctx: WorkerContext, event: TimerEvent): Promise<void> {
  const outcome = await deps.ports.timers.fire({ timerKey: event.timerKey, version: event.version, firedBy: event.firedBy, ...(event.firedBy === "CLOCK" ? { eventAtSim: event.dueAtSim } : {}) });
  switch (outcome.status) {
    case "MISSING":
      ctx.log.warn("worker.timer_missing", { timerKey: event.timerKey });
      return;
    case "NOT_DUE":
      ctx.log.info("worker.timer_not_due", { timerKey: event.timerKey, dueAtSim: outcome.timer.dueAtSim });
      return;
    case "STALE":
      await auditOnce(workerAudit(deps.turn.data), {
        action: WORKER_ACTIONS.timerStale,
        eventId: event.eventId,
        ispId: event.ispId,
        clockId: event.clockId,
        atSim: event.dueAtSim,
        refs: { timerKey: event.timerKey },
        reason: outcome.reason,
        detail: { kind: outcome.timer.kind, version: event.version, current: outcome.timer.version },
      });
      return;
    case "FIRED": {
      const fired = { timer: outcome.timer, event, eventAtSim: outcome.eventAtSim };
      const handlers = deps.ports.timerHandlers;
      if (outcome.timer.kind === "DAY_START") return handlers.dayStart(fired, ctx);
      if (outcome.timer.kind === "CASE_TIMEOUT") return handlers.caseTimeout(fired, ctx);
      if (outcome.timer.kind === "DEFERRED_SEND") return handlers.deferredSend(fired, ctx);
      return handlers.certRetry(fired, ctx);
    }
  }
}

/** Each mock's health with the worker's role, in `Runtime/PROBE#<probeId>` (idempotent). */
async function healthProbe(deps: DispatchDeps, ctx: WorkerContext, event: HealthProbeEvent): Promise<void> {
  const results = await Promise.all(deps.ports.probes.map(async (probe) => [probe.name, await probe.health(ctx.log).catch(() => false)] as const));
  await deps.turn.data.worlds.putProbe(event.probeId, { mocks: Object.fromEntries(results.map(([name, healthy]) => [name, healthy ? "OK" : "UNAVAILABLE"])), atReal: ctx.now().toISOString() });
}

export async function dispatchEvent(deps: DispatchDeps, ctx: WorkerContext, event: InstallerQueueEvent): Promise<void> {
  switch (event.type) {
    case "INBOUND_MESSAGE": {
      const outcome = await handleInboundMessage(deps, ctx, event);
      ctx.log.info("worker.inbound", { outcome: outcome.kind, ...(outcome.kind === "TURN" ? { turn: outcome.turn.kind } : {}) });
      return;
    }
    case "AGENT_TURN": {
      const outcome = await agentTurn(deps, ctx, event);
      ctx.log.info("worker.turn", { outcome: outcome.kind, trigger: event.trigger });
      return;
    }
    case "BUTTON_ACTION": {
      const outcome = await runButtonAction(event, { connector: deps.turn.data, actions: deps.ports.buttons.actions, notices: deps.ports.buttons.notices });
      ctx.log.info("worker.button", { action: event.action, outcome });
      return;
    }
    case "SUPERVISOR_ACTION":
      return deps.ports.cases.supervisorAction(event, ctx);
    case "TIMER":
      return timer(deps, ctx, event);
    case "DISPATCH_EVENT":
      return deps.ports.handlers.applyDispatchEvent(event, ctx);
    case "EMAIL_EVENT":
      return deps.ports.handlers.applyEmailEvent(event, ctx);
    case "OUTBOUND_SEND":
      return deps.ports.handlers.outboundSend(event, ctx);
    case "CASE_PRESET":
      return deps.ports.cases.preset(event, ctx);
    case "HEALTH_PROBE":
      return healthProbe(deps, ctx, event);
    case "POISON":
      throw new PoisonEventError("poison event: it fails on purpose until the DLQ");
  }
}
