import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { DynamoOnuStore, type DocumentSender } from "./dynamo-store";
import { createHandler, toMockRequest } from "./handler";
import { OnuRow, newOnuRow, onuKey } from "./rows";
import { InMemoryOnuStore } from "./store";

const DEMO = "GLOBAL#isp-demo";
const SERIAL = "DEMO3F2C19A0";
const NOW = "2026-09-26T10:00:00.000Z";

function urlEvent(overrides: Partial<LambdaFunctionURLEvent> & { method?: string } = {}): LambdaFunctionURLEvent {
  const { method = "GET", ...rest } = overrides;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: `/v1/onus/${SERIAL}`,
    rawQueryString: "",
    headers: { "x-world": DEMO, "x-world-time": "2026-10-13T09:20:00-06:00", "x-caller": "CONSOLE" },
    isBase64Encoded: false,
    requestContext: {
      accountId: "000000000000",
      apiId: "url",
      domainName: "abc.lambda-url.us-east-1.on.aws",
      domainPrefix: "abc",
      http: { method, path: `/v1/onus/${SERIAL}`, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "req-1",
      routeKey: "$default",
      stage: "$default",
      time: "26/Sep/2026:10:00:00 +0000",
      timeEpoch: 0,
    },
    ...rest,
  } as LambdaFunctionURLEvent;
}

function seededStore(): InMemoryOnuStore {
  const store = new InMemoryOnuStore();
  store.put(newOnuRow({ clockId: DEMO, serial: SERIAL, behaviour: "LOS_THEN_ONLINE", nowIso: NOW }));
  return store;
}

describe("Function URL handler", () => {
  it("decodes a base64 body and keeps method, path and headers", () => {
    const request = toMockRequest(urlEvent({ method: "POST", body: Buffer.from('{"kind":"INSTALLER_STEP"}').toString("base64"), isBase64Encoded: true }));
    expect(request).toMatchObject({ method: "POST", path: `/v1/onus/${SERIAL}`, body: '{"kind":"INSTALLER_STEP"}' });
    expect(request.headers["x-world"]).toBe(DEMO);
  });

  it("answers through the routes and logs the route with the end of the serial only", async () => {
    const lines: string[] = [];
    const handler = createHandler(() => ({ store: seededStore(), now: () => new Date(NOW), sleep: async () => undefined }), (line) => lines.push(line));
    const result = await handler(urlEvent());
    expect(result).toMatchObject({ statusCode: 200, headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(result.body))).toMatchObject({ serial: SERIAL, operState: "LOS" });
    expect(lines).toHaveLength(1);
    const log = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(log).toMatchObject({ route: "/v1/onus/{serial}", clockId: DEMO, serialTail: "19A0", status: 200, correlationId: "req-1" });
    expect(lines[0]).not.toContain(SERIAL);
  });

  it("logs with the caller's correlation id when it looks like one, and never an unvalidated world", async () => {
    const lines: string[] = [];
    const handler = createHandler(() => ({ store: seededStore(), now: () => new Date(NOW), sleep: async () => undefined }), (line) => lines.push(line));
    const headers = { "x-world": DEMO, "x-world-time": "2026-10-13T09:20:00-06:00", "x-caller": "HARNESS" };
    await handler(urlEvent({ headers: { ...headers, "x-correlation-id": "3f1c9a2e-7b4d-4e8f-9a01-5c6d7e8f9a0b" } }));
    await handler(urlEvent({ headers: { ...headers, "x-correlation-id": "bad value\n{injected}", "x-world": "GLOBAL#<script>" } }));
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toMatchObject({ correlationId: "3f1c9a2e-7b4d-4e8f-9a01-5c6d7e8f9a0b", clockId: DEMO });
    expect(second).toMatchObject({ correlationId: "req-1", status: 400 });
    expect(second?.clockId).toBeUndefined();
  });

  it("turns an unexpected failure into a 500 without leaking its message", async () => {
    const lines: string[] = [];
    const broken = { get: vi.fn(), countFault: vi.fn(), replace: vi.fn(), countRead: vi.fn(async () => Promise.reject(new Error(`table exploded for ${SERIAL}`))) };
    const handler = createHandler(() => ({ store: broken, now: () => new Date(NOW), sleep: async () => undefined }), (line) => lines.push(line));
    const result = await handler(urlEvent());
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain("exploded");
    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual(["error", "warn"]);
    expect(lines.join("\n")).not.toContain("exploded");
    expect(lines.join("\n")).not.toContain(SERIAL);
  });
});

type Sent = GetCommand | UpdateCommand;

function fakeClient(answer: (command: Sent) => Promise<{ Item?: Record<string, unknown>; Attributes?: Record<string, unknown> }>) {
  const sent: Sent[] = [];
  const client: DocumentSender = {
    send: async (command) => {
      sent.push(command);
      return answer(command);
    },
  };
  return { client, sent };
}

const conditionFailed = () => new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
const ROW = newOnuRow({ clockId: DEMO, serial: SERIAL, behaviour: "LOW_POWER_THEN_OK", nowIso: NOW });

