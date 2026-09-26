import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { functionUrlEvent } from "../auth/testing";
import { createLogger } from "../lib/log";
import { ANONYMOUS_IP_HEADER, ORIGIN_HEADER, VIEWER_ADDRESS_HEADER, decodedPath, guardEdge, isSignupShape, namesSignupProcedure, originMatches, viewerIpOf } from "./edge";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const KEY = "Zq3Lm8Xw2Rt7Kp4Nc9Vb1Hy6Gd5Fs0Aj+Ue/Io3Wk8E=";
const lines: string[] = [];
const deps = { originKey: () => KEY, log: () => createLogger({ level: "debug", sink: (line) => void lines.push(line) }) };

/** A request as the Router forwards it, with the viewer address behind a getter that counts reads. */
function request(rawPath: string, options: { method?: "GET" | "POST"; query?: string; origin?: string | null; anonymous?: boolean } = {}) {
  let viewerReads = 0;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.origin !== null) headers[ORIGIN_HEADER] = options.origin ?? KEY;
  if (options.anonymous) headers[ANONYMOUS_IP_HEADER] = "1";
  Object.defineProperty(headers, VIEWER_ADDRESS_HEADER, {
    enumerable: true,
    get: () => {
      viewerReads += 1;
      return "203.0.113.10:46532";
    },
  });
  const event: APIGatewayProxyEventV2 = functionUrlEvent(rawPath, { method: options.method ?? "POST", headers, ...(options.query === undefined ? {} : { query: options.query }), body: "{}" });
  return { event, viewerReads: () => viewerReads };
}

beforeEach(() => {
  lines.length = 0;
  vi.mocked(timingSafeEqual).mockClear();
});

describe("origin check [FL-114]", () => {
  it("[FL-114] refuses a request without the origin header, or with another value of the same or another length: 403 without a body", () => {
    const sameLength = `${KEY.slice(0, -2)}x=`;
    for (const origin of [null, sameLength, "short", `${KEY}extra`]) {
      const { event, viewerReads } = request("/api/health.live", { origin, method: "GET" });
      const verdict = guardEdge(event, deps);
      expect(verdict).toMatchObject({ kind: "REJECT", reason: "ORIGIN", response: { statusCode: 403, body: "" } });
      // The viewer's address is never read for a refused request.
      expect(viewerReads()).toBe(0);
    }
    const log = lines.join("\n");
    expect(log).toContain('"metric":"OriginRejected"');
    expect(log).not.toContain(KEY);
    expect(log).not.toContain(sameLength);
  });

  it("[FL-114] compares in constant time, over the SHA-256 of both values", () => {
    const { event } = request("/api/health.live", { method: "GET", origin: "not-the-key" });
    guardEdge(event, deps);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [left, right] = vi.mocked(timingSafeEqual).mock.calls[0] ?? [];
    expect([(left as Buffer).length, (right as Buffer).length]).toEqual([32, 32]);
    expect(originMatches(KEY, KEY)).toBe(true);
    expect(originMatches(undefined, KEY)).toBe(false);
    expect(originMatches("", KEY)).toBe(false);
  });

  it("[FL-114] with the right value, the header leaves the event and the viewer (and the anonymous label) reach the context", () => {
    const { event, viewerReads } = request("/api/health.live", { method: "GET", anonymous: true });
    const verdict = guardEdge(event, deps);
    expect(verdict.kind).toBe("PASS");
    if (verdict.kind !== "PASS") return;
    expect(verdict.event.headers).not.toHaveProperty(ORIGIN_HEADER);
    expect(verdict.edge).toEqual({ viewerIp: "203.0.113.10", anonymousIp: true });
    expect(viewerReads()).toBeGreaterThan(0);
  });

  it("fails closed without a usable OriginVerifyKey: 503 without a body, before anything is read", () => {
    const { event, viewerReads } = request("/api/health.live", { method: "GET" });
    for (const originKey of [() => "short-placeholder", () => { throw new Error("not linked"); }]) {
      expect(guardEdge(event, { ...deps, originKey })).toMatchObject({ kind: "REJECT", reason: "ORIGIN_KEY_UNAVAILABLE", response: { statusCode: 503, body: "" } });
    }
    expect(viewerReads()).toBe(0);
  });

  it("reads the viewer's IP from CloudFront-Viewer-Address, IPv4 and IPv6, and nothing that is not an IP", () => {
    expect(viewerIpOf("198.51.100.10:46532")).toBe("198.51.100.10");
    expect(viewerIpOf("2001:db8:85a3::8a2e:370:7334:46532")).toBe("2001:db8:85a3::8a2e:370:7334");
    expect(viewerIpOf("[2001:db8::1]:443")).toBe("2001:db8::1");
    for (const bad of [undefined, "", "198.51.100.10", "localhost:80", "999.1.1.1:80", "198.51.100.10:port"]) expect(viewerIpOf(bad)).toBeUndefined();
  });
});

