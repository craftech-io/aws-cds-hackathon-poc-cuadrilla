// Actions on a world and its clock (docs/tool-catalog.md "Acciones del QaDriver"): the world factory, the
// quiescence, the real `open_case` through the installer's queue, the clock without the console's
// `WORLD_BUSY` gate, the faults and the kill switch of a `qa-*` world, the two simulated systems, and the
// events that test failures (a forced failed turn, a poisoned event, a stale timer). Every write goes
// through the module that owns it.
import { createHash } from "node:crypto";
import { type CalendarDate, ToolError } from "@cuadrilla/shared";
import { advanceClock, forceCaseTimeout, fireTimerNow } from "../clock/advance";
import { freeze, unfreeze } from "../clock/modes";
import { currentClock, scheduledTimers, viewOf } from "../clock/state";
import { parseTimerRefKey } from "../connector/keys";
import type { Faults } from "../domain/runtime-world";
import { simNowOf } from "../lib/clock";
import { setKillSwitch } from "../ops/kill-switch";
import { FORCED_TURN_FAILURE } from "../turns/invoke";
import type { AppointmentWindow, DispatchReason } from "@cuadrilla/dispatch-mock";
import { MEXICO_CITY_TIME_ZONE, localDateOf, toZonedIso } from "../services/business-hours/zoned-time";
import { keyOfTimer } from "../timers/dispatch";
import { createWorld, destroyWorld } from "../worlds/worlds";
import { qaEventId } from "./contract";
import { buttonOf } from "./channel";
import type { QaParsedInput } from "./contract-inputs";
import type { ActionContext } from "./driver";
import type { QaPorts } from "./ports";
import { settle } from "./settle";
import { type QaSnapshot, takeSnapshot } from "./snapshot";

type H<A extends keyof WorldActionInputs> = (input: WorldActionInputs[A], ctx: ActionContext) => Promise<unknown>;

export interface WorldActionInputs {
  readonly "world.create": unknown;
  readonly "world.destroy": QaParsedInput<"world.destroy">;
  readonly "world.settle": QaParsedInput<"world.settle">;
  readonly "installer.settle": QaParsedInput<"installer.settle">;
  readonly "case.open": QaParsedInput<"case.open">;
  readonly "clock.advance": QaParsedInput<"clock.advance">;
  readonly "clock.advanceTo": QaParsedInput<"clock.advanceTo">;
  readonly "clock.advanceToNext": QaParsedInput<"clock.advanceToNext">;
  readonly "clock.forceCaseTimeout": QaParsedInput<"clock.forceCaseTimeout">;
  readonly "clock.fireTimer": QaParsedInput<"clock.fireTimer">;
  readonly "clock.fireDayStart": QaParsedInput<"clock.fireDayStart">;
  readonly "clock.unfreeze": QaParsedInput<"clock.unfreeze">;
  readonly "clock.freeze": QaParsedInput<"clock.freeze">;
  readonly "network.setBehaviour": QaParsedInput<"network.setBehaviour">;
  readonly "network.fix": QaParsedInput<"network.fix">;
  readonly "network.setFaults": QaParsedInput<"network.setFaults">;
  readonly "knowledge.setFaults": QaParsedInput<"knowledge.setFaults">;
  readonly "transcribe.setFaults": QaParsedInput<"transcribe.setFaults">;
  readonly "validator.setFaults": QaParsedInput<"validator.setFaults">;
  readonly "turn.forceFailure": QaParsedInput<"turn.forceFailure">;
  readonly "kill.set": QaParsedInput<"kill.set">;
  readonly "dispatch.reschedule": QaParsedInput<"dispatch.reschedule">;
  readonly "dispatch.reassign": QaParsedInput<"dispatch.reassign">;
  readonly "dispatch.cancel": QaParsedInput<"dispatch.cancel">;
  readonly "event.poison": QaParsedInput<"event.poison">;
  readonly "schedule.fireStale": QaParsedInput<"schedule.fireStale">;
  readonly "nonce.expire": QaParsedInput<"nonce.expire">;
  readonly snapshot: QaParsedInput<"snapshot">;
}

