import type { APIGatewayProxyEventV2, Context as LambdaContext } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AUTH_REASON } from "../auth/errors";
import { createUserDirectory } from "../auth/staff";
import { createTestIssuer } from "../auth/testing";
import { createLogger } from "../lib/log";
import type { ContextDeps } from "./deps";
import { createHandler, stripApiPrefix } from "./handler";
import { appRouter } from "./index";
import { createContextFactory, ispProcedure, recentLoginProcedure, router, supervisorProcedure } from "./trpc";

const issuer = createTestIssuer();
const lines: string[] = [];
const INACTIVE_SUB = "7f1c9d2e-0000-4000-8000-00000000dead";

const deps: ContextDeps = {
  verifier: issuer.verifier(),
  users: createUserDirectory({
    findBySub: async (_ispId, sub) => (sub === INACTIVE_SUB ? { userId: "usr-gone", active: false } : { userId: "usr-sup-01", active: true }),
  }),
  totp: { isTotpEnabled: () => Promise.resolve(false) },
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

const ResponseBody = z.looseObject({
  result: z.object({ data: z.unknown() }).optional(),
  error: z.looseObject({ message: z.string(), data: z.looseObject({ code: z.string(), reason: z.string().nullable(), correlationId: z.string().nullable() }) }).optional(),
});

function functionUrlEvent(rawPath: string, headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers,
    isBase64Encoded: false,
    requestContext: {
      accountId: "anonymous",
      apiId: "bff-url",
      domainName: "bff-url.lambda-url.us-east-1.on.aws",
      domainPrefix: "bff-url",
      http: { method: "GET", path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: "vitest" },
      requestId: "req-handler-0001",
      routeKey: "$default",
      stage: "$default",
      time: "18/Sep/2026:15:00:00 +0000",
      timeEpoch: 1789743600000,
    },
  };
}

const lambdaContext: LambdaContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "bff-test",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:bff-test",
  memoryLimitInMB: "512",
  awsRequestId: "lambda-req-0001",
  logGroupName: "/aws/lambda/bff-test",
  logStreamName: "2026/09/18/[$LATEST]test",
  getRemainingTimeInMillis: () => 10_000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined,
};

const handler = createHandler(testRouter, createContextFactory(() => deps));

async function call(rawPath: string, headers?: Record<string, string>) {
  const response = await handler(functionUrlEvent(rawPath, headers), lambdaContext);
  return { status: response.statusCode, headers: response.headers ?? {}, body: ResponseBody.parse(JSON.parse(response.body ?? "{}")) };
}

describe("BFF Lambda handler", () => {
  it("serves /api/<procedure> behind the Router and /<procedure> on the Function URL", async () => {
    const authorization = `Bearer ${issuer.idToken()}`;
    for (const path of ["/api/session.whoami", "/session.whoami"]) {
      const response = await call(path, { authorization });
      expect(response.status).toBe(200);
      expect(response.body.result?.data).toEqual({ ispId: "isp-demo", role: "SUPERVISOR", userId: "usr-sup-01" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("answers HTTP 401 with the reason and the correlation id when the token has no operator", async () => {
    const response = await call("/api/session.whoami", { authorization: `Bearer ${issuer.idToken({ ispId: undefined })}` });
    expect(response.status).toBe(401);
    expect(response.body.error?.data).toMatchObject({ code: "UNAUTHORIZED", reason: AUTH_REASON.PRINCIPAL_INCOMPLETE, correlationId: "req-handler-0001" });
  });

  it("answers HTTP 401 without a token and takes a well-formed x-correlation-id", async () => {
    const response = await call("/api/session.whoami", { "x-correlation-id": "console-7f1c9d2e" });
    expect(response.status).toBe(401);
    expect(response.body.error?.data).toMatchObject({ reason: AUTH_REASON.TOKEN_MISSING, correlationId: "console-7f1c9d2e" });
  });

  it("refuses an inactive user, OPS on supervisor procedures and an old sign-in on manual validation", async () => {
    const inactive = await call("/api/session.whoami", { authorization: `Bearer ${issuer.idToken({ sub: INACTIVE_SUB })}` });
    expect(inactive.status).toBe(403);
    expect(inactive.body.error?.data).toMatchObject({ reason: AUTH_REASON.USER_INACTIVE });
    const ops = await call("/api/session.supervisorOnly", { authorization: `Bearer ${issuer.idToken({ role: "OPS", "cognito:groups": ["OPS"] })}` });
    expect(ops.status).toBe(403);
    expect(ops.body.error?.data).toMatchObject({ reason: AUTH_REASON.ROLE_NOT_ALLOWED });
    const judge = await call("/api/session.supervisorOnly", { authorization: `Bearer ${issuer.idToken({ role: "JUDGE", "cognito:groups": ["JUDGE"] })}` });
    expect(judge.status).toBe(200);
    const old = Math.floor(Date.now() / 1000) - 16 * 60;
    const stale = await handler(
      { ...functionUrlEvent("/api/session.validate", { authorization: `Bearer ${issuer.idToken({ auth_time: old })}`, "content-type": "application/json" }), body: "{}", requestContext: { ...functionUrlEvent("/").requestContext, http: { ...functionUrlEvent("/").requestContext.http, method: "POST" } } },
      lambdaContext,
    );
    expect(stale.statusCode).toBe(403);
    expect(ResponseBody.parse(JSON.parse(stale.body ?? "{}")).error?.data).toMatchObject({ reason: AUTH_REASON.LOGIN_NOT_RECENT });
  });

  it("never sends a stack trace and logs unexpected failures with the correlation id", async () => {
    lines.length = 0;
    const response = await handler(functionUrlEvent("/api/session.boom", { authorization: `Bearer ${issuer.idToken()}` }), lambdaContext);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("stack");
    expect(lines.map((line) => z.looseObject({ message: z.string(), correlationId: z.string() }).parse(JSON.parse(line)))).toContainEqual(
      expect.objectContaining({ message: "console.procedure.failed", correlationId: "req-handler-0001", path: "session.boom" }),
    );
  });

  it("the console router answers the public health probe and 404 for an unknown procedure", async () => {
    const bff = createHandler(appRouter, createContextFactory(() => deps));
    const health = await bff(functionUrlEvent("/api/health"), lambdaContext);
    expect(health.statusCode).toBe(200);
    expect(ResponseBody.parse(JSON.parse(health.body ?? "{}")).result?.data).toEqual({ ok: true, service: "bff" });
    const unknown = await bff(functionUrlEvent("/api/nothing.here"), lambdaContext);
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
  ])("%s → %s", (rawPath, expected) => {
    const event = stripApiPrefix(functionUrlEvent(rawPath));
    expect(event.rawPath).toBe(expected);
    expect(event.requestContext.http.path).toBe(expected);
  });
});
