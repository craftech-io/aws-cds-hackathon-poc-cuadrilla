import { describe, expect, it } from "vitest";
import { applyDispatchEvent } from "./apply-dispatch";
import { acceptDispatchEvent, resolveDispatchOrder } from "./dispatch-events";
import { dispatchEventHandler, workOrderChangedEventId } from "./worker-handlers";
import type { WorkerContext } from "../worker/ports";
import { DispatchEvent as DispatchQueueEvent } from "../worker/events";
import { DEMO, SIM_NOW, TIME_ZONE, cancelled, feedWorld, onBus, queuedBodies, reassigned, rescheduled } from "./testing";

const context = { simNow: SIM_NOW, timeZone: TIME_ZONE };

type World = Awaited<ReturnType<typeof feedWorld>>;

/** FeedEvents then the worker: what lands on the queue, applied as the worker would. */
async function acceptAndApply(world: World, raw: Record<string, unknown>) {
  const accepted = await acceptDispatchEvent(raw, world);
  const event = DispatchQueueEvent.parse(queuedBodies(world.sender).at(-1));
  return { accepted, event, applied: await applyDispatchEvent(event, context, world) };
}

describe("FeedEvents: validate, resolve, deduplicate and queue [FL-014]", () => {
  it("[FL-014] queues DISPATCH_EVENT on the group of the order's installer, with the world busy first", async () => {
    const world = await feedWorld();
    const event = rescheduled();
    expect(await acceptDispatchEvent(onBus(event), world)).toBe("QUEUED");
    expect(world.sender.messages).toEqual([{ body: expect.any(String), groupId: "inst-rogelio", deduplicationId: `dsp-${event.detail.eventId}` }]);
    expect(queuedBodies(world.sender)[0]).toEqual({
      type: "DISPATCH_EVENT",
      eventId: `dsp-${event.detail.eventId}`,
      clockId: DEMO,
      ispId: "isp-demo",
      installerId: "inst-rogelio",
      workOrderId: "wo-24817",
      change: "RESCHEDULED",
      occurredAtSim: event.detail.occurredAtSim,
      detail: event.detail,
    });
    expect((await world.connector.worlds.getInstallerState("inst-rogelio"))?.inFlight).toEqual([`dsp-${event.detail.eventId}`]);
    expect((await world.connector.worlds.getWorldState(DEMO))?.inFlight).toEqual([`dsp-${event.detail.eventId}`]);
  });

  it("[FL-014] ignores a repeated event: one message for the same dispatcher's eventId", async () => {
    const world = await feedWorld();
    const event = cancelled();
    expect(await acceptDispatchEvent(onBus(event), world)).toBe("QUEUED");
    expect(await acceptDispatchEvent(onBus(event), world)).toBe("DUPLICATE");
    expect(world.sender.messages).toHaveLength(1);
  });

  it("[FL-014] gives the claim back when the queue fails, so the redelivery queues it", async () => {
    const world = await feedWorld();
    const event = rescheduled();
    world.sender.failNext();
    await expect(acceptDispatchEvent(onBus(event), world)).rejects.toThrow("SendMessage failed");
    expect((await world.connector.worlds.getInstallerState("inst-rogelio"))?.inFlight ?? []).toEqual([]);
    expect(await acceptDispatchEvent(onBus(event), world)).toBe("QUEUED");
    expect(world.sender.messages).toHaveLength(1);
  });

  it("resolves the order in the operator's own world: the same number of a guest world is another order", async () => {
    const world = await feedWorld();
    expect((await resolveDispatchOrder("isp-guest-07", "24817", world.connector.workOrders))?.workOrderId).toBe("wo-24817-g07");
    expect((await resolveDispatchOrder("isp-demo", "24817", world.connector.workOrders))?.workOrderId).toBe("wo-24817");
    expect(await resolveDispatchOrder("isp-guest-08", "24817", world.connector.workOrders)).toBeUndefined();
    expect(await acceptDispatchEvent(onBus(rescheduled({ ispId: "isp-guest-07" })), world)).toBe("QUEUED");
    expect(queuedBodies(world.sender)[0]).toMatchObject({ clockId: "GUEST#isp-guest-07", installerId: "inst-rogelio-g07", workOrderId: "wo-24817-g07" });
  });

  it("drops an unknown order or an invalid event without queuing nor logging its content", async () => {
    const world = await feedWorld();
    expect(await acceptDispatchEvent(onBus(rescheduled({ workOrderNumber: "24899" })), world)).toBe("UNKNOWN_ORDER");
    const invalid = onBus(rescheduled());
    Object.assign(invalid.detail as object, { newWindow: { start: "2026-10-14T11:00:00-06:00", end: "2026-10-14T09:00:00-06:00" } });
    expect(await acceptDispatchEvent(invalid, world)).toBe("INVALID");
    expect(await acceptDispatchEvent({ source: "mock.dispatch", "detail-type": "WorkOrderLost", id: "x", detail: {} }, world)).toBe("INVALID");
    expect(await acceptDispatchEvent("not an event", world)).toBe("INVALID");
    expect(world.sender.messages).toEqual([]);
    expect(world.lines.join("\n")).not.toContain("2026-10-14T11:00");
  });
});

