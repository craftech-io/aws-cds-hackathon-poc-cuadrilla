import { beforeEach, describe, expect, it } from "vitest";
import { MemoryTableClient } from "./table-client";

const NOW = "2026-10-13T13:00:00.000Z";

describe("MemoryTableClient", () => {
  let client: MemoryTableClient;

  beforeEach(async () => {
    client = new MemoryTableClient();
    await client.put("People", { PK: "PERSON#inst-rogelio", SK: "META", entity: "Person", phoneKey: "GLOBAL#isp-demo#h1", ispKindKey: "ISP#isp-demo#INSTALLER", sortName: "mendez", version: 1 });
    await client.put("People", { PK: "PERSON#inst-rogelio", SK: "CONSENT#WHATSAPP", entity: "Consent", version: 1 });
    await client.put("People", { PK: "PERSON#inst-rogelio", SK: "PROFILE", entity: "InstallerProfile", version: 1 });
    await client.put("People", { PK: "PERSON#inst-karina", SK: "META", entity: "Person", phoneKey: "GLOBAL#isp-demo#h2", ispKindKey: "ISP#isp-demo#INSTALLER", sortName: "olvera", version: 1 });
  });

  it("gets by key and returns copies, never the stored object", async () => {
    const row = await client.get("People", { PK: "PERSON#inst-rogelio", SK: "META" });
    expect(row).toMatchObject({ phoneKey: "GLOBAL#isp-demo#h1" });
    if (row) row.phoneKey = "mutated";
    expect((await client.get("People", { PK: "PERSON#inst-rogelio", SK: "META" }))?.phoneKey).toBe("GLOBAL#isp-demo#h1");
  });

  it("queries the primary index by prefix in sort order, descending and limited", async () => {
    expect((await client.query("People", { hashValue: "PERSON#inst-rogelio", range: { prefix: "CONSENT#" } })).map((row) => row.SK)).toEqual(["CONSENT#WHATSAPP"]);
    expect((await client.query("People", { hashValue: "PERSON#inst-rogelio" })).map((row) => row.SK)).toEqual(["CONSENT#WHATSAPP", "META", "PROFILE"]);
    expect((await client.query("People", { hashValue: "PERSON#inst-rogelio", descending: true, limit: 1 })).map((row) => row.SK)).toEqual(["PROFILE"]);
  });

  it("queries a GSI by its own attributes; a row without them is not in the index", async () => {
    expect((await client.query("People", { index: "GSI1", hashValue: "GLOBAL#isp-demo#h2" })).map((row) => row.PK)).toEqual(["PERSON#inst-karina"]);
    expect((await client.query("People", { index: "GSI2", hashValue: "ISP#isp-demo#INSTALLER" })).map((row) => row.sortName)).toEqual(["mendez", "olvera"]);
    await client.put("WorkOrders", { PK: "WO#wo-1", SK: "TIMER#DAY_START#a", clockDueKey: "CLOCK#c", dueAtSim: "2026-10-13T13:30:00.000Z" });
    await client.put("WorkOrders", { PK: "WO#wo-1", SK: "TIMER#DAY_START#b", dueAtSim: "2026-10-13T13:00:00.000Z" });
    expect(await client.query("WorkOrders", { index: "GSI3", hashValue: "CLOCK#c" })).toHaveLength(1);
    await expect(client.query("People", { index: "GSI1", hashValue: "x", range: { prefix: "y" } })).rejects.toThrow(/no range key/);
  });

  it("supports between, gte, lte and eq ranges", async () => {
    for (const ts of ["2026-10-01", "2026-10-05", "2026-10-09"]) await client.put("AuditLog", { PK: "ISP#isp-demo#2026-10", SK: `${ts}#x` });
    const range = (spec: Parameters<MemoryTableClient["query"]>[1]["range"]) => client.query("AuditLog", { hashValue: "ISP#isp-demo#2026-10", ...(spec ? { range: spec } : {}) });
    expect((await range({ between: ["2026-10-02", "2026-10-06"] })).map((row) => row.SK)).toEqual(["2026-10-05#x"]);
    expect(await range({ gte: "2026-10-05" })).toHaveLength(2);
    expect(await range({ lte: "2026-10-05" })).toHaveLength(1);
    expect(await range({ eq: "2026-10-01#x" })).toHaveLength(1);
  });

  it("enforces every write condition with CONFLICT", async () => {
    const key = { PK: "PERSON#inst-rogelio", SK: "META" };
    await expect(client.put("People", { ...key, version: 1 }, { ifNotExists: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.put("People", { PK: "PERSON#nobody", SK: "META" }, { ifExists: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.put("People", { ...key, version: 1 }, { ifVersion: 7 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.put("People", { ...key }, { equals: { entity: "Consent" } })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.put("People", { ...key }, { oneOf: { entity: ["Consent", "Customer"] } })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.put("People", { ...key }, { absent: ["phoneKey"] })).rejects.toMatchObject({ code: "CONFLICT" });
    await client.put("People", { ...key, entity: "Person", version: 2 }, { ifVersion: 1, equals: { entity: "Person" }, oneOf: { entity: ["Person"] }, absent: ["usedAtReal"] });
  });

  it("replaces a row only once it has expired", async () => {
    const key = { PK: "LEASE#PHONE#1", SK: "META" };
    await client.put("Runtime", { ...key, holder: "run-a", expiresAt: 100 }, { ifNotExistsOrExpiredAt: 50 });
    await expect(client.put("Runtime", { ...key, holder: "run-b", expiresAt: 200 }, { ifNotExistsOrExpiredAt: 99 })).rejects.toMatchObject({ code: "CONFLICT" });
    await client.put("Runtime", { ...key, holder: "run-b", expiresAt: 200 }, { ifNotExistsOrExpiredAt: 100 });
    expect((await client.get("Runtime", key))?.holder).toBe("run-b");
  });

  it("updates with SET/REMOVE, bumps the version; a missing row is NOT_FOUND, a failed guard CONFLICT", async () => {
    const updated = await client.update("People", { PK: "PERSON#inst-rogelio", SK: "META" }, { firstName: "Rogelio", phoneKey: null }, NOW);
    expect(updated).toMatchObject({ firstName: "Rogelio", version: 2, updatedAt: NOW });
    expect(updated.phoneKey).toBeUndefined();
    await expect(client.update("People", { PK: "PERSON#nobody", SK: "META" }, { a: 1 }, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.update("People", { PK: "PERSON#inst-rogelio", SK: "META" }, { a: 1 }, NOW, { ifVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.update("People", { PK: "PERSON#inst-rogelio", SK: "META" }, { version: 9 }, NOW)).rejects.toThrow(/stamped/);
  });

  it("increments atomically, creates the row with defaults and honours the ceiling", async () => {
    const key = { PK: "JUMP#GUEST#isp-guest-07#2026-10-13T13", SK: "META" };
    expect(await client.increment("Runtime", key, "count", 1, { updatedAt: NOW, max: 2, defaults: { entity: "Counter", expiresAt: 5 } })).toBe(1);
    expect(await client.increment("Runtime", key, "count", 1, { updatedAt: NOW, max: 2 })).toBe(2);
    await expect(client.increment("Runtime", key, "count", 1, { updatedAt: NOW, max: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await client.get("Runtime", key)).toMatchObject({ entity: "Counter", expiresAt: 5, count: 2 });
    expect(await client.increment("Runtime", key, "count", -2, { updatedAt: NOW })).toBe(0);
  });

  it("keeps string sets: ADD creates the row, DELETE of the last member drops the attribute", async () => {
    const key = { PK: "WORLDSTATE#GLOBAL#isp-demo", SK: "META" };
    await client.addToSet("Runtime", key, "inFlight", ["evt-1", "evt-2"], { updatedAt: NOW, defaults: { entity: "WorldState" } });
    await client.addToSet("Runtime", key, "inFlight", ["evt-2", "evt-3"], { updatedAt: NOW });
    expect((await client.get("Runtime", key))?.inFlight).toEqual(new Set(["evt-1", "evt-2", "evt-3"]));
    await client.removeFromSet("Runtime", key, "inFlight", ["evt-1", "evt-2", "evt-3"], { updatedAt: NOW });
    expect(await client.get("Runtime", key)).toMatchObject({ entity: "WorldState" });
    expect((await client.get("Runtime", key))?.inFlight).toBeUndefined();
    expect(await client.removeFromSet("Runtime", { PK: "WORLDSTATE#none", SK: "META" }, "inFlight", ["x"], { updatedAt: NOW })).toBeUndefined();
  });

  it("rolls back a whole transaction when one condition fails and refuses two operations on one item", async () => {
    await expect(
      client.transact(
        [
          { op: "put", table: "Cases", item: { PK: "CASE#c1", SK: "META", version: 1 }, condition: { ifNotExists: true } },
          { op: "increment", table: "Runtime", key: { PK: "COUNTER#x", SK: "META" }, attribute: "count", by: 1 },
          { op: "put", table: "People", item: { PK: "PERSON#inst-rogelio", SK: "META", version: 1 }, condition: { ifNotExists: true } },
        ],
        NOW,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await client.get("Cases", { PK: "CASE#c1", SK: "META" })).toBeUndefined();
    expect(await client.get("Runtime", { PK: "COUNTER#x", SK: "META" })).toBeUndefined();
    const twice = { op: "put", table: "Cases", item: { PK: "CASE#c1", SK: "META" } } as const;
    await expect(client.transact([twice, twice], NOW)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("turns a missing row of a transactional update into CONFLICT (condition failed)", async () => {
    await expect(client.transact([{ op: "update", table: "Cases", key: { PK: "CASE#none", SK: "META" }, patch: { a: 1 } }], NOW)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("batchPut upserts and batchDelete removes every row", async () => {
    await client.batchPut("Reference", [
      { PK: "REF#EVAL#QUESTIONS", SK: "q-A-01", version: 1 },
      { PK: "REF#EVAL#QUESTIONS", SK: "q-A-02", version: 1 },
    ]);
    expect(client.dump("Reference")).toHaveLength(2);
    await client.batchDelete("Reference", [{ PK: "REF#EVAL#QUESTIONS", SK: "q-A-01" }]);
    expect(client.dump("Reference")).toHaveLength(1);
    client.clear();
    expect(client.dump("Reference")).toHaveLength(0);
  });
});
