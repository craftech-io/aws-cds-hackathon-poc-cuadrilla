// `clock` router of the console (docs/tool-catalog.md; FL-084, FL-085, FL-086; ADR-0010): the demo clock
// of the principal's world and the demo controls. Nothing here takes a world from the input: every
// move is of `ctx.world`.
//
//   get                 mode, simulated now (with the world's offset), next timers, whether the world is
//                       busy and what it waits for (`WORLD_BUSY`), when a reset is possible again
//   startDay, advance, advanceTo, advanceToNext, forceCaseTimeout, setRunning
//                       clock/advance.ts and clock/modes.ts, behind the busy gate (`force: true` is
//                       "Avanzar igual", accepted after five minutes of the same wait)
//   setTemplateStatus, setOnuBehaviour, dispatch.reschedule|reassign|cancel
//                       the demo controls (services/demo-controls), behind the same gate
//   jumpToScene         S: "Saltar a escena" (guest worlds; 30 per real hour, outside the reset limit)
//   reset               S: "Reiniciar demo" of this world, once every 10 real minutes for every principal
//                       (the QaDriver's GUEST included); both keep the world's real-time counters
import { z } from "zod";
import { AppointmentWindow, DispatchReason } from "@cuadrilla/dispatch-mock";
import { CaseId, InstallerId, IsoInstant, ToolError, TemplateName, TemplateStatus, WorkOrderId } from "@cuadrilla/shared";
import { type AdvanceDeps, type ClockTarget, advanceClock, forceCaseTimeout } from "../clock/advance";
import { assertWorldQuiet, worldPending } from "../clock/busy";
import { setRunning } from "../clock/modes";
import { type ResetDeps, SceneId, jumpToScene, nextConsoleResetAtReal, resetWorld, sceneJumpLimit } from "../clock/reset";
import { currentClock, scheduledTimers, viewOf } from "../clock/state";
import type { Actor } from "../domain/common";
import { SetOnuBehaviourInput, dispatchControl, setOnuBehaviour, setTemplateStatus } from "../services/demo-controls/controls";
import { MEXICO_CITY_TIME_ZONE, toZonedIso } from "../services/business-hours/zoned-time";
import { type ConsolePorts, actorOf, consoleCall } from "./console-ports";
import { type IspContext, ispProcedure, router, supervisorProcedure } from "./trpc";

const Force = { force: z.boolean().optional() };
const AdvanceInput = z.object({ minutes: z.number().int().positive().max(3 * 24 * 60), ...Force }).strict();
const AdvanceToInput = z.object({ to: IsoInstant, ...Force }).strict();
const GateOnly = z.object(Force).strict().optional();
const ForceTimeoutInput = z.object({ caseId: CaseId, ...Force }).strict();
const RunningInput = z.object({ running: z.boolean() }).strict();
const TemplateInput = z.object({ name: TemplateName, status: TemplateStatus, ...Force }).strict();
const SceneInput = z.object({ sceneId: SceneId }).strict();

type Ctx = Pick<IspContext, "deps" | "world" | "principal" | "log">;

/** The clock module's dependencies over the request's ports. */
export function clockDepsOf(ctx: Ctx, ports: ConsolePorts = consoleCall(ctx).ports): AdvanceDeps & ResetDeps {
  const data = ctx.deps.connector;
  return { data, scheduler: ports.scheduler, dispatcher: ports.dispatcher, realClock: ports.services.realClock, log: ctx.log, client: ports.client, rebuild: ports.rebuild };
}

async function timeZoneOf(ctx: Ctx): Promise<string> {
  return (await ctx.deps.connector.isps.getSettings(ctx.world.ispId))?.timezone ?? MEXICO_CITY_TIME_ZONE;
}

export async function clockView(ctx: Ctx) {
  const deps = clockDepsOf(ctx);
  const clock = await currentClock(ctx.world.clockId, deps);
  const realNow = await deps.realClock.now();
  const view = viewOf(clock, realNow);
  const [timeZone, pending, timers, jumpLimit] = await Promise.all([timeZoneOf(ctx), worldPending(clock, deps), scheduledTimers(clock, deps), sceneJumpLimit(clock.ispId, deps)]);
  return {
    clockId: clock.clockId,
    mode: view.running ? ("RUNNING" as const) : ("PAUSED" as const),
    simNow: toZonedIso(view.simNow, timeZone),
    runningUntilReal: view.running ? (clock.runningUntilReal ?? null) : null,
    worldEpoch: clock.worldEpoch,
    busy: pending.length > 0,
    pending,
    next: timers.slice(0, 10).map((timer) => ({ kind: timer.kind, dueAtSim: toZonedIso(new Date(timer.dueAtSim), timeZone), reason: timer.reason ?? undefined })),
    nextResetAtReal: nextConsoleResetAtReal(clock, realNow) ?? null,
    sceneJumpsPerRealHour: jumpLimit,
  };
}

/** The console's caller of a move: its actor and the busy gate. */
function mover(ctx: Ctx, force: boolean | undefined): { readonly actor: Actor; readonly gate: { readonly force: boolean } } {
  return { actor: actorOf(ctx.principal), gate: { force: force === true } };
}

