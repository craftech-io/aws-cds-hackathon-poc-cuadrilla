import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTH_REASON } from "../auth/errors";
import { createUserDirectory } from "../auth/staff";
import { type TestRequest, createTestIssuer, functionUrlEvent, testLambdaContext, trpcResponse } from "../auth/testing";
import { createMemoryConnector } from "../connector/index";
import { createLogger } from "../lib/log";
import type { ContextDeps } from "./deps";
import { stripApiPrefix } from "./api-path";
import { createHandler } from "./handler";
import { appRouter } from "./index";
import { INTERNAL_ERROR_MESSAGE, createContextFactory, ispProcedure, recentLoginProcedure, router, supervisorProcedure } from "./trpc";

const issuer = createTestIssuer();
const lines: string[] = [];
const INACTIVE_SUB = "7f1c9d2e-0000-4000-8000-00000000dead";
const REQUEST_ID = "req-handler-0001";

const deps: ContextDeps = {
  verifier: issuer.verifier(),
  connector: createMemoryConnector().connector,
  mocks: () => Promise.resolve({ network: "OK", dispatch: "OK" }),
  users: createUserDirectory({
    findBySub: async (_ispId, sub) => (sub === INACTIVE_SUB ? { userId: "usr-gone", active: false } : { userId: "usr-sup-01", active: true }),
  }),
  wallClock: () => new Date(),
  loggerFor: (correlationId) => createLogger({ correlationId, sink: (line) => void lines.push(line) }),
};

const testRouter = router({
  session: router({
    whoami: ispProcedure.query(({ ctx }) => ({ ispId: ctx.principal.ispId, role: ctx.principal.role, userId: ctx.principal.userId })),
    supervisorOnly: supervisorProcedure.query(() => "ok"),
    validate: recentLoginProcedure.mutation(() => "validated"),
    boom: ispProcedure.query(() => {
      throw new Error("connection string leaked here");
    }),
  }),
});

const handler = createHandler(testRouter, createContextFactory(() => deps));

async function call(rawPath: string, request: TestRequest = {}) {
  return trpcResponse(await handler(functionUrlEvent(rawPath, { requestId: REQUEST_ID, ...request }), testLambdaContext));
}

const bearer = (claims?: Record<string, unknown>) => ({ authorization: `Bearer ${issuer.idToken(claims)}` });

describe("BFF Lambda handler", () => {
  it("serves /api/<procedure> behind the Router and /<procedure> on the Function URL", async () => {
    for (const path of ["/api/session.whoami", "/session.whoami"]) {
      const response = await call(path, { headers: bearer() });
      expect(response.status).toBe(200);
      expect(response.body.result?.data).toEqual({ ispId: "isp-demo", role: "SUPERVISOR", userId: "usr-sup-01" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("answers HTTP 401 with the reason and the correlation id when the token has no operator", async () => {
    const response = await call("/api/session.whoami", { headers: bearer({ ispId: undefined }) });
    expect(response.status).toBe(401);
    expect(response.body.error?.data).toMatchObject({ code: "UNAUTHORIZED", reason: AUTH_REASON.PRINCIPAL_INCOMPLETE, correlationId: REQUEST_ID });
  });

  it("answers HTTP 401 without a token and takes a well-formed x-correlation-id", async () => {
    const response = await call("/api/session.whoami", { headers: { "x-correlation-id": "console-7f1c9d2e" } });
    expect(response.status).toBe(401);
    expect(response.body.error?.data).toMatchObject({ reason: AUTH_REASON.TOKEN_MISSING, correlationId: "console-7f1c9d2e" });
  });

  it("refuses an inactive user, OPS on supervisor procedures and an old sign-in on manual validation", async () => {
    const inactive = await call("/api/session.whoami", { headers: bearer({ sub: INACTIVE_SUB }) });
    expect(inactive.status).toBe(403);
    expect(inactive.body.error?.data).toMatchObject({ reason: AUTH_REASON.USER_INACTIVE });
    const ops = await call("/api/session.supervisorOnly", { headers: bearer({ role: "OPS", "cognito:groups": ["OPS"] }) });
    expect(ops.status).toBe(403);
    expect(ops.body.error?.data).toMatchObject({ reason: AUTH_REASON.ROLE_NOT_ALLOWED });
    const guest = await call("/api/session.supervisorOnly", { headers: bearer({ role: "GUEST", ispId: "isp-guest-03", isGuest: "true", "cognito:groups": ["GUEST"] }) });
    expect(guest.status).toBe(200);
    const old = Math.floor(Date.now() / 1000) - 16 * 60;
    const stale = await call("/api/session.validate", { method: "POST", body: "{}", headers: { ...bearer({ auth_time: old }), "content-type": "application/json" } });
    expect(stale.status).toBe(403);
    expect(stale.body.error?.data).toMatchObject({ reason: AUTH_REASON.LOGIN_NOT_RECENT });
  });

  it("never sends a stack trace and logs unexpected failures with the correlation id", async () => {
    lines.length = 0;
    const response = await handler(functionUrlEvent("/api/session.boom", { requestId: REQUEST_ID, headers: bearer() }), testLambdaContext);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("stack");
    expect(response.body).not.toContain("connection string");
    expect(trpcResponse(response).body.error).toMatchObject({ message: INTERNAL_ERROR_MESSAGE, data: { code: "INTERNAL_SERVER_ERROR", correlationId: REQUEST_ID } });
    expect(lines.map((line) => z.looseObject({ message: z.string(), correlationId: z.string() }).parse(JSON.parse(line)))).toContainEqual(
      expect.objectContaining({ message: "console.procedure.failed", correlationId: REQUEST_ID, path: "session.boom" }),
    );
  });

  it("the console router answers the public health probe and 404 for an unknown procedure", async () => {
    const bff = createHandler(appRouter, createContextFactory(() => deps));
    const health = trpcResponse(await bff(functionUrlEvent("/api/health"), testLambdaContext));
    expect(health.status).toBe(200);
    expect(health.body.result?.data).toEqual({ ok: true, service: "bff" });
    const unknown = await bff(functionUrlEvent("/api/nothing.here"), testLambdaContext);
    expect(unknown.statusCode).toBe(404);
  });
});

describe("stripApiPrefix", () => {
  it.each([
    ["/api/orders.list", "/orders.list"],
    ["/api/orders.list,orders.get", "/orders.list,orders.get"],
    ["/api", "/"],
    ["/orders.list", "/orders.list"],
    ["/apiary.list", "/apiary.list"],
    ["/api/health", "/health.live"],
    ["/health", "/health.live"],
    ["/api/health.ping", "/health.ping"],
  ])("%s → %s", (rawPath, expected) => {
    const event = stripApiPrefix(functionUrlEvent(rawPath));
    expect(event.rawPath).toBe(expected);
    expect(event.requestContext.http.path).toBe(expected);
  });
});
