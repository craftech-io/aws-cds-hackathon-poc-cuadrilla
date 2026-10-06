import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnuStatus } from "@cuadrilla/network-contract";
import { CASE_1, CLOCK, ISP, workOrder } from "../../connector/testing";
import { seedOperator } from "../../dayplan/testing";
import type { NetworkClient, NetworkOutcome, WorldCall } from "../../network/client";
import { createToolHandler } from "../common/handler";
import { TURN_ID, type ToolTestKit, gatewayContext, seedDay, toolTestKit } from "../common/testing";
import type { NotProvisionedCaseRequest, OrdersRuntime } from "./context";
import { ORDERS_IMPLEMENTATIONS } from "./handler";
import { CLASS_ACCEPTANCE_RANGES, acceptanceRangeOf, acceptanceRangeText, readingInRange } from "./range";
import { tipsOf } from "./tips";

const SERIAL = "DEMO3F2C19A0";
const consoleUser = { kind: "CONSOLE", ispId: ISP, clockId: CLOCK, userId: "usr-adriana", role: "SUPERVISOR" };
const worker = { kind: "WORKER", ispId: ISP, clockId: CLOCK, eventId: "evt-0001" };

let kit: ToolTestKit;
let onu: (call: WorldCall) => NetworkOutcome<OnuStatus>;
let reads: WorldCall[];
let opened: NotProvisionedCaseRequest[];

function status(overrides: Partial<OnuStatus> = {}): NetworkOutcome<OnuStatus> {
  return { kind: "OK", attempts: 1, value: { serial: SERIAL, adminState: "ENABLED", operState: "ONLINE", rxPowerDbm: -21.4, txPowerDbm: 2.1, oltPort: "OLT-N3/1/4", observedAt: "2026-10-13T09:21:00-06:00", ...overrides } };
}

const network: NetworkClient = {
  getOnuStatus: async (call) => {
    reads.push(call);
    return onu(call);
  },
  reportPhysicalAction: vi.fn(),
  setBehaviour: vi.fn(),
  health: vi.fn(),
};

function target(withCases = true) {
  const runtime = (): OrdersRuntime => ({
    ...kit.runtime,
    network,
    ...(withCases ? { notProvisionedCases: { open: async (request) => (opened.push(request), { caseId: CASE_1, reason: "NOT_PROVISIONED" as const }) } } : {}),
  });
  return createToolHandler({ target: "orders", deps: runtime, tools: ORDERS_IMPLEMENTATIONS });
}

async function gateway(tool: string, args: Record<string, unknown> = {}, session: Parameters<ToolTestKit["openSession"]>[0] = {}) {
  const token = await kit.openSession(session);
  return target().handler({ sessionToken: token, ...args }, gatewayContext(`orders___${tool}`));
}

beforeEach(async () => {
  kit = toolTestKit();
  reads = [];
  opened = [];
  onu = () => status({ operState: "LOS", rxPowerDbm: undefined, txPowerDbm: undefined });
  await seedOperator(kit.memory.connector);
  await seedDay(kit);
});

