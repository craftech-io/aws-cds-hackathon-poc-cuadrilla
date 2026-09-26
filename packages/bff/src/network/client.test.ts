import { NetworkReader, type NetworkFault } from "@cuadrilla/network-contract";
import { CallerKind } from "@cuadrilla/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../lib/log";
import { resetResourceCache } from "../lib/resource";
import { MAX_RETRY_AFTER_MS, NETWORK_RETRIES, NETWORK_TIMEOUT_MS, createNetworkClient, networkClient, retryAfterMs, type NetworkClientDeps } from "./client";
import { sigv4Transport, type HttpRequest, type HttpResponse } from "./sigv4";

const DEMO = "GLOBAL#isp-demo";
const GUEST = "GUEST#isp-guest-07";
const QA = "qa-812-1-sc-02";
const EVAL = "eval-812-1";
const SERIAL = "DEMO3F2C19A0";
const AT = "2026-10-13T09:20:00-06:00";
const URL_BASE = "https://abc123def.lambda-url.us-east-1.on.aws/";
const CORRELATION = "corr-test-0001";

const LOS = { serial: SERIAL, adminState: "ENABLED", operState: "LOS", oltPort: "OLT-N3/1/4", observedAt: AT };
const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const unavailable = (retryAfter?: string) => json(503, { error: "temporarily unavailable" }, retryAfter === undefined ? {} : { "Retry-After": retryAfter });

type Step = HttpResponse | Error | "hang";

/** A transport that answers the scripted steps in order (the last one repeats) and records requests. */
function scripted(...steps: Step[]) {
  const requests: HttpRequest[] = [];
  const signals: AbortSignal[] = [];
  const transport = vi.fn(async (request: HttpRequest, signal: AbortSignal) => {
    requests.push(request);
    signals.push(signal);
    const step = steps[Math.min(requests.length - 1, steps.length - 1)];
    if (step === "hang") return new Promise<HttpResponse>(() => undefined);
    if (step instanceof Error || step === undefined) throw step ?? new Error("no step");
    return step;
  });
  return { transport, requests, signals };
}

function client(transport: NetworkClientDeps["transport"], extra: Partial<NetworkClientDeps> = {}) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const networkFault = vi.fn(async (_clockId: string): Promise<NetworkFault | undefined> => undefined);
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", correlationId: CORRELATION, sink: (line) => lines.push(line) });
  const instance = createNetworkClient({ transport, faults: { networkFault }, sleep, random: () => 0, logger, ...extra });
  return { instance, sleep, networkFault, lines };
}

const read = (clockId = DEMO, caller: NetworkReader = "HARNESS") => ({ clockId, serial: SERIAL, caller, atSim: AT });

afterEach(() => {
  vi.useRealTimers();
});

