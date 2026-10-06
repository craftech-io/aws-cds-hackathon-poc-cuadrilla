import { beforeEach, describe, expect, it } from "vitest";
import { HarnessError, hasRoomForAttempt } from "../agent/harness-client";
import { TurnRequeued } from "../turns/deps";
import { CLOCK, ISP, ROGELIO, type WorkerKit, inboundEvent, inboundMessage, seedWorld, workerKit } from "./testing";

let kit: WorkerKit;

beforeEach(async () => {
  kit = workerKit();
  await seedWorld(kit);
});

const EVENT_ID = "wa-in-0000000000000000000000000000000000000001";
const throttled = () => Promise.reject(new HarnessError("THROTTLED", "InvokeHarness throttled after 1 attempts"));

describe("worker: time budget of the message (docs/architecture.md §7)", () => {
  it("retries the Harness only with more than timeoutSeconds + 30 s left", () => {
    expect(hasRoomForAttempt(121_000, 90)).toBe(true);
    expect(hasRoomForAttempt(119_000, 90)).toBe(false);
  });

  it("gives the Harness the Lambda's own deadline: now + remaining time", async () => {
    kit.remainingMs = 250_000;
    const message = await inboundMessage(kit);
    await kit.run(inboundEvent(message));
    expect(kit.rec.harness[0]?.lambdaDeadlineMs).toBe(kit.tools.memory.now().getTime() + 250_000);
  });

  it("throttled with no time left: AGENT_FALLBACK once, the event leaves inFlight in that attempt and goes back to the queue", async () => {
    kit.harnessScripts.push(throttled);
    const message = await inboundMessage(kit);
    await kit.deps.sink.enqueue(inboundEvent(message));
    await expect(kit.run(kit.rec.queued[0])).rejects.toBeInstanceOf(TurnRequeued);
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["agentFallback"]);
    expect((await kit.connector.audit.listByMonth(ISP, "2026-10")).map((decision) => decision.action)).toEqual(["AGENT_FALLBACK"]);
    expect((await kit.connector.worlds.getInstallerState(ROGELIO))?.inFlight).toEqual([]);
    expect((await kit.connector.worlds.getWorldState(CLOCK))?.inFlight).toEqual([]);
    expect(await kit.connector.runtime.getIdempotency("INBOUND_MESSAGE", EVENT_ID)).toBeUndefined();
  });

  it("the requeued event runs its turn on the next delivery and the fallback is not sent again", async () => {
    kit.harnessScripts.push(throttled, throttled);
    const message = await inboundMessage(kit);
    await expect(kit.run(inboundEvent(message))).rejects.toBeInstanceOf(TurnRequeued);
    await expect(kit.run(inboundEvent(message), 2)).rejects.toBeInstanceOf(TurnRequeued);
    await kit.run(inboundEvent(message), 3);
    expect(kit.rec.harness).toHaveLength(3);
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["agentFallback"]);
    expect(await kit.connector.conversations.listTurnNotes(ROGELIO)).toHaveLength(1);
  });

  it("a requeued event on its last attempt is dead-lettered instead", async () => {
    kit.harnessScripts.push(throttled);
    const message = await inboundMessage(kit);
    await expect(kit.run(inboundEvent(message), 5)).rejects.toBeInstanceOf(TurnRequeued);
    expect((await kit.connector.worlds.getInstallerState(ROGELIO))?.processError).toMatchObject({ eventId: EVENT_ID });
  });
});
