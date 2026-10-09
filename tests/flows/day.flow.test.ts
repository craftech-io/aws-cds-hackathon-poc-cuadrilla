// Area B · Start of the day and work orders (docs/flows-catalog.md FL-009 to FL-016), in process: the
// world clock firing `TIMER#DAY_START`, `fire_day_start` through the outbound pipeline and its policy,
// the order choice, the dispatcher's events through `FeedEvents` and the worker, and the agent's
// `ORDERS_REQUESTED` and `WORK_ORDER_CHANGED` turns through the scripted Harness.
import { describe, expect, it } from "vitest";
import type { DispatchCommand } from "@cuadrilla/dispatch-mock";
import { buttonsOf, payloadOf } from "../../packages/bff/src/routers/simulator-views";
import { READ_ORDER, outputOf, reply } from "./support/agent";
import { createFlowWorld, type FlowWorld } from "./support/world";

const DAY_START_UTC = "2026-10-13T13:30:00.000Z";

function reschedule(workOrderNumber: string, idempotencyKey: string, newWindow: { start: string; end: string }, occurredAtSim = "2026-10-13T09:30:00-06:00"): DispatchCommand {
  return { action: "reschedule", workOrderNumber, request: { ispId: "isp-demo", reason: "CUSTOMER_REQUEST", occurredAtSim, idempotencyKey, newWindow } };
}

async function rogelioOn(world: FlowWorld, workOrderId: string, time: string): Promise<void> {
  await world.at(time);
  await world.data.worlds.setActiveWorkOrder("inst-rogelio", world.clockId, workOrderId, await world.simNow());
}

