import { describe, expect, it } from "vitest";
import { healthVerdict, rootProblems, stateInventory } from "./interim";

const SECURE = {
  "content-security-policy": "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

describe("interim smoke", () => {
  it("accepts the console root with every security header", () => {
    expect(rootProblems(200, SECURE)).toEqual([]);
  });

  it("names each missing header and a non-200 root", () => {
    expect(rootProblems(403, {})).toEqual([
      "GET / answered 403",
      "GET / has no strict Content-Security-Policy",
      "GET / has no Strict-Transport-Security",
      "GET / has no X-Frame-Options DENY",
      "GET / has no X-Content-Type-Options nosniff",
    ]);
    expect(rootProblems(200, { ...SECURE, "x-frame-options": "SAMEORIGIN" })).toEqual(["GET / has no X-Frame-Options DENY"]);
  });

  it("tells the BFF health probe from the console's fallback page", () => {
    expect(healthVerdict(200, "application/json", JSON.stringify({ result: { data: { ok: true, service: "bff" } } }))).toBe("ok");
    expect(healthVerdict(200, "text/html; charset=utf-8", "<!doctype html>")).toBe("not-deployed");
    expect(healthVerdict(503, "application/json", "{}")).toBe("failed");
    expect(healthVerdict(200, "application/json", "not json")).toBe("failed");
    expect(healthVerdict(200, "application/json", JSON.stringify({ result: { data: { ok: false } } }))).toBe("failed");
  });

  it("reads table and function names from the app's own SST state, nothing else", () => {
    const state = {
      stack: "organization/app/poc",
      latest: {
        resources: [
          { type: "aws:dynamodb/table:Table", outputs: { name: "app-poc-WorldsTable-b" } },
          { type: "aws:dynamodb/table:Table", outputs: { name: "app-poc-CasesTable-a" } },
          { type: "aws:lambda/function:Function", outputs: { name: "app-poc-BffFunction-c" } },
          { type: "aws:s3/bucket:Bucket", outputs: { bucket: "app-poc-media" } },
          { type: "aws:lambda/function:Function", outputs: {} },
          { type: "pulumi:pulumi:Stack" },
        ],
      },
    };
    expect(stateInventory(state)).toEqual({
      tables: ["app-poc-CasesTable-a", "app-poc-WorldsTable-b"],
      functions: ["app-poc-BffFunction-c"],
    });
    expect(stateInventory({ latest: { resources: [] } })).toEqual({ tables: [], functions: [] });
    expect(() => stateInventory({ stack: "x" })).toThrow(/latest.resources/);
    expect(() => stateInventory(null)).toThrow(/latest.resources/);
  });
});
