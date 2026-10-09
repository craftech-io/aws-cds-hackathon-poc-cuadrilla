// The local world itself (tests/flows/support/world.ts): it loads like `seed:load`, its entries reach the
// stage's modules and it settles. The flows of tests/flows/*.flow.test.ts build on these guarantees.
import { describe, expect, it } from "vitest";
import { createFlowWorld, GUEST_TEST_CLOCK } from "./world";

describe("local world", () => {
  it("loads the demo world and the rehearsal guest world with their clocks paused at 07:00 and the day's timers", async () => {
    const world = await createFlowWorld();
    expect(await world.simNow()).toBe("2026-10-13T13:00:00.000Z");
    expect(await world.simNow(GUEST_TEST_CLOCK)).toBe("2026-10-13T13:00:00.000Z");
    const rogelio = await world.data.people.getPerson("inst-rogelio");
    expect(rogelio?.phoneHash).toMatch(/^[0-9a-f]{64}$/);
    const order = await world.data.workOrders.getWorkOrder("wo-24817");
    expect(order?.onuSerial).toBe("DEMO3F2C19A0");
    expect((await world.network.row(world.clockId, "DEMO3F2C19A0"))?.behaviour).toBe("LOS_THEN_ONLINE");
  });

  it("answers an installer's message through InboundWhatsApp, the queue, the worker, the Harness and the pipeline", async () => {
    const world = await createFlowWorld();
    await world.at("09:20");
    const sent = await world.text("inst-rogelio", "Hola");
    expect(sent.result.records[0]?.messages).toEqual(["QUEUED"]);
    expect(await world.outbound("inst-rogelio", "ORDER_CHOICE")).toHaveLength(1);
    await world.tap("inst-rogelio", { title: "24817" });
    const replies = await world.outbound("inst-rogelio", "REPLY");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.status).toBe("DELIVERED");
    expect(world.harness.turns).toHaveLength(1);
    expect(world.queue.deadLetters).toEqual([]);
  });
});