describe("apply_dispatch_event: rescheduled or cancelled [FL-014]", () => {
  it("[FL-014] a reschedule moves the window and the day, with history, and the order leaves today's active slot", async () => {
    const world = await feedWorld();
    await world.connector.worlds.setActiveWorkOrder("inst-rogelio", DEMO, "wo-24817", SIM_NOW.toISOString());
    const { accepted, applied } = await acceptAndApply(world, onBus(rescheduled()));
    expect(accepted).toBe("QUEUED");
    expect(applied).toMatchObject({ status: "APPLIED", turns: [{ installerId: "inst-rogelio", workOrderId: "wo-24817" }] });
    const order = await world.connector.workOrders.requireWorkOrder("wo-24817");
    expect(order).toMatchObject({ status: "RESCHEDULED", date: "2026-10-14", appointmentWindow: { startSim: "2026-10-14T09:00:00-06:00", endSim: "2026-10-14T11:00:00-06:00" } });
    expect(order.history.at(-1)).toMatchObject({ field: "status", from: "SCHEDULED", to: "RESCHEDULED", actor: "SYSTEM" });
    expect(await world.connector.workOrders.listInstallerDay("inst-rogelio", "2026-10-14")).toEqual([expect.objectContaining({ workOrderId: "wo-24817" })]);
    expect((await world.connector.workOrders.listInstallerDay("inst-rogelio", "2026-10-13")).map((o) => o.workOrderId)).toEqual(["wo-24819"]);
    expect((await world.connector.worlds.getInstallerState("inst-rogelio"))?.activeWorkOrderId).toBeUndefined();
    expect(await world.connector.audit.listByWorkOrder("wo-24817")).toEqual([expect.objectContaining({ decision: "ACTION", action: "DISPATCH_EVENT", reason: "RESCHEDULED" })]);
  });

  it("[FL-014] a cancellation marks the order CANCELLED; a later change of it is ignored and audited", async () => {
    const world = await feedWorld();
    expect((await acceptAndApply(world, onBus(cancelled()))).applied).toMatchObject({ status: "APPLIED", workOrder: { status: "CANCELLED" } });
    expect((await acceptAndApply(world, onBus(rescheduled()))).applied).toEqual({ status: "IGNORED", reason: "DISPATCH_AFTER_CANCEL" });
    expect((await world.connector.workOrders.requireWorkOrder("wo-24817")).date).toBe("2026-10-13");
  });

  it("[FL-014] an event on a CLOSED order has no effect: DISPATCH_AFTER_CLOSE", async () => {
    const world = await feedWorld();
    await world.connector.workOrders.setStatus("wo-24817", "CLOSED", { actor: "SYSTEM", atSim: "2026-10-13T07:30:00-06:00" });
    const { applied } = await acceptAndApply(world, onBus(rescheduled()));
    expect(applied).toEqual({ status: "IGNORED", reason: "DISPATCH_AFTER_CLOSE" });
    expect(await world.connector.workOrders.requireWorkOrder("wo-24817")).toMatchObject({ status: "CLOSED", date: "2026-10-13" });
    expect(await world.connector.audit.listByWorkOrder("wo-24817")).toEqual([expect.objectContaining({ decision: "DENY", reason: "DISPATCH_AFTER_CLOSE" })]);
  });

  it("[FL-014] the same event applied twice (a worker retry) changes nothing the second time", async () => {
    const world = await feedWorld();
    const { event } = await acceptAndApply(world, onBus(rescheduled()));
    expect(await applyDispatchEvent(event, context, world)).toEqual({ status: "IGNORED", reason: "ALREADY_APPLIED" });
    expect((await world.connector.workOrders.requireWorkOrder("wo-24817")).history.filter((entry) => entry.to === "RESCHEDULED")).toHaveLength(1);
  });

  it("[FL-014] ignores a detail that is not the dispatcher's shape of its change, or names another order", async () => {
    const world = await feedWorld();
    const { event } = await acceptAndApply(world, onBus(rescheduled()));
    expect(await applyDispatchEvent({ ...event, change: "REASSIGNED" }, context, world)).toEqual({ status: "IGNORED", reason: "INVALID_DETAIL" });
    expect(await applyDispatchEvent({ ...event, detail: { ...event.detail, workOrderNumber: "24819" } }, context, world)).toEqual({ status: "IGNORED", reason: "UNKNOWN_ORDER" });
  });

  it("[FL-014] a change on another day than today asks for no turn", async () => {
    const world = await feedWorld();
    const { applied } = await acceptAndApply(world, onBus(rescheduled()));
    expect(applied).toMatchObject({ status: "APPLIED" });
    const again = rescheduled({ previousWindow: { start: "2026-10-14T09:00:00-06:00", end: "2026-10-14T11:00:00-06:00" }, newWindow: { start: "2026-10-15T09:00:00-06:00", end: "2026-10-15T11:00:00-06:00" } });
    expect((await acceptAndApply(world, onBus(again))).applied).toMatchObject({ status: "APPLIED", turns: [], workOrder: { date: "2026-10-15" } });
  });
});