describe("DynamoOnuStore", () => {
  it("counts a read with ADD only, per reader, and returns the stored row", async () => {
    const { client, sent } = fakeClient(async () => ({ Attributes: { ...ROW, queryCount: 1, queryCountConsole: 1 } }));
    const row = await new DynamoOnuStore(client, "Network").countRead(onuKey(DEMO, SERIAL), "CONSOLE");
    expect(row).toMatchObject({ queryCount: 1, queryCountConsole: 1, behaviour: "LOW_POWER_THEN_OK" });
    const input = sent[0]?.input as UpdateCommand["input"];
    expect(input).toMatchObject({
      TableName: "Network",
      Key: { PK: `ONU#${DEMO}#${SERIAL}`, SK: "META" },
      UpdateExpression: "ADD queryCount :one, #reader :one",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#reader": "queryCountConsole" },
      ReturnValues: "ALL_NEW",
    });
    expect(input.UpdateExpression).not.toMatch(/SET|REMOVE|behaviour|fixed|version/);
  });

  it("returns undefined for an ONU the world does not have, and rethrows anything else", async () => {
    const missing = fakeClient(async () => Promise.reject(conditionFailed()));
    expect(await new DynamoOnuStore(missing.client, "Network").countRead(onuKey(DEMO, SERIAL), undefined)).toBeUndefined();
    expect((missing.sent[0]?.input as UpdateCommand["input"]).ExpressionAttributeNames).toBeUndefined();
    await new DynamoOnuStore(missing.client, "Network").countFault(onuKey(DEMO, SERIAL));
    const throttled = fakeClient(async () => Promise.reject(Object.assign(new Error("slow down"), { name: "ProvisionedThroughputExceededException" })));
    await expect(new DynamoOnuStore(throttled.client, "Network").countRead(onuKey(DEMO, SERIAL), "QA")).rejects.toThrow("slow down");
    await expect(new DynamoOnuStore(throttled.client, "Network").countFault(onuKey(DEMO, SERIAL))).rejects.toThrow("slow down");
  });

  it("reads consistently and validates the row", async () => {
    const { client, sent } = fakeClient(async () => ({ Item: { ...ROW } }));
    expect(await new DynamoOnuStore(client, "Network").get(onuKey(DEMO, SERIAL))).toEqual(OnuRow.parse(ROW));
    expect(sent[0]?.input).toMatchObject({ ConsistentRead: true });
    const bad = fakeClient(async () => ({ Item: { ...ROW, behaviour: "EXPLODING" } }));
    await expect(new DynamoOnuStore(bad.client, "Network").get(onuKey(DEMO, SERIAL))).rejects.toThrow();
  });

  it("writes a world event conditionally on the version it read", async () => {
    const { client, sent } = fakeClient(async () => ({}));
    const store = new DynamoOnuStore(client, "Network");
    const fixed = { behaviour: "LOW_POWER_THEN_OK", fixed: true, fixedBy: "SUPERVISOR_FIX", fixedAtSim: "2026-10-13T12:05:00-06:00" } as const;
    expect(await store.replace(onuKey(DEMO, SERIAL), 3, fixed, NOW)).toBe(true);
    expect(sent[0]?.input).toMatchObject({
      UpdateExpression: "SET behaviour = :behaviour, fixed = :fixed, updatedAt = :updatedAt, version = :next, fixedBy = :fixedBy, fixedAtSim = :fixedAtSim",
      ConditionExpression: "version = :expected",
      ExpressionAttributeValues: { ":expected": 3, ":next": 4, ":fixedBy": "SUPERVISOR_FIX" },
    });
    await store.replace(onuKey(DEMO, SERIAL), 4, { behaviour: "ONLINE_OK", rxPowerDbm: -23.5, fixed: false }, NOW);
    expect((sent[1]?.input as UpdateCommand["input"]).UpdateExpression).toBe(
      "SET behaviour = :behaviour, fixed = :fixed, updatedAt = :updatedAt, version = :next, rxPowerDbm = :rx REMOVE fixedBy, fixedAtSim",
    );
  });

  it("reports a lost race as false", async () => {
    const { client } = fakeClient(async () => Promise.reject(conditionFailed()));
    expect(await new DynamoOnuStore(client, "Network").replace(onuKey(DEMO, SERIAL), 1, { behaviour: "ONLINE_OK", fixed: false }, NOW)).toBe(false);
  });
});

describe("rows", () => {
  it("builds the key inside the world and refuses rows that contradict it", () => {
    expect(onuKey("qa-812-1-sc-02", SERIAL)).toEqual({ PK: `ONU#qa-812-1-sc-02#${SERIAL}`, SK: "META" });
    expect(() => onuKey("GLOBAL#isp-qa-1", SERIAL)).toThrow();
    expect(OnuRow.safeParse({ ...ROW, PK: `ONU#${DEMO}#DEMO00000000` }).success).toBe(false);
    expect(OnuRow.safeParse({ ...ROW, fixed: true }).success).toBe(false);
    expect(newOnuRow({ clockId: DEMO, serial: SERIAL, behaviour: "LOS_THEN_ONLINE", fixedAtSim: "2026-10-13T09:00:00-06:00", nowIso: NOW })).toMatchObject({
      fixed: true,
      fixedBy: "DEMO_CONTROL",
      version: 1,
      queryCount: 0,
    });
  });
});