describe("[FL-019] reading the ONU of the order in its world", () => {
  it("[FL-019] asks for the order's serial in the caller's world, with who reads and the world's time", async () => {
    const { transport, requests } = scripted(json(200, LOS));
    const outcome = await client(transport).instance.getOnuStatus(read(DEMO, "CONSOLE"));
    expect(outcome).toEqual({ kind: "OK", value: LOS, attempts: 1 });
    expect(requests).toEqual([
      {
        method: "GET",
        path: `/v1/onus/${SERIAL}`,
        headers: { "X-World": DEMO, "X-Caller": "CONSOLE", "X-World-Time": AT, accept: "application/json", "X-Correlation-Id": CORRELATION },
      },
    ]);
  });

  it("[FL-019] signs the request with SigV4 for the Function URL and sends X-World", async () => {
    const fetch = vi.fn(async (_url: URL | string | Request, _init?: RequestInit) => new Response(JSON.stringify(LOS), { status: 200 }));
    const transport = sigv4Transport({
      baseUrl: URL_BASE,
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      fetch,
      now: () => new Date("2026-10-13T15:20:00Z"),
    });
    expect((await client(transport).instance.getOnuStatus(read())).kind).toBe("OK");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(`https://abc123def.lambda-url.us-east-1.on.aws/v1/onus/${SERIAL}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-world"]).toBe(DEMO);
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261013\/us-east-1\/lambda\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
    expect(headers.authorization).toMatch(/SignedHeaders=[^,]*\bhost\b[^,]*\bx-world\b/);
  });

  it("[FL-019] maps 404 to NOT_FOUND without retrying", async () => {
    const { transport } = scripted(json(404, { error: "unknown serial" }));
    expect(await client(transport).instance.getOnuStatus(read())).toEqual({ kind: "NOT_FOUND", attempts: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("[FL-019] never sends a serial or a world outside the contract", async () => {
    const { transport } = scripted(json(200, LOS));
    const { instance } = client(transport);
    await expect(instance.getOnuStatus({ ...read(), serial: "demo3f2c19a0" })).rejects.toThrow();
    await expect(instance.getOnuStatus({ ...read(), serial: "DEMO/../../v1/health" })).rejects.toThrow();
    await expect(instance.getOnuStatus({ ...read(), clockId: "GLOBAL#isp-qa-1" })).rejects.toThrow();
    await expect(instance.getOnuStatus({ ...read(), atSim: "today" })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("[FL-019] treats an answer outside the contract as unavailable, without retrying", async () => {
    const { transport } = scripted(json(200, { serial: SERIAL, operState: "SLEEPING", observedAt: AT }));
    const { instance, lines } = client(transport);
    expect(await instance.getOnuStatus(read())).toEqual({ kind: "UNAVAILABLE", reason: "INVALID_RESPONSE", attempts: 1 });
    expect(lines.join("\n")).toContain("outside the contract");
  });

  it("[FL-019] logs the world and the end of the serial, never the full serial", async () => {
    const { transport } = scripted(unavailable("0"));
    const { instance, lines } = client(transport);
    await instance.getOnuStatus(read());
    expect(lines.join("\n")).toContain('"serialTail":"19A0"');
    expect(lines.join("\n")).not.toContain(SERIAL);
  });
});

describe("[FL-026] timeout, retries and unavailability", () => {
  it("[FL-026] retries a 503 twice honouring Retry-After, then reports UNAVAILABLE instead of throwing", async () => {
    const { transport } = scripted(unavailable("1"));
    const { instance, sleep } = client(transport);
    expect(await instance.getOnuStatus(read())).toEqual({ kind: "UNAVAILABLE", reason: "HTTP_5XX", attempts: 1 + NETWORK_RETRIES });
    expect(NETWORK_RETRIES).toBe(2);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
  });

  it("[FL-026] recovers when a retry answers", async () => {
    const { transport } = scripted(unavailable("1"), json(200, LOS));
    expect(await client(transport).instance.getOnuStatus(read())).toEqual({ kind: "OK", value: LOS, attempts: 2 });
  });

  it("[FL-026] gives each attempt 3 s, aborts it and retries", async () => {
    vi.useFakeTimers();
    const { transport, signals } = scripted("hang");
    const pending = client(transport).instance.getOnuStatus(read());
    await vi.advanceTimersByTimeAsync(NETWORK_TIMEOUT_MS - 1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * NETWORK_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: "UNAVAILABLE", reason: "TIMEOUT", attempts: 3 });
    expect(NETWORK_TIMEOUT_MS).toBe(3_000);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("[FL-026] backs off without Retry-After and caps a long one", async () => {
    const backoff = client(scripted(unavailable(), unavailable("120"), json(200, LOS)).transport, { random: () => 0.5 });
    expect((await backoff.instance.getOnuStatus(read())).kind).toBe("OK");
    expect(backoff.sleep.mock.calls).toEqual([[100], [MAX_RETRY_AFTER_MS]]);
  });

  it("[FL-026] retries network errors and throttling, not authorization or bad requests", async () => {
    expect(await client(scripted(new TypeError("fetch failed")).transport).instance.getOnuStatus(read())).toEqual({ kind: "UNAVAILABLE", reason: "NETWORK_ERROR", attempts: 3 });
    expect(await client(scripted(json(429, {}), json(200, LOS)).transport).instance.getOnuStatus(read())).toMatchObject({ kind: "OK", attempts: 2 });
    const forbidden = scripted(json(403, { message: "Forbidden" }));
    expect(await client(forbidden.transport).instance.getOnuStatus(read())).toEqual({ kind: "UNAVAILABLE", reason: "FORBIDDEN", attempts: 1 });
    const bad = scripted(json(400, { error: "invalid serial" }));
    expect(await client(bad.transport).instance.getOnuStatus(read())).toEqual({ kind: "UNAVAILABLE", reason: "BAD_REQUEST", attempts: 1 });
  });

  it("[FL-026] reads Retry-After as seconds or as an HTTP date", () => {
    const now = Date.parse("2026-10-13T15:20:00Z");
    expect(retryAfterMs("1", now)).toBe(1000);
    expect(retryAfterMs("0", now)).toBe(0);
    expect(retryAfterMs("Tue, 13 Oct 2026 15:20:01 GMT", now)).toBe(1000);
    expect(retryAfterMs("Tue, 13 Oct 2026 15:19:00 GMT", now)).toBe(0);
    expect(retryAfterMs("3600", now)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs(undefined, now)).toBeUndefined();
  });

  it("[FL-026] reports an unlinked orchestrator as unavailable, without retrying", async () => {
    resetResourceCache();
    expect(await networkClient().getOnuStatus(read())).toEqual({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED", attempts: 1 });
  });
});

describe("[FL-026] faults are read only for qa-* worlds", () => {
  it("[FL-026] forwards the fault of a qa world to the mock", async () => {
    const { transport, requests } = scripted(unavailable("1"));
    const { instance, networkFault } = client(transport);
    networkFault.mockResolvedValue("ERROR_503");
    expect(await instance.getOnuStatus(read(QA))).toMatchObject({ kind: "UNAVAILABLE", attempts: 3 });
    expect(networkFault).toHaveBeenCalledOnce();
    expect(networkFault).toHaveBeenCalledWith(QA);
    expect(requests.every((request) => request.headers["X-Fault"] === "ERROR_503")).toBe(true);
  });

  it("[FL-026] never reads faults for demo, guest or evaluation worlds", async () => {
    const { transport, requests } = scripted(json(200, LOS));
    const { instance, networkFault } = client(transport);
    networkFault.mockResolvedValue("ERROR_503");
    for (const clockId of [DEMO, GUEST, EVAL]) expect((await instance.getOnuStatus(read(clockId))).kind).toBe("OK");
    expect(networkFault).not.toHaveBeenCalled();
    expect(requests.some((request) => "X-Fault" in request.headers)).toBe(false);
  });

  it("[FL-026] goes on without the fault when the faults cannot be read", async () => {
    const { transport, requests } = scripted(json(200, LOS));
    const { instance, networkFault, lines } = client(transport);
    networkFault.mockRejectedValue(new Error("throttled"));
    expect((await instance.getOnuStatus(read(QA))).kind).toBe("OK");
    expect(requests[0]?.headers["X-Fault"]).toBeUndefined();
    expect(lines.join("\n")).toContain("could not read the faults");
  });
});

describe("world events and health", () => {
  const CONTROL = { serial: SERIAL, behaviour: "LOS_THEN_ONLINE", fixed: true, fixedBy: "INSTALLER_STEP", fixedAtSim: AT, changed: true };

  it("posts the installer's physical action with the world's time", async () => {
    const { transport, requests } = scripted(json(200, CONTROL));
    const { instance, networkFault } = client(transport);
    networkFault.mockResolvedValue("ERROR_503");
    const outcome = await instance.reportPhysicalAction({ ...read(QA, "WORKER"), kind: "INSTALLER_STEP" });
    expect(outcome).toEqual({ kind: "OK", value: CONTROL, attempts: 1 });
    expect(requests[0]).toEqual({
      method: "POST",
      path: `/v1/onus/${SERIAL}/physical-action`,
      headers: { "X-World": QA, "X-Caller": "WORKER", "X-World-Time": AT, accept: "application/json", "X-Correlation-Id": CORRELATION },
      body: '{"kind":"INSTALLER_STEP"}',
    });
    expect(networkFault).not.toHaveBeenCalled();
  });

  it("posts the demo control and retries a conflict", async () => {
    const { transport, requests } = scripted(json(409, { error: "changed" }), json(200, { ...CONTROL, behaviour: "LOW_POWER_THEN_OK", fixedBy: "DEMO_CONTROL" }));
    const outcome = await client(transport).instance.setBehaviour({ ...read(DEMO, "CONSOLE"), change: { behaviour: "LOW_POWER_THEN_OK", fixed: true } });
    expect(outcome).toMatchObject({ kind: "OK", attempts: 2, value: { fixedBy: "DEMO_CONTROL" } });
    expect(requests[1]).toMatchObject({ path: `/v1/onus/${SERIAL}/behaviour`, body: '{"behaviour":"LOW_POWER_THEN_OK","fixed":true}' });
  });

  it("refuses events outside the control schemas before calling", async () => {
    const { transport } = scripted(json(200, CONTROL));
    const { instance } = client(transport);
    await expect(instance.setBehaviour({ ...read(), change: {} })).rejects.toThrow();
    await expect(instance.reportPhysicalAction({ ...read(), kind: "REBOOT" as never })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("probes health without world headers", async () => {
    const { transport, requests } = scripted(json(200, { status: "ok" }));
    expect(await client(transport).instance.health()).toEqual({ kind: "OK", value: { status: "ok" }, attempts: 1 });
    expect(requests[0]).toEqual({ method: "GET", path: "/v1/health", headers: { accept: "application/json", "X-Correlation-Id": CORRELATION } });
  });

  it("counts reads per principal kind: the readers are exactly the callers of the tool catalog", () => {
    expect(NetworkReader.options).toEqual(["HARNESS", ...CallerKind.options]);
  });
});