describe("[FL-010] get_work_orders: the installer's day, from the stored orders", () => {
  it("[FL-010] lists the installer's orders of the simulated day with the texts to copy, and keeps the result for the turn", async () => {
    const { connector } = kit.memory;
    await connector.workOrders.updateWorkOrder("wo-24818", { appointmentWindow: { startSim: "2026-10-13T11:30:00-06:00", endSim: "2026-10-13T13:30:00-06:00" } });
    await connector.worlds.setActiveWorkOrder("inst-rogelio", CLOCK, "wo-24817", "2026-10-13T09:20:00-06:00");
    await connector.cases.createCase({ caseId: CASE_1, ispId: ISP, clockId: CLOCK, workOrderId: "wo-24818", installerId: "inst-rogelio", kind: "ESCALATION", reason: "DIAGNOSIS_ATTEMPTS", status: "OPEN", rung: "PRIMARY", rungVersion: 0, roster: {}, summary: "Potencia fuera de rango.", createdAtSim: "2026-10-13T08:00:00-06:00" });

    const response = await gateway("get_work_orders");
    expect(response).toMatchObject({
      ok: true,
      installerFirstName: "Rogelio",
      dayText: "hoy martes 13/10",
      nowSimText: "martes 13/10 09:20",
      workOrders: [
        { workOrderNumber: "24817", status: "SCHEDULED", customerFirstName: "Lucía", addressLine: "Calle Jacaranda 214", neighborhood: "Las Lomitas", plan: "Fibra 300", windowText: "09:00 a 11:00", isActive: true, openCase: false },
        { workOrderNumber: "24818", customerFirstName: "Elena", neighborhood: "Arboledas", windowText: "11:30 a 13:30", isActive: false, openCase: true },
      ],
    });
    const stored = await connector.runtime.listTurnResults(TURN_ID, "get_work_orders");
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]?.output)).toContain("24818");
  });

  it("[FL-010] lists tomorrow's orders when asked, with the day in words", async () => {
    const response = await gateway("get_work_orders", { day: "TOMORROW" });
    expect(response).toMatchObject({ ok: true, dayText: "mañana miércoles 14/10", workOrders: [{ workOrderNumber: "24820", windowText: "09:00 a 11:00" }] });
  });

  it("[FL-025] recentWorkOrders: the installer's last ten, open first, then the latest closed, without customer data", async () => {
    const { connector } = kit.memory;
    for (const [n, hour] of [[24801, "09"], [24802, "12"]] as const) {
      await connector.workOrders.createWorkOrder(
        workOrder({ workOrderId: `wo-${n}`, workOrderNumber: String(n), customerId: "cust-10425", date: "2026-10-12", status: "CLOSED", closedAtSim: `2026-10-12T${hour}:30:00-06:00`, appointmentWindow: { startSim: `2026-10-12T${hour}:00:00-06:00`, endSim: `2026-10-12T${hour}:59:00-06:00` } }),
      );
    }
    const response = await gateway("get_work_orders");
    expect(response.ok && response.recentWorkOrders).toEqual([
      { workOrderNumber: "24817", status: "SCHEDULED", dayText: "hoy martes 13/10", open: true },
      { workOrderNumber: "24818", status: "SCHEDULED", dayText: "hoy martes 13/10", open: true },
      { workOrderNumber: "24820", status: "SCHEDULED", dayText: "mañana miércoles 14/10", open: true },
      { workOrderNumber: "24802", status: "CLOSED", dayText: "ayer lunes 12/10", open: false },
      { workOrderNumber: "24801", status: "CLOSED", dayText: "ayer lunes 12/10", open: false },
    ]);
  });

  it("[FL-025] never returns another installer's orders, a phone or an email", async () => {
    const response = await gateway("get_work_orders");
    const text = JSON.stringify(response);
    expect(text).not.toContain("24819");
    expect(text).not.toContain("Jorge");
    expect(text).not.toMatch(/@|\+52|cust-|inst-/);
  });

  it("[FL-010] serves the console for the installer it names, read-only", async () => {
    const response = await target().invoke("get_work_orders", { caller: consoleUser }, { subject: { installerId: "inst-rogelio" } });
    expect(response).toMatchObject({ ok: true, workOrders: [{ workOrderNumber: "24817" }, { workOrderNumber: "24818" }] });
    expect(await target().invoke("get_work_orders", { caller: consoleUser })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "NO_INSTALLER" } });
  });
});

