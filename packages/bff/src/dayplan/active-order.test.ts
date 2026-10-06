import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP, installer, testConnector, workOrder } from "../connector/testing";
import { esMX } from "../copy/es-MX";
import { createLogger } from "../lib/log";
import { type ActiveOrderDeps, type ActiveOrderRequest, ORDER_CHOICE_MAX_ROWS, chooseActiveWorkOrder, resolveActiveWorkOrder } from "./active-order";
import { seedOperator } from "./testing";

let world: ReturnType<typeof testConnector>;
let deps: ActiveOrderDeps;

const window = (start: string, end: string, date = "2026-10-13") => ({ startSim: `${date}T${start}:00-06:00`, endSim: `${date}T${end}:00-06:00` });
const request = (overrides: Partial<ActiveOrderRequest> = {}): ActiveOrderRequest => ({
  ispId: ISP,
  clockId: CLOCK,
  installerId: "inst-rogelio",
  atSim: "2026-10-13T09:20:00-06:00",
  actor: "CHANNEL",
  refs: { messageId: "wamid.SIM.01" },
  ...overrides,
});
const active = async () => (await world.connector.worlds.getInstallerState("inst-rogelio"))?.activeWorkOrderId;
const actions = async () => (await world.connector.audit.listByDecision(ISP, "ACTION")).map((row) => [row.action, row.refs.workOrderId, row.reason, row.actor]);

beforeEach(async () => {
  world = testConnector("2026-11-02T18:00:00.000Z");
  deps = { connector: world.connector, logger: createLogger({ level: "error", sink: () => undefined }) };
  await seedOperator(world.connector);
  await world.connector.people.createPerson(installer());
  await world.connector.people.createPerson(installer({ personId: "inst-karina", firstName: "Karina", phone: "+525501010002", phoneHash: "d".repeat(64) }));
  await world.connector.workOrders.createWorkOrder(workOrder({ appointmentWindow: window("09:00", "11:00") }));
  await world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24819", workOrderNumber: "24819", customerId: "cust-10423", installerId: "inst-karina", appointmentWindow: window("15:00", "17:00") }));
  await world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24820", workOrderNumber: "24820", customerId: "cust-10424", date: "2026-10-14", appointmentWindow: window("09:00", "11:00", "2026-10-14") }));
});

const addSecondOrder = () => world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24818", workOrderNumber: "24818", customerId: "cust-10422", appointmentWindow: window("11:30", "13:30") }));

describe("[FL-013] the active order is decided by code, never by the model", () => {
  it("[FL-013] with a single pending order of the day, it becomes active without asking, audited", async () => {
    const resolution = await resolveActiveWorkOrder(deps, request());
    expect(resolution).toMatchObject({ kind: "ACTIVE", changed: true, workOrder: { workOrderId: "wo-24817" } });
    expect(await active()).toBe("wo-24817");
    expect(await actions()).toEqual([["ACTIVE_WORK_ORDER_SET", "wo-24817", "ONLY_PENDING_ORDER", "CHANNEL"]]);
  });

  it("[FL-013] with several pending orders and none active, it asks with ORDER_CHOICE: one row per order, a nonce object each", async () => {
    await addSecondOrder();
    const resolution = await resolveActiveWorkOrder(deps, request());
    expect(resolution).toEqual({
      kind: "CHOICE",
      choice: {
        kind: "ORDER_CHOICE",
        body: esMX.orderChoicePrompt,
        workOrderIds: ["wo-24817", "wo-24818"],
        rows: [
          { title: "OT 24817", description: "09:00 a 11:00 · Las Lomitas", workOrderId: "wo-24817", action: "CHOOSE_ORDER", object: { kind: "WORK_ORDER", id: "wo-24817" } },
          { title: "OT 24818", description: "11:30 a 13:30 · Arboledas", workOrderId: "wo-24818", action: "CHOOSE_ORDER", object: { kind: "WORK_ORDER", id: "wo-24818" } },
        ],
      },
    });
    expect(await active()).toBeUndefined();
  });

  it("[FL-013] the installer's choice becomes active and the next message keeps it, without another audit row", async () => {
    await addSecondOrder();
    await chooseActiveWorkOrder(deps, { ...request(), workOrderId: "wo-24818" });
    expect(await active()).toBe("wo-24818");
    expect(await resolveActiveWorkOrder(deps, request())).toMatchObject({ kind: "ACTIVE", changed: false, workOrder: { workOrderId: "wo-24818" } });
    expect(await actions()).toEqual([["ACTIVE_WORK_ORDER_SET", "wo-24818", "CHOSEN", "CHANNEL"]]);
  });

  it("[FL-013] a choice outside the installer's pending orders of the day is refused", async () => {
    await expect(chooseActiveWorkOrder(deps, { ...request(), workOrderId: "wo-24819" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(chooseActiveWorkOrder(deps, { ...request(), workOrderId: "wo-24820" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await world.connector.workOrders.setStatus("wo-24817", "CLOSED", { actor: "AGENT", atSim: "2026-10-13T10:05:00-06:00" });
    await expect(chooseActiveWorkOrder(deps, { ...request(), workOrderId: "wo-24817" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await active()).toBeUndefined();
  });

  it("[FL-013] an active order that is no longer pending is cleared and the next pending one takes its place", async () => {
    await addSecondOrder();
    await chooseActiveWorkOrder(deps, { ...request(), workOrderId: "wo-24817" });
    await world.connector.workOrders.setStatus("wo-24817", "CLOSED", { actor: "AGENT", atSim: "2026-10-13T10:05:00-06:00" });
    expect(await resolveActiveWorkOrder(deps, request({ atSim: "2026-10-13T11:40:00-06:00" }))).toMatchObject({ kind: "ACTIVE", changed: true, workOrder: { workOrderId: "wo-24818" } });
    expect((await actions()).map(([action, workOrderId]) => [action, workOrderId])).toEqual([
      ["ACTIVE_WORK_ORDER_SET", "wo-24817"],
      ["ACTIVE_WORK_ORDER_CLEARED", "wo-24817"],
      ["ACTIVE_WORK_ORDER_SET", "wo-24818"],
    ]);
  });

  it("[FL-013] with no pending order the day has no active order", async () => {
    await world.connector.workOrders.setStatus("wo-24817", "CLOSED", { actor: "AGENT", atSim: "2026-10-13T10:05:00-06:00" });
    expect(await resolveActiveWorkOrder(deps, request())).toEqual({ kind: "NONE" });
    expect(await resolveActiveWorkOrder(deps, request({ installerId: "inst-lorena" }))).toEqual({ kind: "NONE" });
  });

  it("[FL-013] the list keeps the ten earliest orders, as WhatsApp lists allow", async () => {
    for (let n = 0; n < 11; n += 1) {
      const hour = String(8 + n).padStart(2, "0");
      const number = `249${String(n).padStart(2, "0")}`;
      await world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: `wo-${number}`, workOrderNumber: number, customerId: "cust-10425", appointmentWindow: window(`${hour}:15`, `${hour}:45`) }));
    }
    const resolution = await resolveActiveWorkOrder(deps, request());
    expect(resolution.kind === "CHOICE" && resolution.choice.rows).toHaveLength(ORDER_CHOICE_MAX_ROWS);
    expect(resolution.kind === "CHOICE" && resolution.choice.rows[0]?.title).toBe("OT 24900");
  });
});
