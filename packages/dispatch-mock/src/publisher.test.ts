import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { describe, expect, it, vi } from "vitest";
import type { DispatchEvent } from "./events";
import { PublishError, createEventBridgeClient, eventBridgePublisher, putEventsEntry, recordingPublisher, type PutEventsSender } from "./publisher";

const EVENT: DispatchEvent = {
  type: "WorkOrderCancelled",
  detail: { eventId: "evt_01K7F0000000000000000000A1", ispId: "isp-demo", workOrderNumber: "24818", reason: "CUSTOMER_REQUEST", occurredAtSim: "2026-10-13T10:40:00-06:00" },
};

function sender(outputs: Array<{ FailedEntryCount?: number; Entries?: Array<{ ErrorCode?: string }> } | Error>): PutEventsSender & { commands: PutEventsCommand[] } {
  const commands: PutEventsCommand[] = [];
  return {
    commands,
    async send(command) {
      commands.push(command);
      const next = outputs.shift() ?? { FailedEntryCount: 0 };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("putEventsEntry", () => {
  it("puts the event on the bus with the mock's source and its type", () => {
    const entry = putEventsEntry(EVENT, "aws-cds-hackathon-poc-cuadrilla-poc-Feeds");
    expect(entry).toEqual({
      EventBusName: "aws-cds-hackathon-poc-cuadrilla-poc-Feeds",
      Source: "mock.dispatch",
      DetailType: "WorkOrderCancelled",
      Detail: JSON.stringify(EVENT.detail),
    });
    expect(() => putEventsEntry({ ...EVENT, detail: { ...EVENT.detail, eventId: "evt_1" } }, "bus")).toThrow();
  });
});

describe("eventBridgePublisher", () => {
  const retry = { sleep: vi.fn(async () => undefined), random: () => 0.5 };

  it("sends one PutEvents with one entry", async () => {
    const client = sender([{ FailedEntryCount: 0, Entries: [{}] }]);
    await eventBridgePublisher(client, "bus", retry).publish(EVENT);
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]?.input.Entries).toEqual([putEventsEntry(EVENT, "bus")]);
  });

  it("retries an entry the bus throttled, with backoff, and then succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    const client = sender([{ FailedEntryCount: 1, Entries: [{ ErrorCode: "ThrottlingException" }] }, { FailedEntryCount: 0 }]);
    await eventBridgePublisher(client, "bus", { sleep, random: () => 1, baseDelayMs: 100 }).publish(EVENT);
    expect(client.commands).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("gives up after the attempts and never retries a permanent rejection", async () => {
    const throttled = { FailedEntryCount: 1, Entries: [{ ErrorCode: "InternalException" }] };
    const exhausted = sender([throttled, throttled, throttled, throttled]);
    await expect(eventBridgePublisher(exhausted, "bus", retry).publish(EVENT)).rejects.toBeInstanceOf(PublishError);
    expect(exhausted.commands).toHaveLength(3);
    const denied = sender([{ FailedEntryCount: 1, Entries: [{ ErrorCode: "NotAuthorizedForSourceException" }] }]);
    await expect(eventBridgePublisher(denied, "bus", retry).publish(EVENT)).rejects.toThrow(/NotAuthorizedForSourceException/);
    expect(denied.commands).toHaveLength(1);
  });

  it("wraps an SDK failure, whose retries the SDK already spent", async () => {
    const client = sender([Object.assign(new Error("socket hang up"), { name: "TimeoutError" })]);
    const failure = eventBridgePublisher(client, "bus", retry).publish(EVENT);
    await expect(failure).rejects.toBeInstanceOf(PublishError);
    expect(client.commands).toHaveLength(1);
  });

  it("builds its client with the SDK retry budget", async () => {
    const client = createEventBridgeClient();
    expect(await client.config.maxAttempts()).toBe(3);
    client.destroy();
  });
});

describe("recordingPublisher", () => {
  it("records, fails on demand and hands each event to an in-process consumer", async () => {
    const delivered: DispatchEvent[] = [];
    const publisher = recordingPublisher(async (event) => {
      delivered.push(event);
    });
    publisher.failNext();
    await expect(publisher.publish(EVENT)).rejects.toBeInstanceOf(PublishError);
    await publisher.publish(EVENT);
    expect(publisher.published).toEqual([EVENT]);
    expect(delivered).toEqual([EVENT]);
  });
});
