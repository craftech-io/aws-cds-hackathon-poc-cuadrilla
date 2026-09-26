import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AUTH_REASON } from "../auth/errors";
import { createUserDirectory } from "../auth/staff";
import { type TestRequest, createTestIssuer, functionUrlEvent, testLambdaContext, trpcResponse } from "../auth/testing";
import { createMemoryConnector } from "../connector/index";
import { createLogger } from "../lib/log";
import { resetSecretCache } from "../lib/secrets";
import { type SignupHarness, VIEWER_IP, signupForm, signupHarness } from "../signup/testing";
import type { ContextDeps } from "./deps";
import { stripApiPrefix } from "./api-path";
import { ORIGIN_HEADER, VIEWER_ADDRESS_HEADER } from "./edge";
import { createHandler, handler as deployedHandler } from "./handler";
import { appRouter } from "./index";
import { createSignupRouter } from "./signup";
import { INTERNAL_ERROR_MESSAGE, createContextFactory, ispProcedure, publicProcedure, recentLoginProcedure, router, supervisorProcedure } from "./trpc";

// What SST links into the deployed BFF: only the origin key here; anything else throws like SST's own.
const ORIGIN_KEY = "Zq3Lm8Xw2Rt7Kp4Nc9Vb1Hy6Gd5Fs0Aj+Ue/Io3Wk8E=";
vi.mock("sst", () => ({
  Resource: new Proxy(
    {},
    {
      get(_target, name) {
        if (name === "OriginVerifyKey") return { value: ORIGIN_KEY };
        throw new Error(`${String(name)} is not linked to this function`);
      },
    },
  ),
}));

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

describe("the edge in front of the router [FL-114]", () => {
  let h: SignupHarness;
  let runs: number;
  let seenEdge: unknown;
  const edgeLines: string[] = [];

  beforeEach(() => {
    h = signupHarness();
    runs = 0;
    seenEdge = undefined;
    edgeLines.length = 0;
    resetSecretCache();
  });

  const guarded = () =>
    createHandler(
      router({
        probe: router({
          hit: publicProcedure.query(({ ctx }) => {
            runs += 1;
            seenEdge = ctx.edge;
            return "ran";
          }),
        }),
        health: router({ live: publicProcedure.query(() => ({ ok: true })) }),
        brand: router({ get: publicProcedure.query(() => ({ mode: "neutral" })) }),
        signup: createSignupRouter(() => h.ports()),
      }),
      createContextFactory(() => deps),
      { edge: { originKey: () => ORIGIN_KEY, log: () => createLogger({ sink: (line) => void edgeLines.push(line) }) } },
    );
  const viaRouter = (rawPath: string, request: TestRequest = {}) =>
    functionUrlEvent(rawPath, { ...request, headers: { [ORIGIN_HEADER]: ORIGIN_KEY, [VIEWER_ADDRESS_HEADER]: `${VIEWER_IP}:46532`, "content-type": "application/json", ...request.headers } });

  it("[FL-114] the deployed handler checks the origin: a call on the Function URL without the header gets 403 without a body", async () => {
    const direct = await deployedHandler(functionUrlEvent("/health", { headers: { [VIEWER_ADDRESS_HEADER]: "198.51.100.66:1234" } }), testLambdaContext);
    expect(direct).toMatchObject({ statusCode: 403, body: "" });
    const forged = await deployedHandler(functionUrlEvent("/api/health", { headers: { [ORIGIN_HEADER]: "forged-value" } }), testLambdaContext);
    expect(forged).toMatchObject({ statusCode: 403, body: "" });
  });

  it("[FL-114] a refused origin never reaches the router, never reads the viewer and never logs the value", async () => {
    let viewerReads = 0;
    const headers: Record<string, string> = { [ORIGIN_HEADER]: `${ORIGIN_KEY.slice(0, -2)}Q=` };
    Object.defineProperty(headers, VIEWER_ADDRESS_HEADER, { enumerable: true, get: () => ((viewerReads += 1), `${VIEWER_IP}:1`) });
    const response = await guarded()(functionUrlEvent("/api/probe.hit", { headers }), testLambdaContext);
    expect(response).toMatchObject({ statusCode: 403, body: "" });
    expect(runs).toBe(0);
    expect(viewerReads).toBe(0);
    expect(edgeLines.join("\n")).not.toContain(ORIGIN_KEY.slice(0, 20));
  });

  it("[FL-114] with the right header the router runs with the viewer in its context and without the header in the event", async () => {
    const response = trpcResponse(await guarded()(viaRouter("/api/probe.hit"), testLambdaContext));
    expect(response.status).toBe(200);
    expect(runs).toBe(1);
    expect(seenEdge).toEqual({ viewerIp: VIEWER_IP });
  });

  it.each([
    ["/api/x,signup.start", "batch=1"],
    ["/api/signup.start,signup.start", "batch=1"],
    ["/api/%73ignup.start", "batch=1"],
    ["/api/signup%2Estart", "batch=1"],
    ["/api/health.live,signup.start", "batch=1"],
    ["/api/account.deleteGuest,signup.start", "batch=1"],
    ["/api/signup.start", "batch=1"],
  ])("[FL-114] POST %s?%s → 400 without a body; no counter, lead or ticket", async (rawPath, query) => {
    const response = await guarded()(viaRouter(rawPath, { method: "POST", query, body: JSON.stringify({ 0: signupForm() }) }), testLambdaContext);
    expect(response).toMatchObject({ statusCode: 400, body: "" });
    expect(h.runtime.dump("Runtime")).toEqual([]);
    expect(h.leadTable.leads.size).toBe(0);
    expect(edgeLines.join("\n")).toContain('"reason":"SIGNUP_SHAPE"');
  });

  it("[FL-114] GET /api/signup.start and POST /api/signup.start/ → 400; POST /api/signup.start runs the sign-up", async () => {
    const input = encodeURIComponent(JSON.stringify(signupForm()));
    expect(await guarded()(viaRouter("/api/signup.start", { method: "GET", query: `input=${input}` }), testLambdaContext)).toMatchObject({ statusCode: 400, body: "" });
    expect(await guarded()(viaRouter("/api/signup.start/", { method: "POST", body: JSON.stringify(signupForm()) }), testLambdaContext)).toMatchObject({ statusCode: 400, body: "" });
    expect(h.leadTable.leads.size).toBe(0);
    const started = trpcResponse(await guarded()(viaRouter("/api/signup.start", { method: "POST", body: JSON.stringify(signupForm()) }), testLambdaContext));
    expect(started.status).toBe(200);
    expect(started.body.result?.data).toMatchObject({ username: expect.stringMatching(/^gst-/) });
    expect(h.leadTable.leads.size).toBe(1);
  });

  it("[FL-114] a batch that names no signup. procedure goes on as before", async () => {
    const response = await guarded()(viaRouter("/api/health.live,brand.get", { query: "batch=1&input=%7B%7D" }), testLambdaContext);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual([{ result: { data: { ok: true } } }, { result: { data: { mode: "neutral" } } }]);
  });
});
