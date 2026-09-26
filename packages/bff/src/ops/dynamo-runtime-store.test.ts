import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DynamoDBDocumentClient, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectorError } from "@cuadrilla/shared";
import { type CapCounter, planCounters } from "./cost-caps";
import { clientRequestToken, createDynamoRuntimeStore, toConnectorError } from "./dynamo-runtime-store";

const docMock = mockClient(DynamoDBDocumentClient);
const NOW = new Date("2026-10-20T15:20:00.000Z");
const NOW_ISO = NOW.toISOString();
const GLOBAL = { turnsPerDay: 1500, validationsPerDay: 400, transcribeSecondsPerDay: 5400 };
const COUNTERS: CapCounter[] = planCounters(
  { world: { clockId: "JUDGE#isp-judge-07", settings: { turnCaps: { perHour: 200, perDay: 1000 } } }, resource: "turns", amount: 1, reserve: ["OPERATOR", "GLOBAL"] },
  GLOBAL,
  NOW,
);

function awsError(name: string, extra: Record<string, unknown> = {}): Error {
  const error = Object.assign(new Error(name), extra);
  error.name = name;
  return error;
}

function store() {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
  return createDynamoRuntimeStore({ client, table: () => "poc-Runtime", retry: { sleep: async () => undefined } });
}

