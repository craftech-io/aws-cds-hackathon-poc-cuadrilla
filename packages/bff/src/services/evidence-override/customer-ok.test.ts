import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { DEMO, GUEST_07, QA, serviceWorld } from "../people/testing";
import { customerOkAction, recordCustomerOk } from "./customer-ok";

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ToolError);
  return error as ToolError;
}

const TAP_AT = "2026-10-13T10:40:00-06:00";

describe("record_customer_ok: the \"Cliente conforme\" button [FL-040]", () => {
  it("[FL-040] the installer's tap passes CUSTOMER_OK at the tap's instant, by the installer, audited; a second tap writes nothing", async () => {
    const world = await serviceWorld(DEMO);
    const tap = customerOkAction(world.deps);
    const input = { clockId: world.clockId, ispId: world.ispId, personId: world.ids.rogelio, workOrderId: world.ids.order, atSim: TAP_AT, sourceMessageId: "wamid.OK1", eventId: "wa-in-ok1" };
    await tap(input);
    const entry = await world.deps.connector.workOrders.getChecklistItem(world.ids.order, "CUSTOMER_OK");
    expect(entry).toMatchObject({ status: "PASSED", updatedAtSim: TAP_AT });
    expect(entry?.history.at(-1)).toMatchObject({ field: "status", from: "PENDING", to: "PASSED", actor: `PERSON:${world.ids.rogelio}`, atSim: TAP_AT });
    await tap({ ...input, sourceMessageId: "wamid.OK2", eventId: "wa-in-ok2" });
    expect((await world.decisions()).filter((row) => row.action === "CUSTOMER_OK")).toMatchObject([{ actor: "CHANNEL", messageId: "wamid.OK1", refs: { workOrderId: world.ids.order } }]);
  });

  it("only the order's installer, on an open order of the world; never from the console", async () => {
    const demo = await serviceWorld(DEMO);
    const guest = await serviceWorld(GUEST_07, demo);
    const base = { workOrderId: demo.ids.order, personId: demo.ids.julian };
    expect(await refusal(recordCustomerOk(demo.deps, demo.channel(), base))).toMatchObject({ code: "FORBIDDEN", reason: "NOT_ORDER_INSTALLER" });
    expect(await refusal(recordCustomerOk(guest.deps, guest.channel(), { ...base, personId: demo.ids.rogelio }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(recordCustomerOk(demo.deps, demo.console(), { ...base, personId: demo.ids.rogelio }))).toMatchObject({ code: "FORBIDDEN", reason: "CALLER_NOT_ALLOWED" });
    await demo.deps.connector.workOrders.setStatus(demo.ids.order, "CANCELLED", { actor: "SYSTEM", atSim: "2026-10-13T10:00:00-06:00" });
    expect(await refusal(recordCustomerOk(demo.deps, demo.channel(), { ...base, personId: demo.ids.rogelio }))).toMatchObject({ code: "CONFLICT", reason: "ORDER_NOT_OPEN" });
    expect((await demo.deps.connector.workOrders.getChecklistItem(demo.ids.order, "CUSTOMER_OK"))?.status).toBe("PENDING");
  });

  it("QA records it at the world's now and never brings a tap", async () => {
    const world = await serviceWorld(QA);
    expect(await recordCustomerOk(world.deps, world.qa(), { workOrderId: world.ids.order, personId: world.ids.rogelio })).toMatchObject({ changed: true, status: "PASSED" });
    expect((await world.deps.connector.workOrders.getChecklistItem(world.ids.order, "CUSTOMER_OK"))?.updatedAtSim).toBe("2026-10-13T09:20:00-06:00");
    expect(await refusal(recordCustomerOk(world.deps, world.qa(), { workOrderId: world.ids.order, personId: world.ids.rogelio, atSim: TAP_AT }))).toMatchObject({ reason: "CHANNEL_ONLY_FIELD" });
  });
});