describe("the one shape of the sign-up [FL-114]", () => {
  const rejected: ReadonlyArray<{ readonly rawPath: string; readonly method: "GET" | "POST"; readonly query?: string }> = [
    { rawPath: "/api/x,signup.start", method: "POST", query: "batch=1" },
    { rawPath: "/api/signup.start,signup.start", method: "POST", query: "batch=1" },
    { rawPath: "/api/%73ignup.start", method: "POST", query: "batch=1" },
    { rawPath: "/api/signup%2Estart", method: "POST", query: "batch=1" },
    { rawPath: "/api/health.live,signup.start", method: "POST", query: "batch=1" },
    { rawPath: "/api/account.deleteGuest,signup.start", method: "POST", query: "batch=1" },
    { rawPath: "/api/signup.start", method: "POST", query: "batch=1" },
    { rawPath: "/api/signup.start", method: "GET" },
    { rawPath: "/api/signup.start/", method: "POST" },
    { rawPath: "/api/%2573ignup.start", method: "POST" },
    { rawPath: "/api/SIGNUP.start", method: "POST" },
    { rawPath: "/api/signup.start", method: "POST", query: "%62atch=1" },
  ];

  it.each(rejected)("[FL-114] $method $rawPath ($query) → 400 without a body, EdgeRejected{reason=SIGNUP_SHAPE}", ({ rawPath, method, query }) => {
    const { event } = request(rawPath, { method, ...(query === undefined ? {} : { query }) });
    const verdict = guardEdge(event, deps);
    expect(verdict).toMatchObject({ kind: "REJECT", reason: "SIGNUP_SHAPE", response: { statusCode: 400, body: "" } });
    const log = lines.join("\n");
    expect(log).toContain('"metric":"EdgeRejected"');
    expect(log).toContain('"reason":"SIGNUP_SHAPE"');
    expect(log).not.toContain("signup.start");
    expect(log).not.toContain(rawPath);
  });

  it("[FL-114] POST /api/signup.start without batch passes; batches without signup. go on as before", () => {
    for (const [rawPath, method, query] of [
      ["/api/signup.start", "POST", undefined],
      ["/api/signup.start", "POST", "input=%7B%7D"],
      ["/api/health.live,brand.get", "GET", "batch=1"],
      ["/api/guest.world,clock.get", "GET", "batch=1&input=%7B%7D"],
    ] as const) {
      expect(guardEdge(request(rawPath, { method, ...(query === undefined ? {} : { query }) }).event, deps).kind).toBe("PASS");
    }
  });

  it("decodes until the path stops changing, lower-cased, and finds signup. in a list or anywhere", () => {
    expect(decodedPath("/api/%2573ignup%252Estart")).toBe("/api/signup.start");
    expect(decodedPath("/api/%E0%A4%A")).toBe("/api/%e0%a4%a");
    expect(namesSignupProcedure("/api/Health.live,%53IGNUP.start")).toBe(true);
    expect(namesSignupProcedure("/api/x.signup.y")).toBe(true);
    expect(namesSignupProcedure("/api/health.live,guest.world")).toBe(false);
    expect(isSignupShape(request("/api/signup.start").event)).toBe(true);
    expect(isSignupShape(request("/api/signup.start", { query: "batch=0" }).event)).toBe(false);
  });
});
