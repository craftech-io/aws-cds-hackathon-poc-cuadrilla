import { describe, expect, it } from "vitest";
import { DispatchOrderItem, createDispatchApi, memoryDispatchStore, recordingPublisher } from "@cuadrilla/dispatch-mock";
import type { OnuControlState } from "@cuadrilla/network-contract";
import { ToolError } from "@cuadrilla/shared";
import type { BehaviourCall, NetworkOutcome } from "../../network/client";
import type { HttpTransport } from "../../network/sigv4";
import { DEMO, GUEST_07, QA, type ServiceWorld, serviceWorld } from "../people/testing";
import { dispatchControl, setOnuBehaviour, setTemplateStatus } from "./controls";
import { createDispatchControlClient } from "./dispatch-client";

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

describe("set_template_status: simulated template state of a world", () => {
  it("records the state with a dated history and ACTION DEMO_CONTROL; the same state writes nothing", async () => {
    const world = await serviceWorld(GUEST_07);
    expect(await setTemplateStatus(world.deps, world.console(), { name: "caso_escalado", status: "REJECTED" })).toEqual({ changed: true, name: "caso_escalado", status: "REJECTED" });
    const settings = await world.deps.connector.isps.getSettings(world.ispId);
    expect(settings?.templateStatus.caso_escalado).toBe("REJECTED");
    expect(settings?.history.at(-1)).toMatchObject({ field: "templateStatus.caso_escalado", to: "REJECTED", actor: "USER:usr-guest-07", atSim: "2026-10-13T09:20:00-06:00" });
    expect(await setTemplateStatus(world.deps, world.console(), { name: "caso_escalado", status: "REJECTED" })).toMatchObject({ changed: false });
    expect(await setTemplateStatus(world.deps, world.console(), { name: "ordenes_del_dia", status: "APPROVED" })).toMatchObject({ changed: false });
    expect((await world.decisions()).filter((row) => row.action === "DEMO_CONTROL")).toMatchObject([{ detail: { control: "TEMPLATE_STATUS", name: "caso_escalado", status: "REJECTED" } }]);
  });

  it("never in the live world; OPS may use the demo controls; the channel may not", async () => {
    const world = await serviceWorld(DEMO);
    expect(await setTemplateStatus(world.deps, world.console("OPS", "usr-ops"), { name: "caso_escalado", status: "PENDING" })).toMatchObject({ changed: true });
    expect(await refusal(setTemplateStatus(world.deps, world.channel(), { name: "caso_escalado", status: "PENDING" }))).toMatchObject({ code: "FORBIDDEN" });
    await world.deps.connector.isps.updateSettings(world.ispId, { whatsappMode: "live" });
    expect(await refusal(setTemplateStatus(world.deps, world.console(), { name: "caso_escalado", status: "APPROVED" }))).toMatchObject({ code: "FORBIDDEN", reason: "LIVE_WORLD" });
  });
});

function fakeNetwork(answer: NetworkOutcome<OnuControlState>) {
  const calls: BehaviourCall[] = [];
  return { calls, network: { setBehaviour: async (call: BehaviourCall) => (calls.push(call), answer) } };
}

const STATE: OnuControlState = { serial: "DEMO3F2C19A0", behaviour: "LOW_POWER_THEN_OK", fixed: true, fixedBy: "DEMO_CONTROL", status: { serial: "DEMO3F2C19A0", operState: "ONLINE", rxPowerDbm: -22.1, txPowerDbm: 2.1, profile: "FTTH-300", observedAt: "2026-10-13T09:20:00-06:00" } } as unknown as OnuControlState;

