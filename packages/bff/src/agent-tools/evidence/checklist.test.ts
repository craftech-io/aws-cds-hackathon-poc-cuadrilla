import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP } from "../../connector/testing";
import { setPhoto } from "../../evidence/testing";
import { TURN_ID } from "../common/testing";
import { type EvidenceKit, evidenceKit } from "./testing";

let kit: EvidenceKit;
const failure = (response: { ok: boolean; error?: { code: string; reason?: string } }) => (response.ok ? undefined : [response.error?.code, response.error?.reason]);

beforeEach(async () => {
  kit = await evidenceKit();
});

async function itemStatus(item: string, workOrderId = "wo-24817") {
  return (await kit.memory.connector.workOrders.getChecklistItem(workOrderId, item as never))?.status;
}

async function evidenceDenials() {
  return (await kit.memory.connector.audit.listByDecision(ISP, "DENY")).filter((row) => row.action === "TOOL_DENIED");
}

/** A `get_onu_status` result of the current turn, as `createToolHandler` stores it. */
async function onuReadThisTurn(output: Record<string, unknown>) {
  await kit.memory.connector.runtime.putTurnResult(TURN_ID, "get_onu_status", { ok: true, available: true, ...output });
}

async function passPhoto(photoId: string, item: string): Promise<string> {
  const response = await kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(setPhoto(photoId).bytes), item });
  expect(response).toMatchObject({ ok: true, verdict: "PASS" });
  return response.validationId as string;
}

describe("[FL-035] get_checklist: what is missing, with the rubric to ask for each photo", () => {
  it("lists the five items in the order of §EVI-01 with status, attempts, last reason and the rubric hint", async () => {
    await kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(setPhoto("ph-label-06").bytes), item: "ONU_LABEL_PHOTO" });
    const response = await kit.gateway("get_checklist", {});
    expect(response).toMatchObject({ ok: true, complete: false });
    const items = response.items as Array<Record<string, unknown>>;
    expect(items.map((entry) => entry.item)).toEqual(["ONU_ONLINE", "POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "CUSTOMER_OK"]);
    expect(items[2]).toEqual({ item: "ONU_LABEL_PHOTO", label: "La foto de la etiqueta de la ONU", status: "REJECTED", attempts: 1, lastRejectReason: "GLARE", rubricHint: "La etiqueta completa de la ONU; El serial completo, legible de principio a fin" });
    expect(items[0]).toEqual({ item: "ONU_ONLINE", label: "La ONU en línea con la potencia en rango", status: "PENDING", attempts: 0 });
  });

  it("serves the console for the order it names, inside its operator", async () => {
    const consoleUser = { kind: "CONSOLE", ispId: ISP, clockId: CLOCK, userId: "usr-adriana", role: "SUPERVISOR" };
    const response = await kit.target.invoke("get_checklist", { caller: consoleUser }, { subject: { workOrderId: "wo-24819" } });
    expect(response).toMatchObject({ ok: true, complete: false });
  });
});

describe("[FL-020][FL-021] ONU_ONLINE needs an ONLINE reading in range of the same turn", () => {
  it("[FL-020] passes the item after get_onu_status saw the ONU ONLINE and in range in this turn", async () => {
    await onuReadThisTurn({ operState: "ONLINE", rxPowerDbm: -21.4, inRange: true });
    expect(await kit.gateway("update_checklist", { item: "ONU_ONLINE", status: "PASSED" })).toEqual({ ok: true, item: "ONU_ONLINE", status: "PASSED", complete: false });
    const action = (await kit.memory.connector.audit.listByDecision(ISP, "ACTION")).find((row) => row.action === "CHECKLIST_UPDATED");
    expect(action).toMatchObject({ ruleIds: ["LAM-EVIDENCE"], actor: "AGENT", refs: { workOrderId: "wo-24817", item: "ONU_ONLINE", turnId: TURN_ID }, detail: { from: "PENDING", to: "PASSED" } });
  });

  it("[FL-021] refuses a reading out of range, a reading of another turn and no reading at all", async () => {
    expect(failure(await kit.gateway("update_checklist", { item: "ONU_ONLINE", status: "PASSED" }))).toEqual(["FORBIDDEN", "LAM-EVIDENCE"]);
    await onuReadThisTurn({ operState: "ONLINE", rxPowerDbm: -29.8, inRange: false });
    expect(failure(await kit.gateway("update_checklist", { item: "ONU_ONLINE", status: "PASSED" }))).toEqual(["FORBIDDEN", "LAM-EVIDENCE"]);
    await kit.memory.connector.runtime.putTurnResult("01JB8Z9Q2W3E4R5T6Y7V8X9OLD", "get_onu_status", { ok: true, available: true, operState: "ONLINE", inRange: true });
    expect(failure(await kit.gateway("update_checklist", { item: "ONU_ONLINE", status: "PASSED" }))).toEqual(["FORBIDDEN", "LAM-EVIDENCE"]);
    expect(await itemStatus("ONU_ONLINE")).toBe("PENDING");
    expect((await evidenceDenials()).map((row) => row.ruleIds)).toEqual([["LAM-EVIDENCE"], ["LAM-EVIDENCE"], ["LAM-EVIDENCE"]]);
  });
});

