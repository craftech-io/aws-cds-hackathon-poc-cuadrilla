import { describe, expect, it } from "vitest";
import { condition, incrementExpression, keyCondition, omitEmpty, setExpression, updateExpression } from "./expressions";

describe("keyCondition", () => {
  it("builds a begins_with condition on the primary index", () => {
    const built = keyCondition("People", { hashValue: "PERSON#inst-rogelio", range: { prefix: "CONSENT#" } });
    expect(built.expression).toBe("#n0 = :v1 AND begins_with(#n2, :v3)");
    expect(built.names).toEqual({ "#n0": "PK", "#n2": "SK" });
    expect(built.values).toEqual({ ":v1": "PERSON#inst-rogelio", ":v3": "CONSENT#" });
    expect(built.indexName).toBeUndefined();
  });

  it("names the GSI attributes of the table and supports BETWEEN, >=, <= and =", () => {
    const due = keyCondition("WorkOrders", { index: "GSI3", hashValue: "CLOCK#GLOBAL#isp-demo", range: { lte: "2026-10-13T13:30:00.000Z" } });
    expect(due).toMatchObject({ indexName: "GSI3", expression: "#n0 = :v1 AND #n2 <= :v3", names: { "#n0": "clockDueKey", "#n2": "dueAtSim" } });
    const inbox = keyCondition("Cases", { index: "GSI3", hashValue: "ISP#isp-demo#OPEN", range: { between: ["a", "b"] } });
    expect(inbox.expression).toBe("#n0 = :v1 AND #n2 BETWEEN :v3 AND :v4");
    expect(inbox.names).toEqual({ "#n0": "ispStatusKey", "#n2": "createdAtSim" });
    expect(keyCondition("AuditLog", { index: "GSI2", hashValue: "x", range: { gte: "2026" } }).expression).toBe("#n0 = :v1 AND #n2 >= :v3");
    expect(keyCondition("WorkOrders", { index: "GSI2", hashValue: "x", range: { eq: "CLOSED" } }).names).toEqual({ "#n0": "ispDayKey", "#n2": "status" });
  });

  it("rejects a range on an index without range key and an index the table does not have", () => {
    expect(() => keyCondition("People", { index: "GSI1", hashValue: "x", range: { prefix: "y" } })).toThrow(/no range key/);
    expect(() => keyCondition("Runtime", { index: "GSI1", hashValue: "x" })).toThrow(/has no index/);
  });
});

describe("condition", () => {
  it("is empty without constraints", () => {
    expect(condition(undefined).expression).toBeUndefined();
    expect(omitEmpty(condition(undefined).names)).toBeUndefined();
  });

  it("combines existence, version, equality, membership and absence", () => {
    const built = condition({ ifExists: true, ifVersion: 3, equals: { rungVersion: 2 }, oneOf: { status: ["OPEN", "TAKEN"] }, absent: ["usedAtReal"] });
    expect(built.expression).toBe("attribute_exists(#n0) AND #n1 = :v2 AND #n3 = :v4 AND #n5 IN (:v6, :v7) AND attribute_not_exists(#n8)");
    expect(built.names).toEqual({ "#n0": "PK", "#n1": "version", "#n3": "rungVersion", "#n5": "status", "#n8": "usedAtReal" });
    expect(built.values).toEqual({ ":v2": 3, ":v4": 2, ":v6": "OPEN", ":v7": "TAKEN" });
  });

  it("lets an expired row be replaced (leases, codes, idempotency)", () => {
    const built = condition({ ifNotExistsOrExpiredAt: 1_760_000_000 });
    expect(built.expression).toBe("(attribute_not_exists(#n0) OR #n1 <= :v2)");
    expect(built.names).toEqual({ "#n0": "PK", "#n1": "expiresAt" });
  });

  it("refuses an empty IN list", () => {
    expect(() => condition({ oneOf: { status: [] } })).toThrow(/at least one value/);
  });
});

describe("updateExpression", () => {
  it("SETs values, REMOVEs nulls, bumps the version and stamps updatedAt", () => {
    const built = updateExpression({ status: "TAKEN", takenBy: "sup-hector", takenByKey: null, skipped: undefined }, "2026-10-13T18:00:00.000Z", { ifVersion: 2 });
    expect(built.expression).toBe("SET #n0 = :v1, #n2 = :v3, #n5 = :v6, #n7 = if_not_exists(#n7, :v8) + :v9 REMOVE #n4");
    expect(built.names).toMatchObject({ "#n0": "status", "#n2": "takenBy", "#n4": "takenByKey", "#n5": "updatedAt", "#n7": "version" });
    expect(built.conditionExpression).toBe("#n7 = :v10");
    expect(built.values[":v10"]).toBe(2);
  });

  it("refuses to touch the key or the stamped attributes", () => {
    expect(() => updateExpression({ PK: "x" }, "now", undefined)).toThrow(/immutable/);
    expect(() => updateExpression({ version: 9 }, "now", undefined)).toThrow(/stamped/);
  });
});

describe("incrementExpression", () => {
  it("ADDs the counter with a ceiling and if_not_exists defaults", () => {
    const built = incrementExpression("count", 1, "2026-10-13T13:00:00.000Z", 30, { entity: "Counter", expiresAt: 123, ignored: undefined });
    expect(built.expression).toBe("ADD #n0 :v1 SET #n2 = :v3, #n4 = if_not_exists(#n4, :v5), #n6 = if_not_exists(#n6, :v7)");
    expect(built.conditionExpression).toBe("(attribute_not_exists(#n0) OR #n0 <= :v8)");
    expect(built.values[":v8"]).toBe(29);
  });

  it("has no condition without a ceiling and refuses a step above it", () => {
    expect(incrementExpression("count", -1, "now", undefined, undefined).conditionExpression).toBeUndefined();
    expect(() => incrementExpression("count", 5, "now", 3, undefined)).toThrow(/exceeds the ceiling/);
  });
});

describe("setExpression", () => {
  it("ADDs members as a string set with defaults for a new row", () => {
    const built = setExpression("ADD", "inFlight", ["evt-1"], "2026-10-13T13:00:00.000Z", { entity: "WorldState" }, undefined);
    expect(built.expression).toBe("ADD #n0 :v1 SET #n2 = :v3, #n4 = if_not_exists(#n4, :v5)");
    expect(built.values[":v1"]).toEqual(new Set(["evt-1"]));
    expect(built.conditionExpression).toBeUndefined();
  });

  it("DELETEs members under an existence condition and refuses an empty set", () => {
    const built = setExpression("DELETE", "inFlight", ["evt-1", "evt-2"], "now", undefined, { ifExists: true });
    expect(built.expression).toBe("DELETE #n0 :v1 SET #n2 = :v3");
    expect(built.conditionExpression).toBe("attribute_exists(#n4)");
    expect(() => setExpression("ADD", "inFlight", [], "now", undefined, undefined)).toThrow(/at least one value/);
  });
});