describe("set_onu_behaviour: the ONU of an order in the simulated network", () => {
  it("sends the change for the order's serial, in the world, as CONSOLE at the world's now, and audits it", async () => {
    const world = await serviceWorld(DEMO);
    const { calls, network } = fakeNetwork({ kind: "OK", value: STATE, attempts: 1 });
    const state = await setOnuBehaviour({ ...world.deps, network }, world.console(), { workOrderId: world.ids.order, fixed: true });
    expect(state).toBe(STATE);
    expect(calls).toMatchObject([{ clockId: world.clockId, serial: "DEMO3F2C19A0", caller: "CONSOLE", atSim: "2026-10-13T09:20:00-06:00", change: { fixed: true } }]);
    expect((await world.decisions()).filter((row) => row.action === "DEMO_CONTROL")).toMatchObject([{ refs: { workOrderId: world.ids.order }, detail: { control: "ONU_BEHAVIOUR", fixed: true } }]);
  });

  it("refuses an empty change, an order of another world, and maps the network's outcomes", async () => {
    const demo = await serviceWorld(DEMO);
    const guest = await serviceWorld(GUEST_07, demo);
    const ok = fakeNetwork({ kind: "OK", value: STATE, attempts: 1 });
    expect(await refusal(setOnuBehaviour({ ...demo.deps, network: ok.network }, demo.console(), { workOrderId: demo.ids.order }))).toMatchObject({ reason: "NOTHING_TO_CHANGE" });
    expect(await refusal(setOnuBehaviour({ ...guest.deps, network: ok.network }, guest.console(), { workOrderId: demo.ids.order, fixed: true }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(setOnuBehaviour({ ...demo.deps, network: ok.network }, demo.console(), { workOrderId: demo.ids.order, serial: "DEMO00000000", fixed: true }))).toMatchObject({ code: "INVALID" });
    expect(ok.calls).toEqual([]);
    const missing = fakeNetwork({ kind: "NOT_FOUND", attempts: 1 });
    expect(await refusal(setOnuBehaviour({ ...demo.deps, network: missing.network }, demo.console(), { workOrderId: demo.ids.order, behaviour: "ONLINE_OK" }))).toMatchObject({ code: "NOT_FOUND" });
    const down = fakeNetwork({ kind: "UNAVAILABLE", reason: "TIMEOUT", attempts: 3 });
    expect(await refusal(setOnuBehaviour({ ...demo.deps, network: down.network }, demo.console(), { workOrderId: demo.ids.order, behaviour: "ONLINE_OK" }))).toMatchObject({ code: "UNAVAILABLE", reason: "TIMEOUT" });
    expect((await demo.decisions()).some((row) => row.action === "DEMO_CONTROL")).toBe(false);
  });

  it("QA calls the network as QA", async () => {
    const world = await serviceWorld(QA);
    const { calls, network } = fakeNetwork({ kind: "OK", value: STATE, attempts: 1 });
    await setOnuBehaviour({ ...world.deps, network }, world.qa(), { workOrderId: world.ids.order, behaviour: "LOS_THEN_ONLINE" });
    expect(calls).toMatchObject([{ caller: "QA", clockId: world.clockId }]);
  });
});

/** The dispatch mock's own router behind the client, with the world's order 24817 in its store. */
function dispatchFor(world: ServiceWorld) {
  const store = memoryDispatchStore([
    DispatchOrderItem.parse({
      PK: `DWO#${world.ispId}#24817`,
      SK: "META",
      entity: "DispatchOrder",
      ispId: world.ispId,
      workOrderNumber: "24817",
      workOrderId: world.ids.order,
      installerId: world.ids.rogelio,
      appointmentWindow: { start: "2026-10-13T09:00:00-06:00", end: "2026-10-13T11:00:00-06:00" },
      status: "SCHEDULED",
      createdAt: "2026-10-12T12:00:00.000Z",
      updatedAt: "2026-10-12T12:00:00.000Z",
      version: 1,
      clockId: world.clockId,
      synthetic: true,
    }),
  ]);
  const publisher = recordingPublisher();
  const api = createDispatchApi({ store, publisher, now: () => new Date("2026-11-02T18:00:00.000Z") });
  const transport: HttpTransport = async (request) => {
    const response = await api.handle({ method: request.method, path: request.path, query: {}, ...(request.body === undefined ? {} : { body: request.body }), requestId: "req-1" });
    return { status: response.statusCode, headers: response.headers, body: response.body };
  };
  return { publisher, dispatch: createDispatchControlClient({ transport, sleep: async () => undefined }) };
}

describe("dispatch_control: reschedule, reassign and cancel through the dispatch mock", () => {
  it("reschedules the world's order: the mock publishes the event, the control is audited with its event id", async () => {
    const world = await serviceWorld(DEMO);
    const { publisher, dispatch } = dispatchFor(world);
    const newWindow = { start: "2026-10-14T09:00:00-06:00", end: "2026-10-14T11:00:00-06:00" };
    const result = await dispatchControl({ ...world.deps, dispatch }, { ...world.console(), eventId: "click-1" }, { action: "reschedule", workOrderId: world.ids.order, reason: "CUSTOMER_REQUEST", newWindow });
    expect(result).toMatchObject({ action: "reschedule", replayed: false, dispatchStatus: "RESCHEDULED" });
    expect(publisher.published).toMatchObject([{ type: "WorkOrderRescheduled", detail: { ispId: world.ispId, workOrderNumber: "24817", newWindow, occurredAtSim: "2026-10-13T09:20:00-06:00" } }]);
    const again = await dispatchControl({ ...world.deps, dispatch }, { ...world.console(), eventId: "click-1" }, { action: "reschedule", workOrderId: world.ids.order, reason: "CUSTOMER_REQUEST", newWindow });
    expect(again).toMatchObject({ eventId: result.eventId, replayed: true });
    expect((await world.decisions()).filter((row) => row.action === "DEMO_CONTROL")[0]).toMatchObject({ detail: { control: "DISPATCH", action: "reschedule", eventId: result.eventId } });
  });

  it("reassigns only to another active installer of the world, and cancels", async () => {
    const world = await serviceWorld(GUEST_07);
    const { publisher, dispatch } = dispatchFor(world);
    const control = (input: Record<string, unknown>) => dispatchControl({ ...world.deps, dispatch }, world.console(), { workOrderId: world.ids.order, reason: "WORKLOAD_BALANCE", ...input });
    expect(await refusal(control({ action: "reassign", newInstallerId: world.ids.rogelio }))).toMatchObject({ reason: "SAME_INSTALLER" });
    expect(await refusal(control({ action: "reassign", newInstallerId: "inst-rogelio" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await control({ action: "reassign", newInstallerId: world.ids.julian })).toMatchObject({ dispatchStatus: "REASSIGNED" });
    expect(await control({ action: "cancel" })).toMatchObject({ dispatchStatus: "CANCELLED" });
    expect(publisher.published.map((event) => event.type)).toEqual(["WorkOrderReassigned", "WorkOrderCancelled"]);
  });

  it("maps the dispatcher's refusals and outages; a closed order never reaches it", async () => {
    const world = await serviceWorld(DEMO);
    const { dispatch } = dispatchFor(world);
    // A cancel then a reschedule: the dispatcher refuses a cancelled order.
    await dispatchControl({ ...world.deps, dispatch }, world.console(), { action: "cancel", workOrderId: world.ids.order, reason: "OTHER" });
    expect(await refusal(dispatchControl({ ...world.deps, dispatch }, world.console(), { action: "reschedule", workOrderId: world.ids.order, reason: "OTHER", newWindow: { start: "2026-10-14T09:00:00-06:00", end: "2026-10-14T11:00:00-06:00" } }))).toMatchObject({ code: "CONFLICT", reason: "ORDER_CANCELLED" });
    let calls = 0;
    const down = createDispatchControlClient({ transport: async () => (calls++, { status: 503, headers: {}, body: "" }), sleep: async () => undefined });
    expect(await refusal(dispatchControl({ ...world.deps, dispatch: down }, world.console(), { action: "cancel", workOrderId: world.ids.order, reason: "OTHER" }))).toMatchObject({ code: "UNAVAILABLE", reason: "HTTP_5XX" });
    expect(calls).toBe(3);
    await world.deps.connector.workOrders.setStatus(world.ids.order, "CLOSED", { actor: "AGENT", atSim: "2026-10-13T10:00:00-06:00" });
    calls = 0;
    expect(await refusal(dispatchControl({ ...world.deps, dispatch: down }, world.console(), { action: "cancel", workOrderId: world.ids.order, reason: "OTHER" }))).toMatchObject({ code: "CONFLICT", reason: "ORDER_NOT_OPEN" });
    expect(calls).toBe(0);
  });
});