describe("[FL-040] label and rosette valid: with the customer's button, the checklist is complete", () => {
  it("passes each photo item with its PASS validation and reports complete once the five are done", async () => {
    await onuReadThisTurn({ operState: "ONLINE", rxPowerDbm: -21.4, inRange: true });
    await kit.gateway("update_checklist", { item: "ONU_ONLINE", status: "PASSED" });
    for (const [photoId, item] of [["ph-meter-01", "POWER_READING_PHOTO"], ["ph-label-01", "ONU_LABEL_PHOTO"], ["ph-rosette-02", "ROSETTE_PHOTO"]] as const) {
      const validationId = await passPhoto(photoId, item);
      expect(await kit.gateway("update_checklist", { item, status: "PASSED", validationId })).toMatchObject({ ok: true, status: "PASSED", complete: false });
    }
    // CUSTOMER_OK is the installer's button (record_customer_ok), never the agent's.
    await kit.memory.connector.workOrders.updateChecklistItem("wo-24817", "CUSTOMER_OK", { status: "PASSED" }, { actor: "CHANNEL" });
    expect(await kit.gateway("get_checklist", {})).toMatchObject({ complete: true });
    expect(await kit.gateway("update_checklist", { item: "ROSETTE_PHOTO", status: "PASSED", validationId: (await kit.memory.connector.workOrders.getChecklistItem("wo-24817", "ROSETTE_PHOTO"))?.validationId })).toMatchObject({ complete: true });
  });
});

describe("[FL-045] the agent cannot validate evidence on its own", () => {
  it("(a) refuses a photo item without a PASS validation of the same order and item, with the audit", async () => {
    const rejected = await kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(setPhoto("ph-label-04").bytes), item: "ONU_LABEL_PHOTO" });
    const passed = await passPhoto("ph-rosette-01", "ROSETTE_PHOTO");
    const attempts = [
      { item: "ONU_LABEL_PHOTO", status: "PASSED" },
      { item: "ONU_LABEL_PHOTO", status: "PASSED", validationId: rejected.validationId },
      { item: "ONU_LABEL_PHOTO", status: "PASSED", validationId: passed },
      { item: "ONU_LABEL_PHOTO", status: "PASSED", validationId: "val-01J9ZQX0000000000000000000" },
    ];
    for (const args of attempts) expect(failure(await kit.gateway("update_checklist", args))).toEqual(["FORBIDDEN", "LAM-EVIDENCE"]);
    expect(await itemStatus("ONU_LABEL_PHOTO")).toBe("REJECTED");
    expect((await evidenceDenials()).every((row) => row.ruleIds.includes("LAM-EVIDENCE") && row.refs.item === "ONU_LABEL_PHOTO")).toBe(true);
  });

  it("(b) refuses override with any value and CUSTOMER_OK, and (c) never changes an item a person validated", async () => {
    for (const override of [true, false, "yes"]) {
      expect(failure(await kit.gateway("update_checklist", { item: "ROSETTE_PHOTO", status: "PASSED", override }))).toEqual(["INVALID", "LAM-STRICT"]);
    }
    expect((await evidenceDenials()).map((row) => row.ruleIds)).toEqual(new Array(3).fill(["LAM-STRICT", "CED-NO-OVERRIDE"]));
    expect(failure(await kit.gateway("update_checklist", { item: "CUSTOMER_OK", status: "PASSED" }))?.[0]).toBe("INVALID");
    await kit.memory.connector.workOrders.updateChecklistItem("wo-24817", "ROSETTE_PHOTO", { status: "OVERRIDDEN", override: { userId: "usr-adriana", reason: "Foto revisada", atSim: "2026-10-13T10:00:00-06:00" } }, { actor: "USER:usr-adriana" });
    expect(failure(await kit.gateway("update_checklist", { item: "ROSETTE_PHOTO", status: "PENDING" }))).toEqual(["FORBIDDEN", "LAM-EVIDENCE"]);
    expect(await kit.gateway("update_checklist", { item: "ROSETTE_PHOTO", status: "PASSED" })).toMatchObject({ ok: true, status: "OVERRIDDEN" });
    expect(await itemStatus("ROSETTE_PHOTO")).toBe("OVERRIDDEN");
  });

  it("lets the agent put an item back to PENDING, and refuses any change on an order on hold for safety", async () => {
    await onuReadThisTurn({ operState: "ONLINE", inRange: true });
    await kit.gateway("update_checklist", { item: "ONU_ONLINE", status: "PASSED" });
    expect(await kit.gateway("update_checklist", { item: "ONU_ONLINE", status: "PENDING" })).toMatchObject({ ok: true, status: "PENDING" });
    await kit.memory.connector.workOrders.setOnHoldSafety("wo-24817", true, { actor: "SYSTEM" });
    expect(failure(await kit.gateway("update_checklist", { item: "ONU_ONLINE", status: "PASSED" }))).toEqual(["ON_HOLD_SAFETY", "ON_HOLD_SAFETY"]);
  });
});