const QA_CLOCK_CALLER = { actor: "QA" } as const;

async function worldNow(ports: QaPorts, clockId: string, ctx: ActionContext): Promise<{ readonly simNow: string; readonly ispId: string; readonly worldEpoch: number }> {
  const clock = await ports.data.runtime.getClock(clockId);
  if (clock === undefined) throw new ToolError("NOT_FOUND", `the world ${clockId} does not exist`);
  return { simNow: simNowOf(clock, ctx.now().getTime()).toISOString(), ispId: clock.ispId, worldEpoch: clock.worldEpoch };
}

/** `Runtime/FAULTS#<clockId>` with one client's attribute set (or removed with `null`); the rest kept. */
async function setFault(ports: QaPorts, clockId: string, client: "network" | "knowledge" | "transcribe" | "validator" | "turn", mode: string | null): Promise<Faults> {
  const current = await ports.data.worlds.getFaults(clockId);
  const { entity: _entity, createdAt: _createdAt, updatedAt: _updatedAt, version: _version, ...rest } = current ?? { clockId };
  const next: Record<string, unknown> = { ...rest, clockId };
  if (mode === null) delete next[client];
  else next[client] = mode;
  return ports.data.worlds.setFaults(next as Faults);
}

/** The `DAY_START` of an installer at the world's now: its pending timer, or a new one forced now (FL-012). */
async function fireDayStart(ports: QaPorts, personId: string, ctx: ActionContext) {
  const person = await ports.data.people.requirePerson(personId);
  const clock = await currentClock(person.clockId, { data: ports.data, realClock: ports.clock.realClock });
  const simNow = viewOf(clock, await ports.clock.realClock.now()).simNow;
  const pending = (await scheduledTimers(clock, { data: ports.data })).find((timer) => timer.kind === "DAY_START" && timer.payload.installerId === personId);
  if (pending !== undefined) return fireTimerNow({ timerKey: keyOfTimer(pending), caller: QA_CLOCK_CALLER }, ports.clock);
  const timeZone = (await ports.data.isps.getSettings(clock.ispId))?.timezone ?? MEXICO_CITY_TIME_ZONE;
  const date: CalendarDate = localDateOf(simNow, timeZone);
  const timerId = `day-start-qa-${createHash("sha256").update(ctx.idempotencyKey).digest("hex").slice(0, 16)}`;
  const home = { kind: "PERSON", id: personId } as const;
  const existing = await ports.data.timers.getTimer({ home, kind: "DAY_START", timerId });
  const timer = existing ?? (await ports.data.timers.createTimer({ timerId, kind: "DAY_START", home, clockId: clock.clockId, dueAtSim: simNow.toISOString(), status: "SCHEDULED", reason: "Inicio del día (QA)", payload: { installerId: personId, date } }));
  if (timer.status !== "SCHEDULED") return { clockId: clock.clockId, simNow: simNow.toISOString(), fired: [], replayed: true };
  return fireTimerNow({ timerKey: keyOfTimer(timer), caller: QA_CLOCK_CALLER }, ports.clock);
}

/**
 * A change of the external dispatcher (`DispatchMock`), sent as the dispatcher itself would: whatever state the
 * product keeps (an order already `CLOSED` gets its event too, `DISPATCH_AFTER_CLOSE`). The same `platformKey`
 * makes the mock publish the stored event again, with the same id (`FeedEvents` must ignore it).
 */
