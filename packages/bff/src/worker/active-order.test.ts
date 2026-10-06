import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP, MSG, ROGELIO, TURN_AT_SIM, WO, type WorkerKit, inboundEvent, inboundMessage, seedWorld, workerKit } from "./testing";

let kit: WorkerKit;

beforeEach(async () => {
  kit = workerKit();
  await seedWorld(kit);
});

const LIST_MESSAGE = "choice-0000000000000000000000000000000000000001";
const TAP = "wamid.SIM.01JB8Z9Q2W3E4R5T6Y7V8X9TAP";

describe("worker: the order a message is about (FL-013)", () => {
  it("[FL-013] sends ORDER_CHOICE and runs no turn when several orders are pending and none is active", async () => {
    await kit.connector.worlds.setActiveWorkOrder(ROGELIO, CLOCK, null);
    const message = await inboundMessage(kit, { workOrderId: undefined });
    await kit.run(inboundEvent(message));
    expect(kit.rec.choices).toEqual([MSG]);
    expect(kit.rec.harness).toEqual([]);
  });

  it("[FL-013] makes the only pending order active without asking", async () => {
    await kit.connector.worlds.setActiveWorkOrder(ROGELIO, CLOCK, null);
    await kit.connector.workOrders.setStatus("wo-24818", "CANCELLED", { actor: "SYSTEM", atSim: TURN_AT_SIM });
    const message = await inboundMessage(kit, { workOrderId: undefined });
    await kit.run(inboundEvent(message));
    expect(kit.rec.choices).toEqual([]);
    expect((await kit.connector.worlds.getInstallerState(ROGELIO))?.activeWorkOrderId).toBe(WO);
    expect(kit.rec.harness).toHaveLength(1);
  });

  it("[FL-013] a tap on a row activates its order and the turn answers the message the list asked about", async () => {
    await kit.connector.worlds.setActiveWorkOrder(ROGELIO, CLOCK, null);
    await inboundMessage(kit, { workOrderId: undefined });
    await kit.connector.conversations.appendMessage({
      messageId: LIST_MESSAGE,
      personId: ROGELIO,
      ispId: ISP,
      clockId: CLOCK,
      direction: "OUT",
      channel: "WHATSAPP",
      content: "INTERACTIVE",
      kind: "ORDER_CHOICE",
      text: "¿Sobre cuál es tu mensaje?",
      status: "SENT",
      author: "SYSTEM",
      simulated: true,
      refs: { sourceMessageId: MSG },
      sentAtSim: TURN_AT_SIM,
      sentAtReal: new Date(kit.tools.memory.now().getTime() + 1_000).toISOString(),
    });
    await kit.connector.runtime.putNonce({ nonce: "nonce-choose-24818", clockId: CLOCK, phoneHash: "a".repeat(64), personId: ROGELIO, action: "CHOOSE_ORDER", object: { kind: "WORK_ORDER", id: "wo-24818" }, messageId: LIST_MESSAGE, useCount: 1 });
    const tap = await inboundMessage(kit, { messageId: TAP, text: "OT 24818", workOrderId: "wo-24818", buttonAction: "CHOOSE_ORDER", nonce: "nonce-choose-24818", content: "BUTTON" });
    await kit.run(inboundEvent(tap, "wa-in-0000000000000000000000000000000000000002"));
    expect((await kit.connector.worlds.getInstallerState(ROGELIO))?.activeWorkOrderId).toBe("wo-24818");
    const [request] = kit.rec.harness;
    expect(request?.envelope).toContain("la ONU no prende la luz PON</inbound-");
  });
});
