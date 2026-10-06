import { describe, expect, it } from "vitest";
import { feedWorld, onBus, queuedBodies, reassigned, rescheduled } from "../feeds/testing";
import { createFeedEventsHandler } from "./feed-events";

async function entry() {
  const world = await feedWorld();
  const handler = createFeedEventsHandler(() => world, () => world.logger);
  return { world, handler };
}

describe("FeedEvents entry [FL-014] [FL-015]", () => {
  it("[FL-014] turns a reschedule of the dispatcher into DISPATCH_EVENT on the installer's group", async () => {
    const { world, handler } = await entry();
    expect(await handler(onBus(rescheduled()))).toEqual({ status: "QUEUED" });
    expect(queuedBodies(world.sender)).toEqual([expect.objectContaining({ type: "DISPATCH_EVENT", installerId: "inst-rogelio", workOrderId: "wo-24817" })]);
  });

  it("[FL-015] queues a reassignment on the group of the installer who still owns the order", async () => {
    const { world, handler } = await entry();
    expect(await handler(onBus(reassigned()))).toEqual({ status: "QUEUED" });
    expect(world.sender.messages[0]?.groupId).toBe("inst-rogelio");
  });

  it("[FL-014] acknowledges a duplicate, an unknown order and an invalid event without queuing", async () => {
    const { world, handler } = await entry();
    const event = rescheduled();
    await handler(onBus(event));
    expect(await handler(onBus(event))).toEqual({ status: "DUPLICATE" });
    expect(await handler(onBus(rescheduled({ workOrderNumber: "24898" })))).toEqual({ status: "UNKNOWN_ORDER" });
    expect(await handler({ source: "aws.ses", detail: {} })).toEqual({ status: "INVALID" });
    expect(world.sender.messages).toHaveLength(1);
  });

  it("throws when the queue fails, so EventBridge delivers the event again", async () => {
    const { world, handler } = await entry();
    const event = rescheduled();
    world.sender.failNext();
    await expect(handler(onBus(event))).rejects.toThrow();
    expect(await handler(onBus(event))).toEqual({ status: "QUEUED" });
  });
});