async function dispatchAction(ports: QaPorts, action: "reschedule" | "reassign" | "cancel", input: { readonly workOrderId: string; readonly reason: DispatchReason; readonly platformKey?: string; readonly newWindow?: AppointmentWindow; readonly newInstallerId?: string }, ctx: ActionContext) {
  const order = await ports.data.workOrders.requireWorkOrder(input.workOrderId);
  const now = await worldNow(ports, order.clockId, ctx);
  const base = { ispId: order.ispId, reason: input.reason, occurredAtSim: toZonedIso(new Date(now.simNow), MEXICO_CITY_TIME_ZONE), idempotencyKey: input.platformKey ?? ctx.idempotencyKey };
  const body = action === "reschedule" && input.newWindow !== undefined ? { ...base, newWindow: input.newWindow } : action === "reassign" && input.newInstallerId !== undefined ? { ...base, newInstallerId: input.newInstallerId } : base;
  const outcome = await ports.dispatch.command(action, order.workOrderNumber, body, ctx.log.correlationId);
  if (outcome.kind === "REFUSED") throw new ToolError(outcome.code, outcome.message, outcome.reason);
  if (outcome.kind === "UNAVAILABLE") throw new ToolError("UNAVAILABLE", "the dispatcher did not answer", outcome.reason);
  return { eventId: outcome.result.eventId, replayed: outcome.result.replayed, dispatchStatus: outcome.result.order.status };
}

