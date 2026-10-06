import { beforeEach, describe, expect, it } from "vitest";
import type { ChecklistItem } from "@cuadrilla/shared";
import { CLOCK, ISP } from "../../connector/testing";
import { esMX } from "../../copy/es-MX";
import { type ButtonActionEvent, runButtonAction } from "../../channels/whatsapp/button-actions";
import type { InstallerNotice } from "../../channels/whatsapp/ports";
import { openCase } from "../../cases/open";
import { inbound, mx } from "../../cases/testing";
import type { ToolResponse } from "../common/handler";
import { TURN_ID, gatewayContext } from "../common/testing";
import { caseButtonActions } from "./actions";
import { caseDepsOf } from "./runtime";
import { CERT_SHA, CHANNEL_CALLER, type CasesToolKit, casesToolKit } from "./testing";

const ORDER = "wo-24817";
/** The demo world's clock is paused at 11:50 (cases/testing.ts). */
const WORLD_NOW = mx("2026-10-13 11:50");
let kit: CasesToolKit;

const reason = (response: ToolResponse) => (response.ok ? undefined : [response.error.code, response.error.reason]);

async function checklist(pending: readonly ChecklistItem[] = []): Promise<void> {
  const items: ChecklistItem[] = ["ONU_ONLINE", "POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "CUSTOMER_OK"];
  for (const [index, item] of items.entries()) {
    const photo = item.endsWith("_PHOTO");
    await kit.tools.memory.connector.workOrders.putChecklistItem({
      workOrderId: ORDER,
      clockId: CLOCK,
      item,
      status: pending.includes(item) ? "PENDING" : "PASSED",
      ...(photo && !pending.includes(item) ? { evidenceId: `ev-01J9ZQX000000000000000000${index}` } : {}),
    });
  }
}

async function readOnu(minutesBefore: number, operState: "ONLINE" | "LOS" = "ONLINE"): Promise<void> {
  await kit.tools.memory.connector.workOrders.recordOnuReading(ORDER, {
    operState,
    ...(operState === "ONLINE" ? { rxPowerDbm: -21.4 } : {}),
    inRange: operState === "ONLINE",
    observedAtSim: new Date(Date.parse(WORLD_NOW) - minutesBefore * 60_000).toISOString(),
    source: "AGENT",
  });
}

function button(): Promise<ToolResponse> {
  return kit.cases.invoke("close_installation", { caller: CHANNEL_CALLER, outcome: "INSTALLED" }, { subject: { installerId: "inst-rogelio", workOrderId: ORDER } });
}

async function tapClose(): Promise<{ outcome: string; notices: InstallerNotice[] }> {
  const notices: InstallerNotice[] = [];
  const tap = await inbound(kit.tools.memory, "inst-rogelio", WORLD_NOW, { content: "BUTTON", buttonAction: "CLOSE_INSTALLATION", messageId: "wamid.SIM.close.01" });
  const event: ButtonActionEvent = {
    type: "BUTTON_ACTION",
    action: "CLOSE_INSTALLATION",
    eventId: "evt-button-01",
    clockId: CLOCK,
    ispId: ISP,
    installerId: "inst-rogelio",
    workOrderId: ORDER,
    message: { personId: tap.personId, sentAtSim: tap.sentAtSim, messageId: tap.messageId },
  };
  const deps = caseDepsOf({ deps: kit.runtime, logger: kit.tools.runtime.loggerFor?.("evt-button-01") ?? (undefined as never) });
  const actions = { ...caseButtonActions(deps, kit.cases), recordCustomerOk: async () => undefined };
  const outcome = await runButtonAction(event, { connector: kit.tools.memory.connector, actions, notices: { send: async (notice) => void notices.push(notice) } });
  return { outcome, notices };
}

beforeEach(async () => {
  kit = await casesToolKit();
});

describe("[FL-047] closing with the evidence complete", () => {
  it("from the button with no recent reading: reads the ONU as the channel, records it and issues the certificate", async () => {
    await checklist();
    const response = await button();
    expect(response).toEqual({
      ok: true,
      status: "CLOSED",
      certificateId: "cert-wo-24817-1",
      sha256: CERT_SHA,
      deliveries: [
        { to: "CUSTOMER", channel: "EMAIL", status: "QUEUED" },
        { to: "OPS_MAILBOX", channel: "EMAIL", status: "QUEUED" },
        { to: "INSTALLER", channel: "WHATSAPP", status: "QUEUED" },
      ],
    });
    expect(kit.network.reads).toEqual([{ serial: "DEMO3F2C19A0", caller: "CHANNEL" }]);
    const order = await kit.tools.memory.connector.workOrders.requireWorkOrder(ORDER);
    expect(order.status).toBe("CLOSED");
    expect(order.lastOnuReading).toMatchObject({ operState: "ONLINE", rxPowerDbm: -21.4, inRange: true, source: "CLOSE", observedAtSim: WORLD_NOW });
    expect(kit.certificates).toEqual([expect.objectContaining({ workOrderId: ORDER, closedBy: "CHANNEL", closedAtSim: WORLD_NOW })]);
    expect((await kit.tools.memory.connector.audit.listByWorkOrder(ORDER)).map((row) => row.action)).toContain("INSTALLATION_CLOSED");
  });

  it("does not read the ONU again with a reading of the last 30 simulated minutes", async () => {
    await checklist();
    await readOnu(20);
    expect((await button()).ok).toBe(true);
    expect(kit.network.reads).toEqual([]);
  });

  it("from the agent's turn: the certificate is issued as HARNESS", async () => {
    await checklist();
    await readOnu(5);
    const sessionToken = await kit.tools.openSession({ eventAtSim: WORLD_NOW });
    const response = await kit.cases.handler({ sessionToken, outcome: "INSTALLED" }, gatewayContext("cases___close_installation"));
    expect(response.ok).toBe(true);
    expect(kit.certificates[0]).toMatchObject({ closedBy: "HARNESS", turnId: TURN_ID });
  });

  it("refuses force with any value (CED-NO-FORCE-CLOSE)", async () => {
    await checklist(["ROSETTE_PHOTO"]);
    const sessionToken = await kit.tools.openSession();
    expect(reason(await kit.cases.handler({ sessionToken, outcome: "INSTALLED", force: true }, gatewayContext("cases___close_installation")))).toEqual(["INVALID", "LAM-STRICT"]);
    expect(kit.certificates).toEqual([]);
  });
});

describe("[FL-050] closing without the evidence complete is denied", () => {
  it("an own reading that is not ONLINE in range leaves ONU_ONLINE missing", async () => {
    await checklist();
    kit.network.answer = { kind: "OK", operState: "LOS" };
    const response = await button();
    expect(response).toEqual({ ok: false, error: { code: "NOT_COMPLETE", message: "missing: ONU_ONLINE", reason: "CHECKLIST_INCOMPLETE" }, missing: ["ONU_ONLINE"] });
    expect((await kit.tools.memory.connector.workOrders.requireWorkOrder(ORDER)).status).toBe("IN_PROGRESS");
    expect(kit.certificates).toEqual([]);
  });

  it("(a) the button with the rosette pending: one closeNotComplete notice from copy/, no turn", async () => {
    await checklist(["ROSETTE_PHOTO"]);
    await readOnu(10);
    const { outcome, notices } = await tapClose();
    expect(outcome).toBe("CLOSE_NOT_COMPLETE");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ notice: "closeNotComplete", text: esMX.closeNotComplete(["ROSETTE_PHOTO"]), refs: { items: ["ROSETTE_PHOTO"], workOrderId: ORDER } });
    expect(await kit.tools.memory.connector.conversations.listTurnNotes("inst-rogelio")).toEqual([]);
    expect(await kit.tools.memory.connector.runtime.listTurnResults(TURN_ID)).toEqual([]);
    expect(kit.certificates).toEqual([]);
  });

  it("(b) from the agent's turn: NOT_COMPLETE with missing, and no fixed notice (the agent tells)", async () => {
    await checklist(["ROSETTE_PHOTO"]);
    await readOnu(10);
    const sessionToken = await kit.tools.openSession({ eventAtSim: WORLD_NOW });
    const response = await kit.cases.handler({ sessionToken, outcome: "INSTALLED" }, gatewayContext("cases___close_installation"));
    expect(response.ok ? [] : [response.error.code, response.missing]).toEqual(["NOT_COMPLETE", ["ROSETTE_PHOTO"]]);
    expect(kit.outbound.sent).toEqual([]);
  });

  it("keeps an order with an open safety case on hold", async () => {
    await checklist();
    await readOnu(5);
    await openCase(caseDepsOf({ deps: kit.runtime, logger: kit.tools.runtime.loggerFor?.("x") ?? (undefined as never) }), { workOrderId: ORDER, reason: "SAFETY", hazardCategory: "POLE", summary: "Poste inclinado.", atSim: WORLD_NOW, actor: "SYSTEM" });
    const response = await button();
    expect(reason(response)).toEqual(["NOT_COMPLETE", "ON_HOLD_SAFETY"]);
    expect(kit.certificates).toEqual([]);
  });

  it("answers the button's tap with the certificate when complete", async () => {
    await checklist();
    await readOnu(5);
    const { outcome, notices } = await tapClose();
    expect(outcome).toBe("INSTALLATION_CLOSED");
    expect(notices).toEqual([]);
  });
});

