// The runner's client of the `QaDriver` (no AWS): one envelope per call, transport failures retried with
// backoff under the same idempotency key (the driver replays), refusals and malformed answers not retried.
import { describe, expect, it } from "vitest";
import { type Invoke, TransportError, createDriverClient } from "./driver-client";

const ok = (result: unknown) => ({ statusCode: 200, payload: JSON.stringify({ ok: true, replayed: false, result }) });

describe("createDriverClient", () => {
  it("sends the envelope and parses the answer", async () => {
    const payloads: string[] = [];
    const invoke: Invoke = async (payload) => {
      payloads.push(payload);
      return ok({ violations: 0 });
    };
    const answer = await createDriverClient({ invoke }).call("policyAudit.run", { clockId: "qa-812-1-sc-01" }, "812-1/sc-01/999/m1");
    expect(answer).toEqual({ ok: true, replayed: false, result: { violations: 0 } });
    expect(JSON.parse(payloads[0] ?? "{}")).toEqual({ action: "policyAudit.run", idempotencyKey: "812-1/sc-01/999/m1", input: { clockId: "qa-812-1-sc-01" } });
  });

  it("retries a function error or a throttle with the same key, then gives up", async () => {
    const keys: string[] = [];
    const sleeps: number[] = [];
    let attempt = 0;
    const invoke: Invoke = async (payload) => {
      keys.push((JSON.parse(payload) as { idempotencyKey: string }).idempotencyKey);
      attempt += 1;
      if (attempt === 1) return { statusCode: 200, functionError: "Unhandled", payload: "{}" };
      if (attempt === 2) throw Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException" });
      return ok({});
    };
    const client = createDriverClient({ invoke, sleep: async (ms) => void sleeps.push(ms) });
    await expect(client.call("world.settle", { clockId: "qa-812-1-sc-01" }, "812-1/sc-01/1/m1")).resolves.toMatchObject({ ok: true });
    expect(new Set(keys)).toEqual(new Set(["812-1/sc-01/1/m1"]));
    expect(sleeps).toEqual([1000, 2000]);
    const failing = createDriverClient({ invoke: async () => ({ statusCode: 500, payload: "" }), attempts: 2, sleep: async () => undefined });
    await expect(failing.call("world.settle", {}, "812-1/sc-01/1/m2")).rejects.toBeInstanceOf(TransportError);
  });

  it("returns a refusal as an answer and never retries a malformed one", async () => {
    let calls = 0;
    const refusal = createDriverClient({
      invoke: async () => {
        calls += 1;
        return { statusCode: 200, payload: JSON.stringify({ ok: false, error: { code: "FORBIDDEN", reason: "QA_FENCE", message: "fenced" } }) };
      },
    });
    await expect(refusal.call("snapshot", {}, "812-1/sc-01/1/r1")).resolves.toMatchObject({ ok: false, error: { reason: "QA_FENCE" } });
    expect(calls).toBe(1);
    const malformed = createDriverClient({ invoke: async () => ({ statusCode: 200, payload: JSON.stringify({ result: 1 }) }), sleep: async () => undefined });
    await expect(malformed.call("snapshot", {}, "812-1/sc-01/1/r2")).rejects.toThrow();
  });
});