describe("DynamoDB runtime store: cap counters", () => {
  beforeEach(() => docMock.reset());

  it("reserves every counter in one transaction of conditional ADDs, idempotent by event", async () => {
    docMock.on(TransactWriteCommand).resolves({});
    expect(await store().reserve(COUNTERS, { nowIso: NOW_ISO, idempotencyKey: "evt-01" })).toEqual({ ok: true });
    const input = docMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(input?.ClientRequestToken).toBe(clientRequestToken("evt-01"));
    expect(input?.ClientRequestToken).toHaveLength(32);
    expect(input?.TransactItems).toHaveLength(3);
    const global = input?.TransactItems?.[2]?.Update;
    expect(global).toMatchObject({
      TableName: "poc-Runtime",
      Key: { PK: "TURNCAP#GLOBAL#2026-10-20", SK: "META" },
      ConditionExpression: "attribute_not_exists(#used) OR #used <= :max",
      ExpressionAttributeValues: { ":amount": 1, ":limit": 1500, ":max": 1499, ":expiresAt": COUNTERS[2]?.expiresAt, ":now": NOW_ISO },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    });
    expect(global?.UpdateExpression).toContain("ADD #used :amount");
    expect(global?.UpdateExpression).toContain("#expiresAt = if_not_exists(#expiresAt, :expiresAt)");
  });

  it("reports the counter whose condition failed, with the value it had", async () => {
    docMock.on(TransactWriteCommand).rejects(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed", Item: { used: { N: "1000" } } }, { Code: "None" }] }));
    expect(await store().reserve(COUNTERS, { nowIso: NOW_ISO })).toEqual({ ok: false, failedKey: "TURNCAP#isp-judge-07#2026-10-20", used: 1000 });
    expect(docMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("refuses a counter with no room at all without calling DynamoDB", async () => {
    const zero = COUNTERS.map((counter, index) => (index === 1 ? { ...counter, limit: 0 } : counter));
    expect(await store().reserve(zero, { nowIso: NOW_ISO })).toEqual({ ok: false, failedKey: "TURNCAP#isp-judge-07#2026-10-20" });
    expect(docMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("retries throttling and transaction conflicts with backoff", async () => {
    docMock
      .on(TransactWriteCommand)
      .rejectsOnce(awsError("ProvisionedThroughputExceededException"))
      .rejectsOnce(awsError("TransactionCanceledException", { CancellationReasons: [{ Code: "TransactionConflict" }] }))
      .resolvesOnce({});
    expect(await store().reserve(COUNTERS, { nowIso: NOW_ISO })).toEqual({ ok: true });
    expect(docMock.commandCalls(TransactWriteCommand)).toHaveLength(3);
  });

  it("retries a timed-out reservation only when it carries an idempotency token", async () => {
    docMock.on(TransactWriteCommand).rejectsOnce(awsError("TimeoutError")).resolves({});
    await expect(store().reserve(COUNTERS, { nowIso: NOW_ISO })).rejects.toMatchObject({ code: "TIMEOUT" });
    docMock.reset();
    docMock.on(TransactWriteCommand).rejectsOnce(awsError("TimeoutError")).resolves({});
    expect(await store().reserve(COUNTERS, { nowIso: NOW_ISO, idempotencyKey: "evt-02" })).toEqual({ ok: true });
  });

  it("gives amounts back without going below zero", async () => {
    docMock.on(UpdateCommand).resolvesOnce({}).rejectsOnce(awsError("ConditionalCheckFailedException")).resolvesOnce({});
    await store().release(COUNTERS);
    const calls = docMock.commandCalls(UpdateCommand).map((call) => call.args[0].input);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ UpdateExpression: "ADD #used :negative", ConditionExpression: "#used >= :amount", ExpressionAttributeValues: { ":negative": -1, ":amount": 1 } });
    docMock.on(UpdateCommand).rejects(awsError("ValidationException"));
    await expect(store().release(COUNTERS)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("reads usage consistently and follows unprocessed keys", async () => {
    docMock
      .on(BatchGetCommand)
      .resolvesOnce({ Responses: { "poc-Runtime": [{ PK: "TURNCAP#GLOBAL#2026-10-20", used: 12 }] }, UnprocessedKeys: { "poc-Runtime": { Keys: [{ PK: "VALCAP#GLOBAL#2026-10-20", SK: "META" }] } } })
      .resolvesOnce({ Responses: { "poc-Runtime": [{ PK: "VALCAP#GLOBAL#2026-10-20", used: 3 }] } });
    const used = await store().readUsed(["TURNCAP#GLOBAL#2026-10-20", "VALCAP#GLOBAL#2026-10-20", "TRANSCRIBE#GLOBAL#2026-10-20"]);
    expect([...used]).toEqual([
      ["TURNCAP#GLOBAL#2026-10-20", 12],
      ["VALCAP#GLOBAL#2026-10-20", 3],
    ]);
    expect(docMock.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.["poc-Runtime"]).toMatchObject({ ConsistentRead: true, ProjectionExpression: "PK, #used" });
  });
});

describe("DynamoDB runtime store: kill switch", () => {
  beforeEach(() => docMock.reset());

  it("writes the whole switch with PutItem, the only write CostGuard's role has", async () => {
    docMock.on(PutCommand).resolves({});
    await store().write("KILL#ALL", { scope: "ALL", state: "on", setBy: "COST_GUARD", setAtReal: NOW_ISO }, undefined);
    await store().write("KILL#AGENT#qa-812-1-sc-14", { scope: "AGENT", clockId: "qa-812-1-sc-14", state: "on", setBy: "QA", setAtReal: NOW_ISO }, 1_793_000_000);
    const [global, world] = docMock.commandCalls(PutCommand).map((call) => call.args[0].input);
    expect(global).toEqual({ TableName: "poc-Runtime", Item: { PK: "KILL#ALL", SK: "META", entity: "KillSwitch", scope: "ALL", state: "on", setBy: "COST_GUARD", setAtReal: NOW_ISO, updatedAt: NOW_ISO } });
    expect(world?.Item).toMatchObject({ PK: "KILL#AGENT#qa-812-1-sc-14", expiresAt: 1_793_000_000 });
    expect(docMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("reads the switches without their keys, and retries a throttled read", async () => {
    docMock
      .on(BatchGetCommand)
      .rejectsOnce(awsError("ThrottlingException"))
      .resolvesOnce({ Responses: { "poc-Runtime": [{ PK: "KILL#AGENT", SK: "META", entity: "KillSwitch", scope: "AGENT", state: "on", setBy: "OPERATOR", setAtReal: NOW_ISO }] } });
    const items = await store().read(["KILL#ALL", "KILL#AGENT"]);
    expect(items.get("KILL#AGENT")).toEqual({ entity: "KillSwitch", scope: "AGENT", state: "on", setBy: "OPERATOR", setAtReal: NOW_ISO });
    expect(items.has("KILL#ALL")).toBe(false);
    expect(docMock.commandCalls(BatchGetCommand)[1]?.args[0].input.RequestItems?.["poc-Runtime"]).toMatchObject({ ConsistentRead: true });
  });

  it("gives up after a few rounds of unprocessed keys", async () => {
    docMock.on(BatchGetCommand).resolves({ UnprocessedKeys: { "poc-Runtime": { Keys: [{ PK: "KILL#ALL", SK: "META" }] } } });
    await expect(store().read(["KILL#ALL"])).rejects.toMatchObject({ code: "THROTTLED" });
  });
});

describe("toConnectorError", () => {
  it("maps DynamoDB errors to typed, retryable-or-not connector errors", () => {
    expect(toConnectorError(awsError("ProvisionedThroughputExceededException"))).toMatchObject({ code: "THROTTLED", retryable: true, table: "Runtime" });
    expect(toConnectorError(awsError("TimeoutError"))).toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(toConnectorError(awsError("IdempotentParameterMismatchException"))).toMatchObject({ code: "CONFLICT", retryable: false });
    expect(toConnectorError(awsError("ValidationException"))).toMatchObject({ code: "VALIDATION", retryable: false });
    expect(toConnectorError(awsError("AccessDeniedException"))).toMatchObject({ code: "UNAVAILABLE" });
    const typed = new ConnectorError("NOT_FOUND", "x", "Runtime");
    expect(toConnectorError(typed)).toBe(typed);
  });
});