describe("[FL-052] a failed visit, without certificate", () => {
  it("records the failed visit and its reason, issues nothing and leaves the dispatch event in the audit log", async () => {
    const sessionToken = await kit.tools.openSession({ eventAtSim: WORLD_NOW });
    const response = await kit.cases.handler({ sessionToken, outcome: "FAILED_VISIT", failedReason: "CUSTOMER_ABSENT" }, gatewayContext("cases___close_installation"));
    expect(response).toEqual({ ok: true, status: "FAILED_VISIT", deliveries: [] });
    const order = await kit.tools.memory.connector.workOrders.requireWorkOrder(ORDER);
    expect(order).toMatchObject({ status: "FAILED_VISIT", failedReason: "CUSTOMER_ABSENT", closedAtSim: WORLD_NOW });
    expect(kit.certificates).toEqual([]);
    const audit = (await kit.tools.memory.connector.audit.listByWorkOrder(ORDER)).find((row) => row.action === "VISIT_FAILED");
    expect(audit?.detail).toEqual({ failedReason: "CUSTOMER_ABSENT", notifyDispatch: true });
  });

  it("needs the reason of a failed visit, and takes none with INSTALLED", async () => {
    const sessionToken = await kit.tools.openSession();
    expect(reason(await kit.cases.handler({ sessionToken, outcome: "FAILED_VISIT" }, gatewayContext("cases___close_installation")))).toEqual(["INVALID", "FAILED_REASON_REQUIRED"]);
    expect(reason(await kit.cases.handler({ sessionToken, outcome: "INSTALLED", failedReason: "OTHER" }, gatewayContext("cases___close_installation")))).toEqual(["INVALID", "VALIDATION"]);
  });
});