describe("[FL-025] LAM-SCOPE on get_work_order: only the session installer's orders of the day", () => {
  it("[FL-025] refuses another installer's order and an unknown number the same way, with AuditLog DENY", async () => {
    const foreign = await gateway("get_work_order", { workOrderNumber: "24819" });
    const unknown = await gateway("get_work_order", { workOrderNumber: "99999" });
    expect(foreign).toEqual(unknown);
    expect(foreign).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const denials = await kit.memory.connector.audit.listByDecision(ISP, "DENY");
    expect(denials.map((row) => row.ruleIds)).toEqual([["LAM-SCOPE"], ["LAM-SCOPE"]]);
    expect(JSON.stringify(foreign)).not.toContain("Jorge");
  });

  it("[FL-025] does not reach an order of the installer on another day", async () => {
    expect(await gateway("get_work_order", { workOrderNumber: "24820" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});

describe("get_work_order: one order in detail", () => {
  it("returns the active order with its range by class, checklist, open case, steps and the profile's tips", async () => {
    const { connector } = kit.memory;
    await connector.workOrders.appendStep({ workOrderId: "wo-24817", clockId: CLOCK, symptom: "NO_PON_LIGHT", stepRef: "DIAG-02-a", outcome: "PENDING", recordedAtSim: "2026-10-13T09:15:00-06:00" });
    await connector.people.putProfile({
      installerId: "inst-rogelio",
      clockId: CLOCK,
      rejects: { GLARE: 3, BLURRY: 1 },
      events: [
        { kind: "REJECT", code: "GLARE", atSim: "2026-10-12T09:48:00-06:00" },
        { kind: "REJECT", code: "GLARE", atSim: "2026-10-12T09:52:00-06:00" },
        { kind: "REJECT", code: "GLARE", atSim: "2026-08-01T09:00:00-06:00" },
        { kind: "REJECT", code: "BLURRY", atSim: "2026-10-12T15:37:00-06:00" },
      ],
    });
    const response = await gateway("get_work_order");
    expect(response).toMatchObject({
      ok: true,
      workOrder: { workOrderNumber: "24817", onuSerial: SERIAL, oltPort: "OLT-N3/1/4", opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8, text: "de −8 a −25 dBm (clase B+)" }, onHoldSafety: false },
      troubleshooting: [{ symptom: "NO_PON_LIGHT", stepRef: "DIAG-02-a", outcome: "PENDING" }],
      facts: { tips: [{ tipId: "tip-GLARE", reason: "GLARE", count30d: 2 }] },
    });
    expect(response.ok && (response.checklist as Array<{ item: string }>).map((entry) => entry.item)).toEqual(["ONU_ONLINE", "POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "CUSTOMER_OK"]);
    expect(response.ok && response.openCase).toBeUndefined();
  });

  it("makes another pending order of the day active when the agent names it, audited", async () => {
    const response = await gateway("get_work_order", { workOrderNumber: "24818" });
    expect(response).toMatchObject({ ok: true, workOrder: { workOrderNumber: "24818" } });
    expect((await kit.memory.connector.worlds.getInstallerState("inst-rogelio"))?.activeWorkOrderId).toBe("wo-24818");
    const actions = await kit.memory.connector.audit.listByWorkOrder("wo-24818");
    expect(actions.map((row) => [row.decision, row.action, row.actor])).toEqual([["ACTION", "ACTIVE_WORK_ORDER_SET", "AGENT"]]);
  });

  it("reads an order for the console without changing the installer's active order", async () => {
    const response = await target().invoke("get_work_order", { caller: consoleUser }, { subject: { workOrderId: "wo-24818" } });
    expect(response).toMatchObject({ ok: true, workOrder: { workOrderNumber: "24818" } });
    expect(await kit.memory.connector.worlds.getInstallerState("inst-rogelio")).toBeUndefined();
  });

  it("is NOT_FOUND without an active order", async () => {
    const token = await kit.openSession({ workOrderId: undefined });
    expect(await target().handler({ sessionToken: token }, gatewayContext("orders___get_work_order"))).toMatchObject({ ok: false, error: { code: "NOT_FOUND", reason: "NO_ACTIVE_WORK_ORDER" } });
  });
});

describe("[FL-019] get_onu_status: the ONU of the session's order, from the orchestrator", () => {
  it("[FL-019] reads the order's serial in the session's world, keeps the reading and the turn result", async () => {
    const response = await gateway("get_onu_status");
    expect(response).toEqual({ ok: true, available: true, operState: "LOS", inRange: false, acceptanceRangeText: "de −8 a −25 dBm (clase B+)", oltPort: "OLT-N3/1/4", observedAtText: "hoy 09:21" });
    expect(reads).toEqual([expect.objectContaining({ clockId: CLOCK, serial: SERIAL, caller: "HARNESS" })]);
    const order = await kit.memory.connector.workOrders.getWorkOrder("wo-24817");
    expect(order?.lastOnuReading).toMatchObject({ operState: "LOS", inRange: false, source: "AGENT" });
    const stored = await kit.memory.connector.runtime.listTurnResults(TURN_ID, "get_onu_status");
    expect(stored[0]?.output).toMatchObject({ operState: "LOS" });
  });

  it("[FL-019] refuses a serial written by the model without asking the orchestrator", async () => {
    const response = await gateway("get_onu_status", { serial: "DEMO00000001" });
    expect(response).toMatchObject({ ok: false, error: { code: "INVALID", reason: "LAM-STRICT" } });
    expect(reads).toEqual([]);
  });

  it("[FL-019] reads for the worker and the console as themselves", async () => {
    await target().invoke("get_onu_status", { caller: worker }, { subject: { workOrderId: "wo-24817" } });
    await target().invoke("get_onu_status", { caller: consoleUser }, { subject: { workOrderId: "wo-24817" } });
    expect(reads.map((call) => call.caller)).toEqual(["WORKER", "CONSOLE"]);
    expect((await kit.memory.connector.workOrders.getWorkOrder("wo-24817"))?.lastOnuReading?.source).toBe("CONSOLE");
  });

  it("answers available: false, never an error, when the orchestrator cannot answer", async () => {
    onu = () => ({ kind: "UNAVAILABLE", reason: "HTTP_5XX", attempts: 3 });
    expect(await gateway("get_onu_status")).toEqual({ ok: true, available: false });
    onu = () => ({ kind: "NOT_FOUND", attempts: 1 });
    expect(await gateway("get_onu_status")).toEqual({ ok: true, available: false });
  });
});

describe("[FL-021] inRange by class, computed by code", () => {
  it("[FL-021] −29,8 dBm is ONLINE but out of the B+ range; −21,4 dBm is in range", async () => {
    onu = () => status({ rxPowerDbm: -29.8 });
    expect(await gateway("get_onu_status")).toMatchObject({ ok: true, operState: "ONLINE", rxPowerDbm: -29.8, inRange: false });
    onu = () => status({ rxPowerDbm: -21.4 });
    expect(await gateway("get_onu_status")).toMatchObject({ ok: true, operState: "ONLINE", rxPowerDbm: -21.4, inRange: true });
  });

  it("[FL-021] the same value can close in C+ and not in B+, and a reading over −8 dBm never closes", () => {
    const cPlus = acceptanceRangeOf({ opticalClass: "C+" }, { opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8 } });
    expect(cPlus).toEqual(CLASS_ACCEPTANCE_RANGES["C+"]);
    expect(readingInRange("ONLINE", -26.1, cPlus)).toBe(true);
    expect(readingInRange("ONLINE", -26.1, acceptanceRangeOf({ opticalClass: "B+" }))).toBe(false);
    expect(readingInRange("ONLINE", -7, cPlus)).toBe(false);
    expect(readingInRange("LOS", -20, cPlus)).toBe(false);
    expect(acceptanceRangeText(cPlus, "C+")).toBe("de −8 a −28 dBm (clase C+)");
  });

  it("[FL-021] an order of class C+ in a B+ zone is measured with the C+ range", async () => {
    await kit.memory.connector.workOrders.updateWorkOrder("wo-24817", { opticalClass: "C+" });
    onu = () => status({ rxPowerDbm: -26.1 });
    expect(await gateway("get_onu_status")).toMatchObject({ ok: true, inRange: true, acceptanceRangeText: "de −8 a −28 dBm (clase C+)" });
  });
});

describe("[FL-022] ONU without power or not provisioned", () => {
  it("[FL-022] DYING_GASP is reported as it is, with no case", async () => {
    onu = () => status({ operState: "DYING_GASP", rxPowerDbm: undefined });
    expect(await gateway("get_onu_status")).toMatchObject({ ok: true, operState: "DYING_GASP", inRange: false });
    expect(opened).toEqual([]);
  });

  it("[FL-022] the second NOT_PROVISIONED reading in a row opens the NOT_PROVISIONED case by code, once per reading pair", async () => {
    onu = () => status({ operState: "NOT_PROVISIONED", rxPowerDbm: undefined });
    const first = await gateway("get_onu_status");
    expect(first).toMatchObject({ ok: true, operState: "NOT_PROVISIONED" });
    expect(first.ok && first.caseOpened).toBeUndefined();
    expect(await gateway("get_onu_status")).toMatchObject({ ok: true, caseOpened: { caseId: CASE_1, reason: "NOT_PROVISIONED" } });
    expect(opened).toEqual([expect.objectContaining({ workOrderId: "wo-24817", installerId: "inst-rogelio", actor: "AGENT", turnId: TURN_ID })]);
  });

  it("[FL-022] a console reading never escalates, and without the case port the reading is still answered", async () => {
    onu = () => status({ operState: "NOT_PROVISIONED", rxPowerDbm: undefined });
    await target().invoke("get_onu_status", { caller: consoleUser }, { subject: { workOrderId: "wo-24817" } });
    await target().invoke("get_onu_status", { caller: consoleUser }, { subject: { workOrderId: "wo-24817" } });
    expect(opened).toEqual([]);
    const token = await kit.openSession();
    const response = await target(false).handler({ sessionToken: token }, gatewayContext("orders___get_onu_status"));
    expect(response).toMatchObject({ ok: true, operState: "NOT_PROVISIONED" });
    expect(response.ok && response.caseOpened).toBeUndefined();
  });
});

describe("profile tips", () => {
  it("counts rejections of the last 30 simulated days, two or more of a reason", () => {
    const at = "2026-10-13T09:20:00-06:00";
    expect(tipsOf(undefined, at)).toEqual([]);
    const tips = tipsOf({ events: [{ kind: "REJECT", code: "GLARE", atSim: "2026-10-12T09:48:00-06:00" }, { kind: "REJECT", code: "GLARE", atSim: "2026-10-12T09:52:00-06:00" }, { kind: "STEP", code: "LOW_POWER", atSim: "2026-10-12T10:00:00-06:00" }] }, at);
    expect(tips).toEqual([{ tipId: "tip-GLARE", reason: "GLARE", count30d: 2, text: expect.stringContaining("apaga el flash") }]);
    expect(tipsOf({ events: [{ kind: "REJECT", code: "GLARE", atSim: "2026-10-14T09:00:00-06:00" }, { kind: "REJECT", code: "GLARE", atSim: "2026-10-14T09:01:00-06:00" }] }, at)).toEqual([]);
  });
});
