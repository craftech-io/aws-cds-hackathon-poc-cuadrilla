import { ConnectorError } from "@cuadrilla/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_REASON } from "../auth/errors";
import { type TestContextDeps, createTestIssuer, functionUrlEvent, testContextDeps, testLambdaContext, trpcResponse } from "../auth/testing";
import { createMemoryConnector } from "../connector/index";
import { createLogger } from "../lib/log";
import type { NetworkOutcome } from "../network/client";
import type { HttpRequest, HttpResponse, HttpTransport } from "../network/sigv4";
import { type MockHealthReport, createMockHealthProbe } from "./deps";
import { createHandler } from "./handler";
import { appRouter } from "./index";
import { createContextFactory } from "./trpc";

const issuer = createTestIssuer();
const SUB = "7f1c9d2e-0000-4000-8000-00000000ae01";

describe("health of the console BFF", () => {
  let deps: TestContextDeps;
  let probes: number;
  let report: MockHealthReport;

  beforeEach(async () => {
    const data = createMemoryConnector().connector;
    await data.isps.putUser({ ispId: "isp-demo", userId: "usr-lina", role: "OPS", name: "Lina Ficticia", cognitoSub: SUB });
    probes = 0;
    report = { network: "OK", dispatch: "OK" };
    deps = testContextDeps(issuer, {
      connector: data,
      mocks: () => {
        probes += 1;
        return Promise.resolve(report);
      },
    });
  });

  const handler = () => createHandler(appRouter, createContextFactory(() => deps));
  const get = async (path: string, headers: Record<string, string> = {}) => trpcResponse(await handler()(functionUrlEvent(path, { headers }), testLambdaContext));
  const opsToken = () => issuer.idToken({ sub: SUB, userId: "usr-lina", role: "OPS", "cognito:groups": ["OPS"] });

  it("answers GET /api/health without a token, with no data of any world and without calling the mocks", async () => {
    for (const path of ["/api/health", "/api/health.live", "/health"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.body.result?.data).toEqual({ ok: true, service: "bff" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    // An invalid token does not turn the public probe into a refusal.
    expect((await get("/api/health", { authorization: "Bearer not-a-jwt" })).status).toBe(200);
    expect(probes).toBe(0);
  });

  it("answers health.ping only to a signed-in user of the registry", async () => {
    const anonymous = await get("/api/health.ping");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error?.data).toMatchObject({ reason: AUTH_REASON.TOKEN_MISSING });
    const unregistered = await get("/api/health.ping", { authorization: `Bearer ${issuer.idToken({ sub: "7f1c9d2e-0000-4000-8000-00000000ae99" })}` });
    expect(unregistered.status).toBe(403);
    expect(unregistered.body.error?.data).toMatchObject({ reason: AUTH_REASON.USER_INACTIVE });
    expect(probes).toBe(0);
  });

  it("reports both simulated systems and is ok only when both answer", async () => {
    const healthy = await get("/api/health.ping", { authorization: `Bearer ${opsToken()}` });
    expect(healthy.status).toBe(200);
    expect(healthy.body.result?.data).toEqual({ ok: true, service: "bff", mocks: { network: "OK", dispatch: "OK" } });
    report = { network: "OK", dispatch: "UNAVAILABLE" };
    const degraded = await get("/api/health.ping", { authorization: `Bearer ${opsToken()}` });
    // A mock that is down is reported, never turned into an error of the probe.
    expect(degraded.status).toBe(200);
    expect(degraded.body.result?.data).toEqual({ ok: false, service: "bff", mocks: { network: "OK", dispatch: "UNAVAILABLE" } });
    expect(probes).toBe(2);
  });
});

function response(status: number): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: status === 200 ? '{"ok":true}' : "{}" };
}

/** A dispatch transport that answers from a script and keeps every request. */
function scripted(...answers: Array<HttpResponse | Error | "hang">) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = (request, signal) => {
    requests.push(request);
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
    if (answer === "hang") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as HttpResponse);
  };
  return { transport, requests };
}

const OK: NetworkOutcome<unknown> = { kind: "OK", value: { ok: true }, attempts: 1 };
const DOWN: NetworkOutcome<unknown> = { kind: "UNAVAILABLE", reason: "HTTP_5XX", attempts: 3 };

describe("probe of the simulated systems (GET /v1/health)", () => {
  let lines: string[];
  const log = () => createLogger({ level: "debug", sink: (line) => void lines.push(line) });
  const noSleep = () => Promise.resolve();
  const network = (outcome: NetworkOutcome<unknown> | Error) => ({ health: () => (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)) });

  beforeEach(() => {
    lines = [];
  });

  it("asks the dispatch mock for GET /v1/health and reports both mocks", async () => {
    const dispatch = scripted(response(200));
    const probe = createMockHealthProbe({ network: network(OK), dispatch: dispatch.transport, sleep: noSleep });
    expect(await probe(log())).toEqual({ network: "OK", dispatch: "OK" });
    expect(dispatch.requests).toEqual([{ method: "GET", path: "/v1/health", headers: { accept: "application/json" } }]);
  });

  it("retries a 5xx, a 429 or a timeout with backoff, at most three attempts", async () => {
    const recovering = scripted(response(503), response(429), response(200));
    expect(await createMockHealthProbe({ network: network(OK), dispatch: recovering.transport, sleep: noSleep })(log())).toEqual({ network: "OK", dispatch: "OK" });
    expect(recovering.requests).toHaveLength(3);

    const hanging = scripted("hang");
    const probe = createMockHealthProbe({ network: network(OK), dispatch: hanging.transport, timeoutMs: 5, sleep: noSleep });
    expect(await probe(log())).toEqual({ network: "OK", dispatch: "UNAVAILABLE" });
    expect(hanging.requests).toHaveLength(3);
    expect(lines.some((line) => line.includes("health.mock.unavailable") && line.includes("dispatch"))).toBe(true);
  });

  it("does not retry a refusal or a mock that is not linked", async () => {
    const forbidden = scripted(response(403));
    expect(await createMockHealthProbe({ network: network(OK), dispatch: forbidden.transport, sleep: noSleep })(log())).toEqual({ network: "OK", dispatch: "UNAVAILABLE" });
    expect(forbidden.requests).toHaveLength(1);
    const unlinked = scripted(new ConnectorError("UNAVAILABLE", 'resource "DispatchMock" is not linked to this function', "DispatchMock"));
    expect(await createMockHealthProbe({ network: network(OK), dispatch: unlinked.transport, sleep: noSleep })(log())).toEqual({ network: "OK", dispatch: "UNAVAILABLE" });
    expect(unlinked.requests).toHaveLength(1);
  });

  it("never throws: an unavailable or failing orchestrator is UNAVAILABLE", async () => {
    const dispatch = scripted(response(200));
    expect(await createMockHealthProbe({ network: network(DOWN), dispatch: dispatch.transport, sleep: noSleep })(log())).toEqual({ network: "UNAVAILABLE", dispatch: "OK" });
    const failing = createMockHealthProbe({ network: network(new Error("socket hang up")), dispatch: scripted(new Error("ECONNRESET")).transport, sleep: noSleep });
    expect(await failing(log())).toEqual({ network: "UNAVAILABLE", dispatch: "UNAVAILABLE" });
  });
});