describe("day flows", () => {
  it("[FL-009] at 07:30 every active installer's day start fires: the template with grounded parameters, a skip without orders and the next day planned", async () => {
    const world = await createFlowWorld();
    const moved = await world.at("07:30");
    expect(moved.fired.filter((fired) => fired.kind === "DAY_START")).toHaveLength(7);
    const [template] = await world.delivered("inst-rogelio", "DAY_START");
    expect(template).toMatchObject({ templateName: "ordenes_del_dia", content: "TEMPLATE" });
    expect(template?.templateParams).toEqual(["Rogelio", "3", "09:00 a 11:00"]);
    expect(buttonsOf(template === undefined ? undefined : payloadOf(template)).map((button) => button.title)).toEqual(["Ver órdenes"]);
    expect(await world.outbound("inst-lorena")).toEqual([]);
    const skipped = (await world.decisions()).filter((decision) => decision.action === "DAY_START_SKIPPED");
    expect(skipped.map((decision) => [decision.refs.personId ?? decision.refs.installerId, decision.reason])).toEqual([["inst-lorena", "NO_WORK_ORDERS"]]);
    const upto = "2026-10-14T14:00:00.000Z";
    const next = [...(await world.data.timers.listDueTimers(world.clockId, upto)), ...(await world.data.timers.listDuePersonTimers("isp-demo", upto))].filter((timer) => timer.kind === "DAY_START" && timer.status === "SCHEDULED");
    expect(next.map((timer) => timer.timerId).sort()).toEqual(["ernesto", "julian", "karina", "lorena", "rogelio", "tomas", "beatriz"].sort().map((name) => `day-start-2026-10-14-inst-${name}`).sort());
    const lorena = (await world.data.timers.listTimers({ kind: "PERSON", id: "inst-lorena" })).find((timer) => timer.dueAtSim === DAY_START_UTC);
    expect(lorena?.status).toBe("SKIPPED");
    const rogelio = (await world.data.timers.listTimers({ kind: "WORK_ORDER", id: "wo-24817" })).find((timer) => timer.kind === "DAY_START");
    expect(rogelio?.status).toBe("FIRED");
  });

  it("[FL-010] the 'Ver órdenes' button opens the window and the agent sends the detail of the day's three orders", async () => {
    const world = await createFlowWorld();
    await world.at("07:30");
    await world.tap("inst-rogelio", "VIEW_ORDERS");
    expect(world.harness.turns.map((turn) => turn.envelope.event.type)).toEqual(["ORDERS_REQUESTED"]);
    const [detail] = await world.delivered("inst-rogelio", "ORDERS_DETAIL");
    expect(detail?.refs?.workOrderIds).toEqual(["wo-24817", "wo-24818", "wo-24819"]);
    for (const fragment of ["24817", "Las Lomitas", "Fibra 300", "24818", "24819"]) expect(detail?.text).toContain(fragment);
    const turn = world.harness.turns[0];
    const read = turn?.calls.find((call) => call.tool === "get_work_orders")?.output as unknown as { workOrders: Array<{ workOrderNumber: string; windowText: string }> };
    expect(read.workOrders.map((order) => order.workOrderNumber)).toEqual(["24817", "24818", "24819"]);
    for (const order of read.workOrders) expect(detail?.text).toContain(order.windowText);
  });

  it("[FL-011] the day start of an installer without opt-in and of one who opted out is denied before rendering", async () => {
    const world = await createFlowWorld();
    await world.at("07:30");
    for (const [personId, rule] of [
      ["inst-julian", "CP-OPTIN"],
      ["inst-ernesto", "CP-OPTOUT"],
    ] as const) {
      expect(await world.delivered(personId)).toEqual([]);
      const denied = await world.outbound(personId, "DAY_START");
      expect(denied.map((message) => [message.status, message.policy?.ruleIds, message.text])).toEqual([["DENIED", [rule], undefined]]);
    }
    const audited = (await world.decisions()).filter((decision) => decision.decision === "DENY" && decision.action === "SEND_WHATSAPP").map((decision) => decision.ruleIds[0]);
    expect(audited).toEqual(expect.arrayContaining(["CP-OPTIN", "CP-OPTOUT"]));
  });

  it("[FL-013] with several pending orders and none active the installer chooses in a list, and the chosen order answers the original message", async () => {
    const world = await createFlowWorld();
    await world.at("09:20");
    await world.text("inst-rogelio", "La ONU no enciende");
    expect(world.harness.turns).toHaveLength(0);
    const [choice] = await world.delivered("inst-rogelio", "ORDER_CHOICE");
    expect(choice?.refs?.workOrderIds).toEqual(["wo-24817", "wo-24818", "wo-24819"]);
    await world.tap("inst-rogelio", { title: "24818" });
    expect((await world.data.worlds.getInstallerState("inst-rogelio"))?.activeWorkOrderId).toBe("wo-24818");
    expect(world.harness.turns).toHaveLength(1);
    expect(world.harness.turns[0]?.envelope.event.workOrder).toBe("24818");
    expect(world.harness.turns[0]?.envelope.inbound).toBe("La ONU no enciende");
  });

  it("[FL-013] with a single pending order it becomes active without asking", async () => {
    const world = await createFlowWorld();
    await world.at("08:00");
    await world.text("inst-julian", "ALTA");
    await world.text("inst-julian", "Ya voy para la orden");
    expect(await world.outbound("inst-julian", "ORDER_CHOICE")).toEqual([]);
    expect((await world.data.worlds.getInstallerState("inst-julian"))?.activeWorkOrderId).toBe("wo-24840");
    expect(world.harness.turns.map((turn) => turn.envelope.event.workOrder)).toEqual(["24840"]);
  });

  it("[FL-014] a rescheduling of the dispatcher updates the order, tells the installer within the window, ignores a repeat and is counted by the next day start", async () => {
    const world = await createFlowWorld();
    await rogelioOn(world, "wo-24817", "09:30");
    // The rescheduled order left the session's day: the agent reads tomorrow's orders to tell the new window.
    world.plan({
      steps: [
        { tool: "get_work_orders", input: { day: "TOMORROW" } },
        reply((context) => {
          const moved = (outputOf(context, "get_work_orders").workOrders as Array<{ workOrderNumber: string; windowText: string }>).find((order) => order.workOrderNumber === "24818");
          return `Tu orden ${moved?.workOrderNumber ?? ""} se movió a mañana, ${moved?.windowText ?? ""}.`;
        }),
      ],
    });
    const tomorrow = { start: "2026-10-14T11:30:00-06:00", end: "2026-10-14T13:30:00-06:00" };
    await world.dispatch.run(reschedule("24818", "qa-fl014-1", tomorrow));
    await world.settle();
    const order = await world.data.workOrders.getWorkOrder("wo-24818");
    expect(order?.status).toBe("RESCHEDULED");
    expect(Date.parse(order?.appointmentWindow.startSim ?? "")).toBe(Date.parse("2026-10-14T17:30:00.000Z"));
    expect(order?.history.at(-1)).toMatchObject({ field: "status", to: "RESCHEDULED" });
    expect(world.harness.turns.map((turn) => [turn.envelope.event.type, turn.envelope.event.workOrder])).toEqual([["WORK_ORDER_CHANGED", "24818"]]);
    expect((await world.delivered("inst-rogelio", "REPLY")).at(-1)?.text).toContain("24818");
    await world.dispatch.run(reschedule("24818", "qa-fl014-1", tomorrow));
    await world.settle();
    expect(world.dispatch.accepted).toEqual(["QUEUED", "DUPLICATE"]);
    expect(world.harness.turns).toHaveLength(1);
    await world.advance({ to: "2026-10-14T13:30:00.000Z" });
    const [nextDay] = await world.delivered("inst-rogelio", "DAY_START").then((all) => all.filter((message) => message.sentAtSim >= "2026-10-14"));
    expect(nextDay?.templateParams?.[1]).toBe(String((await world.data.workOrders.listInstallerDay("inst-rogelio", "2026-10-14")).length));
    expect((await world.data.workOrders.listInstallerDay("inst-rogelio", "2026-10-14")).map((wo) => wo.workOrderId)).toContain("wo-24818");
  });

  it("[FL-014] a cancellation updates the order; a dispatcher's event on a closed order is refused as DISPATCH_AFTER_CLOSE", async () => {
    const world = await createFlowWorld();
    await rogelioOn(world, "wo-24817", "09:30");
    await world.dispatch.run({ action: "cancel", workOrderNumber: "24819", request: { ispId: "isp-demo", reason: "CUSTOMER_REQUEST", occurredAtSim: "2026-10-13T09:30:00-06:00", idempotencyKey: "qa-fl014-cancel" } });
    await world.settle();
    expect((await world.data.workOrders.getWorkOrder("wo-24819"))?.status).toBe("CANCELLED");
    await world.data.workOrders.setStatus("wo-24818", "CLOSED", { actor: "QA", atSim: await world.simNow() });
    await world.dispatch.run(reschedule("24818", "qa-fl014-closed", { start: "2026-10-14T11:30:00-06:00", end: "2026-10-14T13:30:00-06:00" }));
    await world.settle();
    expect((await world.data.workOrders.getWorkOrder("wo-24818"))?.status).toBe("CLOSED");
    expect((await world.decisions()).some((decision) => decision.action === "DISPATCH_AFTER_CLOSE" || decision.reason === "DISPATCH_AFTER_CLOSE")).toBe(true);
  });

  it("[FL-015] a reassignment moves the order to the other installer, both are told and the previous one no longer reaches it", async () => {
    const world = await createFlowWorld();
    await rogelioOn(world, "wo-24819", "09:30");
    await world.data.worlds.setActiveWorkOrder("inst-karina", world.clockId, "wo-24820", await world.simNow());
    world.plan(
      { steps: [READ_ORDER, reply("Te reasignaron una orden; revisa tus órdenes del día.")] },
      { steps: [READ_ORDER, reply("Te reasignaron una orden; revisa tus órdenes del día.")] },
    );
    await world.dispatch.run({ action: "reassign", workOrderNumber: "24819", request: { ispId: "isp-demo", reason: "WORKLOAD_BALANCE", occurredAtSim: "2026-10-13T09:30:00-06:00", idempotencyKey: "qa-fl015", newInstallerId: "inst-karina" } });
    await world.settle();
    const order = await world.data.workOrders.getWorkOrder("wo-24819");
    expect(order?.installerId).toBe("inst-karina");
    expect(order?.history.at(-1)).toMatchObject({ field: "status", to: "REASSIGNED" });
    expect(order?.history.at(-1)?.reason).toContain("inst-rogelio->inst-karina");
    expect((await world.data.worlds.getInstallerState("inst-rogelio"))?.activeWorkOrderId ?? null).toBeNull();
    expect((await world.data.workOrders.listInstallerDay("inst-karina", "2026-10-13")).map((wo) => wo.workOrderId)).toContain("wo-24819");
    expect((await world.data.workOrders.listInstallerDay("inst-rogelio", "2026-10-13")).map((wo) => wo.workOrderId)).not.toContain("wo-24819");
    expect(world.harness.turns.map((turn) => turn.envelope.event.type)).toEqual(["WORK_ORDER_CHANGED", "WORK_ORDER_CHANGED"]);
    expect(await world.delivered("inst-rogelio", "REPLY")).toHaveLength(1);
    expect(await world.delivered("inst-karina", "REPLY")).toHaveLength(1);
    await world.data.worlds.setActiveWorkOrder("inst-rogelio", world.clockId, "wo-24817", await world.simNow());
    world.plan({ steps: [{ tool: "get_work_order", input: { workOrderNumber: "24819" } }, reply("Esa orden ya no está en tu día.")] });
    await world.text("inst-rogelio", "¿Cómo va la 24819?");
    const read = world.harness.turns.at(-1)?.calls[0]?.output;
    expect(read?.ok).toBe(false);
    expect(JSON.stringify(read)).not.toContain("Pineda");
  });

  it("[FL-016] with ordenes_del_dia not approved the day start is denied, and ÓRDENES opens the window and brings the detail", async () => {
    const world = await createFlowWorld();
    await world.data.isps.setTemplateStatus("isp-demo", "ordenes_del_dia", "REJECTED", { actor: "QA", atSim: await world.simNow() });
    await world.at("07:30");
    expect(await world.delivered("inst-rogelio", "DAY_START")).toEqual([]);
    expect((await world.outbound("inst-rogelio", "DAY_START")).map((message) => message.policy?.ruleIds)).toEqual([["CP-TEMPLATE-APPROVED"]]);
    await world.text("inst-rogelio", "ÓRDENES");
    expect(world.harness.turns.map((turn) => turn.envelope.event.type)).toEqual(["ORDERS_REQUESTED"]);
    expect(await world.delivered("inst-rogelio", "ORDERS_DETAIL")).toHaveLength(1);
  });
});