describe("apply_dispatch_event: reassigned [FL-015]", () => {
  it("[FL-015] the order changes owner with history, leaves Rogelio's active slot and both installers get a turn", async () => {
    const world = await feedWorld();
    await world.connector.worlds.setActiveWorkOrder("inst-rogelio", DEMO, "wo-24819", SIM_NOW.toISOString());
    const { event, applied } = await acceptAndApply(world, onBus(reassigned()));
    expect(event.installerId).toBe("inst-rogelio");
    expect(applied).toMatchObject({
      status: "APPLIED",
      workOrder: { installerId: "inst-karina", status: "REASSIGNED" },
      turns: [
        { installerId: "inst-rogelio", workOrderId: "wo-24819" },
        { installerId: "inst-karina", workOrderId: "wo-24819" },
      ],
    });
    const order = await world.connector.workOrders.requireWorkOrder("wo-24819");
    expect(order.history.at(-1)).toMatchObject({ field: "status", to: "REASSIGNED", reason: expect.stringContaining("inst-rogelio->inst-karina") });
    expect((await world.connector.workOrders.listInstallerDay("inst-rogelio", "2026-10-13")).map((o) => o.workOrderId)).toEqual(["wo-24817"]);
    expect((await world.connector.workOrders.listInstallerDay("inst-karina", "2026-10-13")).map((o) => o.workOrderId).sort()).toEqual(["wo-24819", "wo-24820"]);
    expect((await world.connector.worlds.getInstallerState("inst-rogelio"))?.activeWorkOrderId).toBeUndefined();
    expect(await applyDispatchEvent(event, context, world)).toEqual({ status: "IGNORED", reason: "ALREADY_APPLIED" });
  });

  it("[FL-015] a retry after the owner was written but before the status still names Rogelio as the previous installer", async () => {
    const world = await feedWorld();
    await acceptDispatchEvent(onBus(reassigned()), world);
    const event = DispatchQueueEvent.parse(queuedBodies(world.sender)[0]);
    await world.connector.workOrders.updateWorkOrder("wo-24819", { installerId: "inst-karina" });
    const applied = await applyDispatchEvent(event, context, world);
    expect(applied).toMatchObject({ status: "APPLIED", turns: [{ installerId: "inst-rogelio" }, { installerId: "inst-karina" }] });
    expect((await world.connector.workOrders.requireWorkOrder("wo-24819")).history.at(-1)?.reason).toContain("inst-rogelio->inst-karina");
  });

  it("[FL-015] a later event of the order goes to the new installer's group", async () => {
    const world = await feedWorld();
    await acceptAndApply(world, onBus(reassigned()));
    expect(await acceptDispatchEvent(onBus(cancelled({ workOrderNumber: "24819" })), world)).toBe("QUEUED");
    expect(world.sender.messages.at(-1)?.groupId).toBe("inst-karina");
  });

  it("[FL-015] keeps another installer's active order untouched", async () => {
    const world = await feedWorld();
    await world.connector.worlds.setActiveWorkOrder("inst-rogelio", DEMO, "wo-24817", SIM_NOW.toISOString());
    await acceptAndApply(world, onBus(reassigned()));
    expect((await world.connector.worlds.getInstallerState("inst-rogelio"))?.activeWorkOrderId).toBe("wo-24817");
  });
});

