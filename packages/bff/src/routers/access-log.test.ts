// The access line of the BFF (ADR-0030, FL-127): one line per request with its eight fields, also for the
// requests the edge refuses and the ones that fail, and nothing sensitive on it (no body, query, token,
// authorization header, email or phone), the route and the user agent sanitized.
import { describe, expect, it, vi } from "vitest";
import { createUserDirectory } from "../auth/staff";
import { createTestIssuer, functionUrlEvent, testLambdaContext } from "../auth/testing";
import { createMemoryConnector } from "../connector/index";
import { createLogger } from "../lib/log";
import { passedGate } from "../phone/testing";
import { ACCESS_MESSAGE, ROUTE_MAX, USER_AGENT_MAX, routeOf, sanitize, withAccessLog } from "./access-log";
import type { ContextDeps } from "./deps";
import { ORIGIN_HEADER, VIEWER_ADDRESS_HEADER } from "./edge";
import { createHandler } from "./handler";
import { createContextFactory, ispProcedure, publicProcedure, router } from "./trpc";

const ORIGIN_KEY = "Zq3Lm8Xw2Rt7Kp4Nc9Vb1Hy6Gd5Fs0Aj+Ue/Io3Wk8E=";
const issuer = createTestIssuer();
const SUB = "5d0c2a7e-0000-4000-8000-00000000c0de";

const deps: ContextDeps = {
  verifier: issuer.verifier(),
  connector: createMemoryConnector().connector,
  mocks: () => Promise.resolve({ network: "OK", dispatch: "OK" }),
  users: createUserDirectory({ findBySub: async () => ({ userId: "usr-sup-01", active: true }) }),
  wallClock: () => new Date(),
  loggerFor: (correlationId) => createLogger({ correlationId, sink: () => undefined }),
  phoneGate: passedGate(),
};

const testRouter = router({
  health: router({ live: publicProcedure.query(() => "ok") }),
  session: router({ whoami: ispProcedure.query(({ ctx }) => ctx.principal.userId) }),
});

function harness() {
  const lines: Array<Record<string, unknown>> = [];
  let clock = 1_000;
  const handler = createHandler(testRouter, createContextFactory(() => deps), {
    edge: { originKey: () => ORIGIN_KEY, log: () => createLogger({ sink: () => undefined }) },
    accessLog: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>) }),
    nowMs: () => (clock += 7),
  });
  const access = () => lines.filter((line) => line.message === ACCESS_MESSAGE);
  return { handler, access, lines };
}