export function worldActions(ports: QaPorts) {
  const settleDeps = (ctx: ActionContext) => ({ data: ports.data, now: ctx.now, sleep: ctx.sleep });
  const actions: { readonly [A in keyof WorldActionInputs]: H<A> } = {
    "world.create": (input) => createWorld(ports.worlds, input, "QA"),
    "world.destroy": (input) => destroyWorld(ports.worlds, { clockId: input.clockId, actor: "QA" }),
    "world.settle": (input, ctx) => settle(settleDeps(ctx), { clockId: input.clockId, timeoutSec: input.timeoutSec, holdSec: input.holdSec }),
    async "installer.settle"(input, ctx) {
      const person = await ports.data.people.requirePerson(input.installerId);
      return settle(settleDeps(ctx), { clockId: person.clockId, installerId: input.installerId, timeoutSec: input.timeoutSec, holdSec: input.holdSec });
    },
    async "case.open"(input, ctx) {
      // The QaDriver holds no outbound pipeline: the real `open_case` runs in the installer's worker.
      const order = await ports.data.workOrders.requireWorkOrder(input.workOrderId);
      const now = await worldNow(ports, order.clockId, ctx);
      const eventId = qaEventId(ctx.idempotencyKey);
      await ports.queue.enqueue({ type: "CASE_PRESET", eventId, clockId: order.clockId, ispId: order.ispId, installerId: order.installerId, workOrderId: order.workOrderId, worldEpoch: now.worldEpoch, reason: input.reason, rung: "PRIMARY", status: "OPEN", atSim: now.simNow });
      return { eventId, atSim: now.simNow };
    },
    "clock.advance": (input) => advanceClock({ clockId: input.clockId, target: { byMinutes: input.minutes }, caller: QA_CLOCK_CALLER }, ports.clock),
    "clock.advanceTo": (input) => advanceClock({ clockId: input.clockId, target: { to: input.to }, caller: QA_CLOCK_CALLER }, ports.clock),
    "clock.advanceToNext": (input) => advanceClock({ clockId: input.clockId, target: { next: true }, caller: QA_CLOCK_CALLER }, ports.clock),
    "clock.forceCaseTimeout": (input) => forceCaseTimeout({ caseId: input.caseId, caller: QA_CLOCK_CALLER }, ports.clock),
    "clock.fireTimer": (input) => fireTimerNow({ timerKey: input.timerKey, caller: QA_CLOCK_CALLER }, ports.clock),
    "clock.fireDayStart": (input, ctx) => fireDayStart(ports, input.personId, ctx),
    "clock.unfreeze": (input) => unfreeze({ clockId: input.clockId, ...(input.leadSec === undefined ? {} : { leadSec: input.leadSec }), ...(input.timerKey === undefined ? {} : { timerKey: input.timerKey }) }, ports.clock),
    "clock.freeze": (input) => freeze({ clockId: input.clockId }, ports.clock),
    async "network.setBehaviour"(input, ctx) {
      const order = await ports.data.workOrders.requireWorkOrder(input.workOrderId);
      const now = await worldNow(ports, order.clockId, ctx);
      const change = { ...(input.behaviour === undefined ? {} : { behaviour: input.behaviour }), ...(input.rxPowerDbm === undefined ? {} : { rxPowerDbm: input.rxPowerDbm }), ...(input.fixed === undefined ? {} : { fixed: input.fixed }) };
      return ports.network.setBehaviour({ clockId: order.clockId, serial: order.onuSerial, caller: "QA", atSim: now.simNow, change, logger: ctx.log });
    },
    async "network.fix"(input, ctx) {
      const order = await ports.data.workOrders.requireWorkOrder(input.workOrderId);
      const now = await worldNow(ports, order.clockId, ctx);
      return ports.network.reportPhysicalAction({ clockId: order.clockId, serial: order.onuSerial, caller: "QA", atSim: now.simNow, kind: input.kind, logger: ctx.log });
    },
    "network.setFaults": (input) => setFault(ports, input.clockId, "network", input.mode),
    "knowledge.setFaults": (input) => setFault(ports, input.clockId, "knowledge", input.mode),
    "transcribe.setFaults": (input) => setFault(ports, input.clockId, "transcribe", input.mode),
    "validator.setFaults": (input) => setFault(ports, input.clockId, "validator", input.mode),
    "turn.forceFailure": (input) => setFault(ports, input.clockId, "turn", FORCED_TURN_FAILURE),
    "kill.set": (input) => setKillSwitch(ports.kill, { scope: "AGENT", clockId: input.clockId, on: input.on, actor: "QA", reason: "scenario" }),
    "dispatch.reschedule": (input, ctx) => dispatchAction(ports, "reschedule", input, ctx),
    "dispatch.reassign": (input, ctx) => dispatchAction(ports, "reassign", input, ctx),
    "dispatch.cancel": (input, ctx) => dispatchAction(ports, "cancel", input, ctx),
    async "event.poison"(input, ctx) {
      const person = await ports.data.people.requirePerson(input.installerId);
      const eventId = qaEventId(ctx.idempotencyKey);
      await ports.queue.enqueue({ type: "POISON", eventId, clockId: person.clockId, ispId: person.ispId, installerId: person.personId });
      return { eventId };
    },
    async "schedule.fireStale"(input, ctx) {
      // A late schedule of an older version of the timer (a moved rung, a rescheduled send): the worker's
      // claim finds another version and ignores it (FL-060, FL-064).
      const ref = parseTimerRefKey(input.timerKey);
      const timer = ref === undefined ? undefined : await ports.data.timers.getTimer(ref);
      if (timer === undefined) throw new ToolError("NOT_FOUND", "no such timer");
      const now = await worldNow(ports, timer.clockId, ctx);
      const installerId = await installerOf(ports, timer.home);
      const version = Math.max(1, timer.version - input.staleBy);
      const eventId = qaEventId(ctx.idempotencyKey);
      await ports.queue.enqueue({ type: "TIMER", eventId, clockId: timer.clockId, ispId: now.ispId, installerId, timerKey: input.timerKey, dueAtSim: timer.dueAtSim, version, firedBy: "SCHEDULER" });
      return { eventId, version, current: timer.version };
    },
    async "nonce.expire"(input) {
      const { content } = await buttonOf(ports, input.personId, input.action);
      const nonce = content.type === "button" ? content.payload : "id" in content ? content.id : undefined;
      if (nonce === undefined) throw new ToolError("NOT_FOUND", "no nonce");
      await ports.data.runtime.expireNonce(nonce);
      return { expired: true };
    },
    snapshot: (input, ctx): Promise<QaSnapshot> => takeSnapshot({ data: ports.data, now: ctx.now }, input),
  };
  return actions;
}

async function installerOf(ports: QaPorts, home: { readonly kind: string; readonly id: string }): Promise<string> {
  if (home.kind === "PERSON") return home.id;
  if (home.kind === "WORK_ORDER") return (await ports.data.workOrders.requireWorkOrder(home.id)).installerId;
  return (await ports.data.cases.requireCase(home.id)).installerId;
}
