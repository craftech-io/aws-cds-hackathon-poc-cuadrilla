import { describe, expect, it } from "vitest";
import { type ChecklistItemStatus, ToolError } from "@cuadrilla/shared";
import { InstallerQueueEvent } from "../../worker/events";
import { DEMO, GUEST_07, QA, type ServiceWorld, serviceWorld } from "../people/testing";
import { overrideEvidence } from "./override";

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

async function itemIs(world: ServiceWorld, item: "POWER_READING_PHOTO" | "ONU_LABEL_PHOTO" | "ROSETTE_PHOTO", status: ChecklistItemStatus): Promise<void> {
  await world.deps.connector.workOrders.updateChecklistItem(world.ids.order, item, { status, ...(status === "REJECTED" ? { addAttempts: 1, lastRejectReason: "BLURRY" } : {}) }, { actor: "AGENT", atSim: "2026-10-13T09:10:00-06:00" });
}

const deps = (world: ServiceWorld) => ({ ...world.deps, queue: world.queue });

describe("override_evidence: manual validation in the console [FL-044]", () => {
  it("[FL-044] a supervisor validates a rejected photo by hand: OVERRIDDEN with who, why and when, audited, and the agent is told", async () => {
    const world = await serviceWorld(DEMO);
    await itemIs(world, "POWER_READING_PHOTO", "REJECTED");
    const result = await overrideEvidence(deps(world), world.console(), { workOrderId: world.ids.order, item: "POWER_READING_PHOTO", reason: "La lectura se ve en la segunda foto del medidor" });
    expect(result).toMatchObject({ status: "OVERRIDDEN", overriddenBy: "usr-adriana", atSim: "2026-10-13T09:20:00-06:00" });
    const entry = await world.deps.connector.workOrders.getChecklistItem(world.ids.order, "POWER_READING_PHOTO");
    expect(entry).toMatchObject({ status: "OVERRIDDEN", override: { userId: "usr-adriana", reason: "La lectura se ve en la segunda foto del medidor", atSim: "2026-10-13T09:20:00-06:00" } });
    expect(entry?.history.at(-1)).toMatchObject({ field: "status", from: "REJECTED", to: "OVERRIDDEN", actor: "USER:usr-adriana" });
    expect((await world.decisions()).filter((row) => row.action === "EVIDENCE_OVERRIDDEN")).toMatchObject([
      { decision: "ACTION", actor: "USER:usr-adriana", refs: { workOrderId: world.ids.order, item: "POWER_READING_PHOTO" }, detail: { userId: "usr-adriana", from: "REJECTED" } },
    ]);
    expect(world.queued).toEqual([
      {
        type: "AGENT_TURN",
        trigger: "EVIDENCE_OVERRIDDEN",
        eventId: result.eventId,
        clockId: world.clockId,
        ispId: world.ispId,
        installerId: world.ids.rogelio,
        workOrderId: world.ids.order,
        eventAtSim: "2026-10-13T09:20:00-06:00",
      },
    ]);
    // The event is one the InstallerWorker accepts as it is.
    expect(InstallerQueueEvent.parse(world.queued[0])).toEqual(world.queued[0]);
  });

  it("[FL-044] an item in review is validated too; the reason is masked before it is stored", async () => {
    const world = await serviceWorld(GUEST_07);
    await itemIs(world, "ONU_LABEL_PHOTO", "IN_REVIEW");
    await overrideEvidence(deps(world), world.console(), { workOrderId: world.ids.order, item: "ONU_LABEL_PHOTO", reason: "Confirmado con el cliente al 5512345678" });
    const entry = await world.deps.connector.workOrders.getChecklistItem(world.ids.order, "ONU_LABEL_PHOTO");
    expect(entry?.override?.reason).not.toContain("5512345678");
    expect(entry?.override?.userId).toBe("usr-guest-07");
  });

  it("[FL-044] only REJECTED or IN_REVIEW photo items of an open order; nothing changes otherwise", async () => {
    const world = await serviceWorld(DEMO);
    const call = (item: string) => overrideEvidence(deps(world), world.console(), { workOrderId: world.ids.order, item, reason: "Revisado en sitio" });
    expect(await refusal(call("ROSETTE_PHOTO"))).toMatchObject({ code: "CONFLICT", reason: "ITEM_NOT_REVIEWABLE" });
    expect(await refusal(call("CUSTOMER_OK"))).toMatchObject({ code: "INVALID" });
    expect(await refusal(call("ONU_ONLINE"))).toMatchObject({ code: "INVALID" });
    await itemIs(world, "ROSETTE_PHOTO", "PASSED");
    expect(await refusal(call("ROSETTE_PHOTO"))).toMatchObject({ reason: "ITEM_NOT_REVIEWABLE" });
    await itemIs(world, "POWER_READING_PHOTO", "REJECTED");
    await world.deps.connector.workOrders.setStatus(world.ids.order, "CLOSED", { actor: "AGENT", atSim: "2026-10-13T10:00:00-06:00" });
    expect(await refusal(call("POWER_READING_PHOTO"))).toMatchObject({ code: "CONFLICT", reason: "ORDER_NOT_OPEN" });
    expect(world.queued).toEqual([]);
    expect((await world.decisions()).some((row) => row.action === "EVIDENCE_OVERRIDDEN")).toBe(false);
  });

  it("[FL-044] OPS never validates, the channel never validates, and an order of another world reads as missing", async () => {
    const demo = await serviceWorld(DEMO);
    const guest = await serviceWorld(GUEST_07, demo);
    await itemIs(demo, "POWER_READING_PHOTO", "REJECTED");
    const input = { workOrderId: demo.ids.order, item: "POWER_READING_PHOTO", reason: "Revisado en sitio" };
    expect(await refusal(overrideEvidence(deps(demo), demo.console("OPS", "usr-ops"), input))).toMatchObject({ code: "FORBIDDEN", reason: "ROLE_NOT_ALLOWED" });
    expect(await refusal(overrideEvidence(deps(demo), demo.channel(), input))).toMatchObject({ code: "FORBIDDEN", reason: "CALLER_NOT_ALLOWED" });
    expect(await refusal(overrideEvidence(deps(guest), guest.console(), input))).toMatchObject({ code: "NOT_FOUND" });
    expect((await demo.deps.connector.workOrders.getChecklistItem(demo.ids.order, "POWER_READING_PHOTO"))?.status).toBe("REJECTED");
  });

  it("[FL-044] QA validates in its world as its usr-qa principal; a QA caller without a user is refused", async () => {
    const world = await serviceWorld(QA);
    await itemIs(world, "POWER_READING_PHOTO", "REJECTED");
    expect(await refusal(overrideEvidence(deps(world), { kind: "QA", ispId: world.ispId, clockId: world.clockId }, { workOrderId: world.ids.order, item: "POWER_READING_PHOTO", reason: "Revisado" }))).toMatchObject({ reason: "NO_USER" });
    expect(await overrideEvidence(deps(world), world.qa(), { workOrderId: world.ids.order, item: "POWER_READING_PHOTO", reason: "Revisado" })).toMatchObject({ overriddenBy: "usr-qa-sup" });
  });

  it("[FL-044] a validation that changed the item meanwhile wins: the override is a CONFLICT, nothing is queued", async () => {
    const world = await serviceWorld(DEMO);
    await itemIs(world, "POWER_READING_PHOTO", "REJECTED");
    const { workOrders } = world.deps.connector;
    const racing = {
      ...workOrders,
      async getChecklistItem(workOrderId: string, item: Parameters<typeof workOrders.getChecklistItem>[1]) {
        const read = await workOrders.getChecklistItem(workOrderId, item);
        await workOrders.updateChecklistItem(workOrderId, item, { status: "PASSED" }, { actor: "AGENT", atSim: "2026-10-13T09:19:00-06:00" });
        return read;
      },
    };
    const raced = { ...deps(world), connector: { ...world.deps.connector, workOrders: racing } };
    expect(await refusal(overrideEvidence(raced, world.console(), { workOrderId: world.ids.order, item: "POWER_READING_PHOTO", reason: "Revisado" }))).toMatchObject({ code: "CONFLICT", reason: "ITEM_CHANGED" });
    expect((await workOrders.getChecklistItem(world.ids.order, "POWER_READING_PHOTO"))?.status).toBe("PASSED");
    expect(world.queued).toEqual([]);
  });
});