const viaRouter = (headers: Record<string, string> = {}) => ({ [ORIGIN_HEADER]: ORIGIN_KEY, [VIEWER_ADDRESS_HEADER]: "198.51.100.23:51432", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0", ...headers });

describe("the access line of every request [FL-127]", () => {
  it("[FL-127] carries route, method, status, ip, userAgent, sub and ms of a verified request, and nothing else of it", async () => {
    const { handler, access } = harness();
    const token = issuer.idToken({ sub: SUB });
    const event = functionUrlEvent("/api/session.whoami", { headers: viaRouter({ authorization: `Bearer ${token}`, "x-correlation-id": "corr-access-0001" }), query: "input=%7B%22email%22%3A%22ana%40example.com%22%7D" });
    const response = await handler(event, testLambdaContext);
    expect(response.statusCode).toBe(200);
    const [line] = access();
    expect(access()).toHaveLength(1);
    expect(line).toMatchObject({ level: "info", message: "access", correlationId: "corr-access-0001", route: "/api/session.whoami", method: "GET", status: 200, ip: "198.51.100.23", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0", sub: SUB, ms: 7 });
    const text = JSON.stringify(line);
    for (const secret of [token, "Bearer", "ana@example.com", "input=", ORIGIN_KEY]) expect(text).not.toContain(secret);
  });

  it("[FL-127] a public request has no sub; a token that does not verify gives none either, and its 401 is logged", async () => {
    const { handler, access } = harness();
    await handler(functionUrlEvent("/api/health.live", { headers: viaRouter() }), testLambdaContext);
    await handler(functionUrlEvent("/api/session.whoami", { headers: viaRouter({ authorization: "Bearer not-a-jwt" }) }), testLambdaContext);
    expect(access().map((line) => [line.route, line.status, line.sub])).toEqual([
      ["/api/health.live", 200, undefined],
      ["/api/session.whoami", 401, undefined],
    ]);
  });

  it("[FL-127] the edge's refusals are logged too: a call that skipped CloudFront with its own address as the caller, a sign-up in a batch with the viewer's", async () => {
    const { handler, access } = harness();
    // A forged viewer header on the Function URL is never believed.
    await handler(functionUrlEvent("/api/health.live", { method: "POST", headers: { [VIEWER_ADDRESS_HEADER]: "192.0.2.99:443" } }), testLambdaContext);
    await handler(functionUrlEvent("/api/health.live,signup.start", { method: "POST", query: "batch=1", headers: viaRouter() }), testLambdaContext);
    expect(access().map((line) => [line.route, line.method, line.status, line.ip])).toEqual([
      ["/api/health.live", "POST", 403, "203.0.113.10"],
      ["/api/health.live,signup.start", "POST", 400, "198.51.100.23"],
    ]);
  });

  it("[FL-127] an unknown route is logged with its status", async () => {
    const { handler, access } = harness();
    const response = await handler(functionUrlEvent("/api/nothing.here", { headers: viaRouter() }), testLambdaContext);
    expect(access()[0]).toMatchObject({ route: "/api/nothing.here", status: response.statusCode });
    expect(response.statusCode).toBe(404);
  });

  it("[FL-127] a handler that throws is logged as 500 and the error goes on", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const failing = withAccessLog(
      async () => {
        throw new Error("boom");
      },
      { logFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>) }), nowMs: () => 0 },
    );
    await expect(failing(functionUrlEvent("/api/session.whoami", { headers: viaRouter() }))).rejects.toThrow("boom");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ message: "access", status: 500, route: "/api/session.whoami" });
  });

  it("[FL-127] a failing logger never changes the answer", async () => {
    const wrapped = withAccessLog(async () => ({ statusCode: 204 }), {
      logFor: () => {
        throw new Error("no logger");
      },
      nowMs: () => 0,
    });
    await expect(wrapped(functionUrlEvent("/api/health.live"))).resolves.toEqual({ statusCode: 204 });
  });

  it("[FL-127] sanitizes and caps the route and the user agent, and masks a phone or an email left in the user agent", async () => {
    // Straight to the wrapper: tRPC itself refuses a header with control characters before any procedure.
    const lines: Array<Record<string, unknown>> = [];
    const handler = withAccessLog(async () => ({ statusCode: 404 }), { logFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>) }), nowMs: () => 0 });
    const access = () => lines;
    const longPath = `/api/${"a".repeat(300)}`;
    await handler(functionUrlEvent(longPath, { headers: viaRouter({ "user-agent": `bot\r\n{"message":"forged"}\u0007\u009b ana@example.com +5215512345678 ${"x".repeat(200)}` }) }));
    const [line] = access();
    expect(String(line?.route)).toHaveLength(ROUTE_MAX);
    expect(String(line?.userAgent).length).toBeLessThanOrEqual(USER_AGENT_MAX + 20);
    expect(String(line?.userAgent)).not.toMatch(/[\r\n\u0007\u009b]/);
    expect(JSON.stringify(line)).not.toContain("ana@example.com");
    expect(JSON.stringify(line)).not.toContain("5215512345678");
    expect(sanitize("a\u0000b\u001fc\u007fd\u2029e", 10)).toBe("abcde");
    expect(routeOf({ rawPath: "/api/%E0%A4%A", requestContext: functionUrlEvent("/").requestContext })).toBe("/api/%E0%A4%A");
    expect(routeOf({ rawPath: "/api/%73ignup.start", requestContext: functionUrlEvent("/").requestContext })).toBe("/api/signup.start");
  });
});

describe("the deployed handler is wrapped [FL-127]", () => {
  it("[FL-127] routers/handler.ts wraps every request with the access line", async () => {
    vi.resetModules();
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("./handler.ts", import.meta.url), "utf8");
    expect(text).toContain("return withAccessLog(handle,");
    expect(text).toMatch(/export const handler: BffHandler = createHandler\(appRouter, createContext, \{ edge: linkedEdgeGuard\(\) \}\);/);
  });
});
