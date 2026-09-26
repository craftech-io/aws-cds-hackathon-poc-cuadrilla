import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { DispatchEventItem, DispatchOrderItem, dispatchEventSk } from "./items";
import { DispatchConflictError } from "./store";
import { createDispatchDocumentClient, dynamoDispatchStore, type DocumentSender } from "./store-dynamo";

const EVENT_ID = "evt_01K7F0000000000000000000A1";
const LATER_ID = "evt_01K7F0000000000000000000B2";

const META = DispatchOrderItem.parse({
  PK: "DWO#isp-guest-03#24817",
  SK: "META",
  entity: "DispatchOrder",
  ispId: "isp-guest-03",
  workOrderNumber: "24817",
  workOrderId: "wo-24817-g03",
  installerId: "inst-rogelio",
  appointmentWindow: { start: "2026-10-13T09:00:00-06:00", end: "2026-10-13T11:00:00-06:00" },
  status: "SCHEDULED",
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:00:00.000Z",
  version: 3,
  clockId: "GUEST#isp-guest-03",
  expiresAt: 1_760_600_000,
});

function cancelledEvent(eventId: string, occurredAtSim: string): DispatchEventItem {
  return DispatchEventItem.parse({
    PK: META.PK,
    SK: dispatchEventSk(occurredAtSim, eventId),
    entity: "DispatchEvent",
    type: "WorkOrderCancelled",
    detail: { eventId, ispId: "isp-guest-03", workOrderNumber: "24817", reason: "CUSTOMER_REQUEST", occurredAtSim },
    idempotencyKey: `key-${eventId}`,
    createdAt: "2026-10-13T16:00:00.000Z",
    updatedAt: "2026-10-13T16:00:00.000Z",
    version: 1,
    clockId: "GUEST#isp-guest-03",
  });
}

function fakeClient(respond: (command: QueryCommand | TransactWriteCommand, call: number) => unknown): DocumentSender & { calls: Array<QueryCommand | TransactWriteCommand> } {
  const calls: Array<QueryCommand | TransactWriteCommand> = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      const result = respond(command, calls.length);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("dynamoDispatchStore.load", () => {
  it("reads the order and its events with one consistent query per page, events in key order", async () => {
    const later = cancelledEvent(LATER_ID, "2026-10-13T12:00:00-06:00");
    const earlier = cancelledEvent(EVENT_ID, "2026-10-13T10:00:00-06:00");
    const client = fakeClient((_command, call) => (call === 1 ? { Items: [later], LastEvaluatedKey: { PK: META.PK, SK: later.SK } } : { Items: [META, earlier] }));
    const record = await dynamoDispatchStore(client, "dispatch-table").load("isp-guest-03", "24817");
    expect(record?.order).toEqual(META);
    expect(record?.events.map((event) => event.detail.eventId)).toEqual([EVENT_ID, LATER_ID]);
    const [first, second] = client.calls as [QueryCommand, QueryCommand];
    expect(first.input).toMatchObject({ TableName: "dispatch-table", KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": "DWO#isp-guest-03#24817" }, ConsistentRead: true });
    expect(second.input.ExclusiveStartKey).toEqual({ PK: META.PK, SK: later.SK });
  });

  it("returns undefined without a META row and rejects a malformed row", async () => {
    expect(await dynamoDispatchStore(fakeClient(() => ({ Items: [] })), "t").load("isp-guest-03", "24817")).toBeUndefined();
    const broken = fakeClient(() => ({ Items: [{ ...META, status: "CLOSED" }] }));
    await expect(dynamoDispatchStore(broken, "t").load("isp-guest-03", "24817")).rejects.toThrow();
  });
});

describe("dynamoDispatchStore.commit", () => {
  const change = {
    status: "CANCELLED" as const,
    installerId: META.installerId,
    appointmentWindow: META.appointmentWindow,
    lastEventId: EVENT_ID,
    updatedAt: "2026-10-13T16:40:05.000Z",
  };
  const event = cancelledEvent(EVENT_ID, "2026-10-13T10:40:00-06:00");

  it("moves the order under its version and appends the event only if it is new, in one transaction", async () => {
    const client = fakeClient(() => ({}));
    await dynamoDispatchStore(client, "dispatch-table").commit(META, change, event);
    const [command] = client.calls as [TransactWriteCommand];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const [update, put] = command.input.TransactItems ?? [];
    expect(update?.Update).toMatchObject({
      TableName: "dispatch-table",
      Key: { PK: META.PK, SK: "META" },
      ConditionExpression: "#version = :expected",
      ExpressionAttributeValues: { ":status": "CANCELLED", ":eventId": EVENT_ID, ":expected": 3, ":next": 4 },
    });
    expect(update?.Update?.UpdateExpression).not.toMatch(/expiresAt|clockId|workOrderId/);
    expect(put?.Put).toEqual({ TableName: "dispatch-table", Item: event, ConditionExpression: "attribute_not_exists(PK)" });
  });

  it("turns a failed condition into DispatchConflictError and lets any other failure through", async () => {
    const cancelled = Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
    });
    await expect(dynamoDispatchStore(fakeClient(() => cancelled), "t").commit(META, change, event)).rejects.toBeInstanceOf(DispatchConflictError);
    const conflicting = Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] });
    await expect(dynamoDispatchStore(fakeClient(() => conflicting), "t").commit(META, change, event)).rejects.toThrow("Transaction cancelled");
    const throttled = Object.assign(new Error("slow down"), { name: "ProvisionedThroughputExceededException" });
    await expect(dynamoDispatchStore(fakeClient(() => throttled), "t").commit(META, change, event)).rejects.not.toBeInstanceOf(DispatchConflictError);
  });
});

describe("createDispatchDocumentClient", () => {
  it("bounds every call by the SDK retry budget", async () => {
    const client = createDispatchDocumentClient();
    expect(await client.config.maxAttempts()).toBe(3);
    client.destroy();
  });
});
