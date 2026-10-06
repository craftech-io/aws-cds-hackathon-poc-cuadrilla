import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpTransport } from "../../network/sigv4";
import { createDispatchControlClient } from "./dispatch-client";

const BODY = { ispId: "isp-demo", reason: "OTHER" as const, occurredAtSim: "2026-10-13T09:20:00-06:00", idempotencyKey: "con:click-1" };

function scripted(...answers: Array<Error | { status: number; body: string }>) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    const next = answers.shift();
    if (next === undefined || next instanceof Error) throw next ?? new Error("no answer");
    return { status: next.status, headers: {}, body: next.body };
  };
  return { requests, client: createDispatchControlClient({ transport, sleep: async () => undefined }) };
}

describe("dispatch control client", () => {
  it("posts the command to the order's control route with its correlation id", async () => {
    const { requests, client } = scripted({ status: 404, body: JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "unknown work order" } }) });
    expect(await client.command("cancel", "24817", BODY, "corr-1")).toEqual({ kind: "REFUSED", code: "NOT_FOUND", message: "unknown work order" });
    expect(requests).toMatchObject([{ method: "POST", path: "/v1/work-orders/24817/cancel", headers: { "x-correlation-id": "corr-1" } }]);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual(BODY);
  });

  it("retries a network failure and a 5xx, then answers what the third attempt says", async () => {
    const conflict = { ok: false, error: { code: "CONFLICT", message: "the order is cancelled", reason: "ORDER_CANCELLED" } };
    const { requests, client } = scripted(new Error("socket hang up"), { status: 502, body: "" }, { status: 409, body: JSON.stringify(conflict) });
    expect(await client.command("cancel", "24817", BODY)).toEqual({ kind: "REFUSED", code: "CONFLICT", message: "the order is cancelled", reason: "ORDER_CANCELLED" });
    expect(requests).toHaveLength(3);
  });

  it("an answer outside the contract or exhausted attempts are UNAVAILABLE, never an exception", async () => {
    expect(await scripted({ status: 200, body: "{\"ok\":true}" }).client.command("cancel", "24817", BODY)).toEqual({ kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" });
    expect(await scripted({ status: 400, body: "not json" }).client.command("cancel", "24817", BODY)).toEqual({ kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" });
    const failing = scripted(new Error("a"), new Error("b"), new Error("c"));
    expect(await failing.client.command("cancel", "24817", BODY)).toEqual({ kind: "UNAVAILABLE", reason: "TIMEOUT_OR_NETWORK" });
    expect(failing.requests).toHaveLength(3);
  });
});
