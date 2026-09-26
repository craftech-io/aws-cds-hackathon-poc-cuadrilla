import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { awsClientConfig, CLIENT_TIMEOUTS } from "../../lib/clients";
import { DynamoTableClient, toConnectorError } from "./client";

const docMock = mockClient(DynamoDBDocumentClient);
const resolveName = (table: string) => `poc-${table}`;
const NOW = "2026-10-13T13:00:00.000Z";

function awsError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(name), { name }, extra);
}

describe("DynamoTableClient", () => {
  let client: DynamoTableClient;

  beforeEach(() => {
    docMock.reset();
    const base = new DynamoDBClient({ region: "us-east-1", ...awsClientConfig(CLIENT_TIMEOUTS.dynamodb) });
    client = new DynamoTableClient(DynamoDBDocumentClient.from(base), { resolveName, sleep: async () => undefined });
  });

  it("resolves the physical table name and reads consistently", async () => {
    docMock.on(GetCommand).resolves({ Item: { PK: "PERSON#inst-rogelio", SK: "META", entity: "Person" } });
    expect(await client.get("People", { PK: "PERSON#inst-rogelio", SK: "META" })).toMatchObject({ entity: "Person" });
    expect(docMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({ TableName: "poc-People", ConsistentRead: true });
  });

  it("pages through a query until LastEvaluatedKey is gone; GSIs read eventually consistent", async () => {
    docMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ PK: "A", SK: "1" }], LastEvaluatedKey: { PK: "A", SK: "1" } })
      .resolvesOnce({ Items: [{ PK: "A", SK: "2" }] });
    const rows = await client.query("WorkOrders", { index: "GSI1", hashValue: "INST#inst-rogelio#2026-10-13" });
    expect(rows.map((row) => row.SK)).toEqual(["1", "2"]);
    const second = docMock.commandCalls(QueryCommand)[1]?.args[0].input;
    expect(second).toMatchObject({ IndexName: "GSI1", ConsistentRead: false, ExclusiveStartKey: { PK: "A", SK: "1" } });
  });

  it("stops paging at the limit", async () => {
    docMock.on(QueryCommand).resolves({ Items: [{ PK: "A", SK: "1" }], LastEvaluatedKey: { PK: "A", SK: "1" } });
    expect(await client.query("Runtime", { hashValue: "A", limit: 1 })).toHaveLength(1);
    expect(docMock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it("maps a failed condition to CONFLICT on put and NOT_FOUND on a plain update", async () => {
    docMock.on(PutCommand).rejects(awsError("ConditionalCheckFailedException"));
    await expect(client.put("Cases", { PK: "CASE#1", SK: "META" }, { ifNotExists: true })).rejects.toMatchObject({ code: "CONFLICT", table: "Cases" });
    docMock.on(UpdateCommand).rejects(awsError("ConditionalCheckFailedException"));
    await expect(client.update("Cases", { PK: "CASE#1", SK: "META" }, { status: "OPEN" }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.update("Cases", { PK: "CASE#1", SK: "META" }, { status: "OPEN" }, NOW, { ifVersion: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.update("Cases", { PK: "CASE#1", SK: "META" }, { status: "OPEN" }, NOW, { equals: { rungVersion: 1 } })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("retries throttling and, for reads only, timeouts", async () => {
    docMock.on(GetCommand).rejectsOnce(awsError("ProvisionedThroughputExceededException")).rejectsOnce(awsError("TimeoutError")).resolvesOnce({ Item: { PK: "X", SK: "META" } });
    expect((await client.get("Runtime", { PK: "X", SK: "META" }))?.PK).toBe("X");
    expect(docMock.commandCalls(GetCommand)).toHaveLength(3);
    docMock.on(PutCommand).rejects(awsError("TimeoutError"));
    await expect(client.put("Runtime", { PK: "X", SK: "META" })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(docMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  it("returns the new counter value and sends the ceiling as a condition", async () => {
    docMock.on(UpdateCommand).resolves({ Attributes: { PK: "JUMP#x", SK: "META", count: 7 } });
    expect(await client.increment("Runtime", { PK: "JUMP#x", SK: "META" }, "count", 1, { updatedAt: NOW, max: 30 })).toBe(7);
    expect(docMock.commandCalls(UpdateCommand)[0]?.args[0].input.ConditionExpression).toContain("attribute_not_exists");
  });

  it("adds to a string set and removes from it; a missing row is not an error", async () => {
    docMock.on(UpdateCommand).resolvesOnce({ Attributes: { PK: "W", SK: "META", inFlight: new Set(["e1"]) } });
    await client.addToSet("Runtime", { PK: "W", SK: "META" }, "inFlight", ["e1"], { updatedAt: NOW, defaults: { entity: "WorldState" } });
    const add = docMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(add?.UpdateExpression).toMatch(/^ADD #n0 :v1 SET/);
    expect(add?.ExpressionAttributeValues?.[":v1"]).toEqual(new Set(["e1"]));
    docMock.on(UpdateCommand).rejects(awsError("ConditionalCheckFailedException"));
    expect(await client.removeFromSet("Runtime", { PK: "W", SK: "META" }, "inFlight", ["e1"], { updatedAt: NOW })).toBeUndefined();
  });

  it("sends a transaction and maps its cancellation reasons", async () => {
    docMock.on(TransactWriteCommand).rejectsOnce(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] }));
    await expect(
      client.transact(
        [
          { op: "put", table: "People", item: { PK: "PERSON#p", SK: "META" }, condition: { ifNotExists: true } },
          { op: "put", table: "People", item: { PK: "ADDR#c#h", SK: "CLAIM" }, condition: { ifNotExists: true } },
          { op: "increment", table: "Runtime", key: { PK: "COUNTER#x", SK: "META" }, attribute: "count", by: 1, max: 5 },
          { op: "addToSet", table: "Runtime", key: { PK: "WORLDSTATE#c", SK: "META" }, attribute: "phoneLeases", values: ["h"] },
          { op: "delete", table: "People", key: { PK: "ADDR#c#old", SK: "CLAIM" }, condition: { ifVersion: 1 } },
        ],
        NOW,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const items = docMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(items?.map((item) => Object.keys(item)[0])).toEqual(["Put", "Put", "Update", "Update", "Delete"]);
    expect(items?.[0]?.Put?.TableName).toBe("poc-People");
    expect(items?.[2]?.Update?.TableName).toBe("poc-Runtime");
    docMock.on(TransactWriteCommand).rejects(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "TransactionConflict" }] }));
    await expect(client.transact([{ op: "delete", table: "People", key: { PK: "A", SK: "B" } }], NOW)).rejects.toMatchObject({ code: "THROTTLED" });
  });

  it("chunks batch writes by 25 and retries unprocessed items; deletes too", async () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ PK: "REF#EVAL#QUESTIONS", SK: `q-A-${index.toString().padStart(2, "0")}` }));
    docMock
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { "poc-Reference": [{ PutRequest: { Item: items[0] } }] } })
      .resolves({});
    await client.batchPut("Reference", items);
    const calls = docMock.commandCalls(BatchWriteCommand);
    expect(calls.map((call) => call.args[0].input.RequestItems?.["poc-Reference"]?.length)).toEqual([25, 1, 5]);
    await client.batchDelete("Reference", [{ PK: "REF#EVAL#QUESTIONS", SK: "q-A-01" }]);
    expect(docMock.commandCalls(BatchWriteCommand).at(-1)?.args[0].input.RequestItems?.["poc-Reference"]?.[0]).toEqual({ DeleteRequest: { Key: { PK: "REF#EVAL#QUESTIONS", SK: "q-A-01" } } });
  });

  it("deletes under a condition", async () => {
    docMock.on(DeleteCommand).resolves({});
    await client.delete("Runtime", { PK: "LEASE#PHONE#1", SK: "META" }, { equals: { holder: "run-a" } });
    expect(docMock.commandCalls(DeleteCommand)[0]?.args[0].input.ConditionExpression).toBe("#n0 = :v1");
  });
});

describe("toConnectorError", () => {
  it("classifies SDK errors and hides unknown ones as UNAVAILABLE", () => {
    expect(toConnectorError(awsError("ThrottlingException"), "WorkOrders").code).toBe("THROTTLED");
    expect(toConnectorError(awsError("TimeoutError"), "WorkOrders").code).toBe("TIMEOUT");
    expect(toConnectorError(awsError("ValidationException"), "WorkOrders").code).toBe("VALIDATION");
    expect(toConnectorError(awsError("ResourceNotFoundException"), "WorkOrders").code).toBe("UNAVAILABLE");
    const unknown = toConnectorError(new Error("secret internals"), "WorkOrders");
    expect(unknown).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(unknown.message).not.toContain("secret");
  });
});