export async function moveClock(ctx: Ctx, target: ClockTarget, force: boolean | undefined) {
  const moved = await advanceClock({ clockId: ctx.world.clockId, target, caller: mover(ctx, force) }, clockDepsOf(ctx));
  return { ...moved, simNow: toZonedIso(new Date(moved.simNow), await timeZoneOf(ctx)) };
}

/** The busy gate before a demo control (docs/architecture.md §8). */
async function quiet(ctx: Ctx, force: boolean | undefined): Promise<void> {
  const deps = clockDepsOf(ctx);
  await assertWorldQuiet({ clock: await currentClock(ctx.world.clockId, deps), force: force === true, actor: actorOf(ctx.principal) }, deps);
}

async function demoControl<T>(ctx: Ctx, force: boolean | undefined, run: (ports: ConsolePorts, caller: ReturnType<typeof consoleCall>["caller"]) => Promise<T>): Promise<T> {
  await quiet(ctx, force);
  const { ports, caller } = consoleCall(ctx);
  return run(ports, caller);
}

const OnuInput = SetOnuBehaviourInput.extend(Force);

function withoutForce<T extends { readonly force?: boolean | undefined }>(input: T): Omit<T, "force"> {
  const { force: _force, ...rest } = input;
  return rest;
}

const DispatchBase = { workOrderId: WorkOrderId, reason: DispatchReason, ...Force };
const DISPATCH_INPUTS = {
  reschedule: z.object({ ...DispatchBase, newWindow: AppointmentWindow }).strict(),
  reassign: z.object({ ...DispatchBase, newInstallerId: InstallerId }).strict(),
  cancel: z.object(DispatchBase).strict(),
} as const;

function dispatchProcedure<A extends keyof typeof DISPATCH_INPUTS>(action: A) {
  return ispProcedure.input(DISPATCH_INPUTS[action]).mutation(({ ctx, input }) =>
    demoControl(ctx, input.force, (ports, caller) => dispatchControl({ ...ports.services, dispatch: ports.dispatch }, caller, { action, ...withoutForce(input) })),
  );
}

export const clockRouter = router({
  get: ispProcedure.query(({ ctx }) => clockView(ctx)),
  startDay: ispProcedure.input(GateOnly).mutation(({ ctx, input }) => moveClock(ctx, { startDay: true }, input?.force)),
  advance: ispProcedure.input(AdvanceInput).mutation(({ ctx, input }) => moveClock(ctx, { byMinutes: input.minutes }, input.force)),
  advanceTo: ispProcedure.input(AdvanceToInput).mutation(({ ctx, input }) => moveClock(ctx, { to: input.to }, input.force)),
  advanceToNext: ispProcedure.input(GateOnly).mutation(({ ctx, input }) => moveClock(ctx, { next: true }, input?.force)),
  forceCaseTimeout: ispProcedure.input(ForceTimeoutInput).mutation(async ({ ctx, input }) => {
    const caseItem = await ctx.deps.connector.cases.getCase(input.caseId);
    if (caseItem === undefined || caseItem.clockId !== ctx.world.clockId) throw new ToolError("NOT_FOUND", "case not found");
    return forceCaseTimeout({ caseId: input.caseId, caller: mover(ctx, input.force) }, clockDepsOf(ctx));
  }),
  setRunning: ispProcedure.input(RunningInput).mutation(({ ctx, input }) => setRunning({ clockId: ctx.world.clockId, running: input.running, caller: { actor: actorOf(ctx.principal) } }, clockDepsOf(ctx))),
  setTemplateStatus: ispProcedure
    .input(TemplateInput)
    .mutation(({ ctx, input }) => demoControl(ctx, input.force, (ports, caller) => setTemplateStatus(ports.services, caller, { name: input.name, status: input.status }))),
  setOnuBehaviour: ispProcedure
    .input(OnuInput)
    .mutation(({ ctx, input }) => demoControl(ctx, input.force, (ports, caller) => setOnuBehaviour({ ...ports.services, network: ports.network }, caller, withoutForce(input)))),
  dispatch: router({ reschedule: dispatchProcedure("reschedule"), reassign: dispatchProcedure("reassign"), cancel: dispatchProcedure("cancel") }),
  jumpToScene: supervisorProcedure.input(SceneInput).mutation(async ({ ctx, input }) => {
    const jumped = await jumpToScene({ clockId: ctx.world.clockId, sceneId: input.sceneId, actor: actorOf(ctx.principal) }, clockDepsOf(ctx));
    ctx.log.info("clock.scene.jumped", { sceneId: input.sceneId, worldEpoch: jumped.worldEpoch });
    return jumped;
  }),
  reset: supervisorProcedure.mutation(async ({ ctx }) => {
    const reset = await resetWorld({ clockId: ctx.world.clockId, caller: "CONSOLE", actor: actorOf(ctx.principal) }, clockDepsOf(ctx));
    ctx.log.info("clock.world.reset", { worldEpoch: reset.worldEpoch });
    return reset;
  }),
});