describe("the worker's handler of DISPATCH_EVENT [FL-014] [FL-015]", () => {
  function workerContext(world: World): WorkerContext {
    return { log: world.logger, sink: world.queue, now: () => new Date("2026-10-13T13:40:00Z"), receiveCount: 1, lambdaDeadlineMs: Date.parse("2026-10-13T13:46:00Z") };
  }
  const worldTime = async (clockId: string) => (clockId === DEMO ? { simNow: SIM_NOW, worldEpoch: 3, timeZone: TIME_ZONE } : undefined);

  it("[FL-015] applies the reassignment and asks for a WORK_ORDER_CHANGED turn on each installer's own group", async () => {
    const world = await feedWorld();
    const event = reassigned();
    await acceptDispatchEvent(onBus(event), world);
    const queued = DispatchQueueEvent.parse(queuedBodies(world.sender)[0]);
    await dispatchEventHandler({ ...world, worldTime }).applyDispatchEvent(queued, workerContext(world));
    expect((await world.connector.workOrders.requireWorkOrder("wo-24819")).installerId).toBe("inst-karina");
    expect(world.sender.messages.slice(1).map((message) => message.groupId)).toEqual(["inst-rogelio", "inst-karina"]);
    expect(queuedBodies(world.sender).slice(1)).toEqual([
      expect.objectContaining({ type: "AGENT_TURN", trigger: "WORK_ORDER_CHANGED", installerId: "inst-rogelio", workOrderId: "wo-24819", eventId: workOrderChangedEventId(queued.eventId, "inst-rogelio") }),
      expect.objectContaining({ type: "AGENT_TURN", trigger: "WORK_ORDER_CHANGED", installerId: "inst-karina", workOrderId: "wo-24819", eventId: workOrderChangedEventId(queued.eventId, "inst-karina") }),
    ]);
  });

  it("[FL-014] asks for no turn when the change is ignored, nor when the world is gone", async () => {
    const world = await feedWorld();
    await world.connector.workOrders.setStatus("wo-24817", "CLOSED", { actor: "SYSTEM", atSim: "2026-10-13T07:30:00-06:00" });
    await acceptDispatchEvent(onBus(rescheduled()), world);
    const queued = DispatchQueueEvent.parse(queuedBodies(world.sender)[0]);
    const handler = dispatchEventHandler({ ...world, worldTime });
    await handler.applyDispatchEvent(queued, workerContext(world));
    await handler.applyDispatchEvent({ ...queued, clockId: "GUEST#isp-guest-07", ispId: "isp-guest-07" }, workerContext(world));
    expect(world.sender.messages).toHaveLength(1);
  });
});
