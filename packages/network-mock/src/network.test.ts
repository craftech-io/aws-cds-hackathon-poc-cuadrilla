import { NETWORK_OPERATIONS, NetworkReader, OnuControlState, OnuStatus, type OnuBehaviour } from "@cuadrilla/network-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FAULT_LATENCY_MS, FAULT_TIMEOUT_MS } from "./faults";
import { newOnuRow, onuKey, readsByReader, type NewOnuRow } from "./rows";
import { handleNetworkRequest, type MockDeps, type MockResponse } from "./routes";
import { InMemoryOnuStore } from "./store";

const DEMO = "GLOBAL#isp-demo";
const GUEST = "GUEST#isp-guest-07";
const QA = "qa-812-1-sc-02";
const EVAL = "eval-812-1";
const AT = "2026-10-13T09:20:00-06:00";
const LATER = "2026-10-13T09:31:00-06:00";
const REAL_NOW = new Date("2026-09-26T10:00:00Z");

const SERIAL = "DEMO3F2C19A0";

let store: InMemoryOnuStore;
let deps: MockDeps;

function seed(rows: ReadonlyArray<Partial<NewOnuRow> & Pick<NewOnuRow, "behaviour">>): void {
  for (const row of rows) store.put(newOnuRow({ clockId: DEMO, serial: SERIAL, nowIso: REAL_NOW.toISOString(), ...row }));
}

function read(options: { serial?: string; clockId?: string; reader?: string; at?: string; headers?: Record<string, string> } = {}): Promise<MockResponse> {
  const headers: Record<string, string> = { "X-World": options.clockId ?? DEMO, "X-World-Time": options.at ?? AT, ...options.headers };
  if (options.reader !== undefined) headers["X-Caller"] = options.reader;
  return handleNetworkRequest({ method: "GET", path: `/v1/onus/${options.serial ?? SERIAL}`, headers }, deps);
}

function event(suffix: "/physical-action" | "/behaviour", body: unknown, options: { caller?: string; clockId?: string; at?: string; serial?: string } = {}) {
  const headers: Record<string, string> = { "x-world": options.clockId ?? DEMO, "x-world-time": options.at ?? LATER };
  if (options.caller !== "none") headers["x-caller"] = options.caller ?? (suffix === "/behaviour" ? "CONSOLE" : "WORKER");
  return handleNetworkRequest({ method: "POST", path: `/v1/onus/${options.serial ?? SERIAL}${suffix}`, headers, body: JSON.stringify(body) }, deps);
}

const act = (kind: string, options: { caller?: string; clockId?: string } = {}) => event("/physical-action", { kind }, options);
const control = (body: unknown, options: { caller?: string; clockId?: string } = {}) => event("/behaviour", body, options);

function status(response: MockResponse): OnuStatus {
  expect(response.status).toBe(200);
  return OnuStatus.parse(JSON.parse(response.body));
}

function state(response: MockResponse): OnuControlState {
  expect(response.status).toBe(200);
  return OnuControlState.parse(JSON.parse(response.body));
}

async function stored(clockId = DEMO, serial = SERIAL) {
  const row = await store.get(onuKey(clockId, serial));
  if (row === undefined) throw new Error("row missing");
  return row;
}

beforeEach(() => {
  store = new InMemoryOnuStore();
  deps = { store, now: () => new Date(REAL_NOW.getTime()), sleep: vi.fn(async () => undefined) };
});

describe("[FL-019] reading an ONU never changes it", () => {
  it("[FL-019] LOS_THEN_ONLINE stays LOS under reads of the agent, the console, the worker, the validator and close_installation", async () => {
    seed([{ behaviour: "LOS_THEN_ONLINE", rxPowerDbm: -21.4, oltPort: "OLT-N3/1/4" }]);
    // get_onu_status and the validator's cross-check come from the Harness; orders.onuStatus from the
    // console; the worker's probe; close_installation from the button (CHANNEL) or a QA invocation.
    const readers = ["HARNESS", "CONSOLE", "WORKER", "HARNESS", "CHANNEL", "QA", "HARNESS", "CONSOLE"];
    for (const reader of readers) {
      const answer = status(await read({ reader }));
      expect(answer).toEqual({ serial: SERIAL, adminState: "ENABLED", operState: "LOS", oltPort: "OLT-N3/1/4", observedAt: AT });
    }
    const row = await stored();
    expect(row.fixed).toBe(false);
    expect(row.version).toBe(1);
    expect(row.queryCount).toBe(readers.length);
    expect(readsByReader(row)).toEqual({ HARNESS: 3, WORKER: 1, CHANNEL: 1, CONSOLE: 2, QA: 1, SCHEDULER: 0 });
  });

  it.each<OnuBehaviour>(["ONLINE_OK", "LOS_THEN_ONLINE", "LOW_POWER", "LOW_POWER_THEN_OK", "NOT_PROVISIONED", "DYING_GASP"])(
    "[FL-019] %s answers the same after 25 reads by every reader",
    async (behaviour) => {
      seed([{ behaviour }]);
      const first = status(await read({ reader: "HARNESS" }));
      for (let index = 0; index < 25; index += 1) {
        const reader = NetworkReader.options[index % NetworkReader.options.length];
        expect(status(await read({ ...(reader === undefined ? {} : { reader }) }))).toEqual(first);
      }
      expect((await stored()).queryCount).toBe(26);
    },
  );

  it("[FL-019] counts a read without X-Caller only in the total", async () => {
    seed([{ behaviour: "ONLINE_OK" }]);
    status(await read());
    const row = await stored();
    expect(row.queryCount).toBe(1);
    expect(Object.values(readsByReader(row)).every((count) => count === 0)).toBe(true);
  });

  it("[FL-019] keeps each world's ONU apart: an event in one world leaves the same serial of another as it was", async () => {
    seed([{ behaviour: "LOS_THEN_ONLINE" }, { behaviour: "LOS_THEN_ONLINE", clockId: QA }]);
    expect(state(await act("INSTALLER_STEP", { clockId: QA })).changed).toBe(true);
    expect(status(await read({ clockId: QA })).operState).toBe("ONLINE");
    expect(status(await read({ clockId: DEMO })).operState).toBe("LOS");
    // A world that was not seeded with this ONU does not know it.
    expect((await read({ clockId: GUEST })).status).toBe(404);
  });
});

describe("[FL-019] each transition comes only from its world event", () => {
  it("[FL-019] LOS_THEN_ONLINE: a supervisor fix does nothing, the installer's step brings it ONLINE at −21.4", async () => {
    seed([{ behaviour: "LOS_THEN_ONLINE" }]);
    expect(state(await act("SUPERVISOR_FIX", { caller: "WORKER" }))).toMatchObject({ changed: false, fixed: false });
    expect(status(await read()).operState).toBe("LOS");
    const fixed = state(await act("INSTALLER_STEP"));
    expect(fixed).toMatchObject({ changed: true, fixed: true, fixedBy: "INSTALLER_STEP", fixedAtSim: LATER, behaviour: "LOS_THEN_ONLINE" });
    expect(fixed.status).toMatchObject({ operState: "ONLINE", rxPowerDbm: -21.4 });
    expect(status(await read())).toMatchObject({ operState: "ONLINE", rxPowerDbm: -21.4, txPowerDbm: 2.1, lastSeenAt: AT });
    expect(state(await act("INSTALLER_STEP")).changed).toBe(false);
    expect((await stored()).version).toBe(2);
  });

  it("[FL-019] LOW_POWER_THEN_OK: three installer steps keep −29.8, the supervisor's fix brings −22.1", async () => {
    seed([{ behaviour: "LOW_POWER_THEN_OK" }]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(state(await act("INSTALLER_STEP")).changed).toBe(false);
      expect(status(await read())).toMatchObject({ operState: "ONLINE", rxPowerDbm: -29.8 });
    }
    expect(state(await act("SUPERVISOR_FIX")).fixedBy).toBe("SUPERVISOR_FIX");
    expect(status(await read())).toMatchObject({ operState: "ONLINE", rxPowerDbm: -22.1 });
  });

  it("[FL-019] DYING_GASP: no power until the installer acts, then ONLINE at the seeded power", async () => {
    seed([{ behaviour: "DYING_GASP", rxPowerDbm: -20.7 }]);
    const before = status(await read());
    expect(before).toMatchObject({ operState: "DYING_GASP", lastSeenAt: AT });
    expect(before.rxPowerDbm).toBeUndefined();
    await act("INSTALLER_STEP");
    expect(status(await read())).toMatchObject({ operState: "ONLINE", rxPowerDbm: -20.7 });
  });

  it("[FL-019] LOW_POWER, NOT_PROVISIONED and ONLINE_OK never change with physical actions", async () => {
    seed([
      { behaviour: "LOW_POWER", serial: "DEMO3F2C1A11" },
      { behaviour: "NOT_PROVISIONED", serial: "DEMO3F2C3A01" },
      { behaviour: "ONLINE_OK", serial: "DEMO3F2C1B27", rxPowerDbm: -20.6 },
    ]);
    for (const serial of ["DEMO3F2C1A11", "DEMO3F2C3A01", "DEMO3F2C1B27"]) {
      const before = status(await read({ serial }));
      for (const kind of ["INSTALLER_STEP", "SUPERVISOR_FIX"]) expect(state(await event("/physical-action", { kind }, { serial })).changed).toBe(false);
      expect(status(await read({ serial }))).toEqual(before);
    }
    expect(status(await read({ serial: "DEMO3F2C1A11" })).rxPowerDbm).toBe(-29.8);
    expect(status(await read({ serial: "DEMO3F2C3A01" }))).toEqual({ serial: "DEMO3F2C3A01", operState: "NOT_PROVISIONED", observedAt: AT });
    expect(status(await read({ serial: "DEMO3F2C1B27" })).rxPowerDbm).toBe(-20.6);
  });

  it("[FL-019] UNKNOWN answers 404 and ignores events", async () => {
    seed([{ behaviour: "UNKNOWN" }]);
    expect((await read()).status).toBe(404);
    const answer = state(await act("INSTALLER_STEP"));
    expect(answer).toMatchObject({ changed: false, behaviour: "UNKNOWN" });
    expect(answer.status).toBeUndefined();
  });

  it("[FL-019] the demo control resolves, restarts and re-powers an ONU", async () => {
    seed([{ behaviour: "LOW_POWER_THEN_OK" }]);
    expect(state(await control({ fixed: true }))).toMatchObject({ changed: true, fixedBy: "DEMO_CONTROL", fixedAtSim: LATER });
    expect(status(await read()).rxPowerDbm).toBe(-22.1);
    expect(state(await control({ fixed: true })).changed).toBe(false);
    // Setting a behaviour restarts it from its first state.
    expect(state(await control({ behaviour: "LOS_THEN_ONLINE" }))).toMatchObject({ changed: true, fixed: false, behaviour: "LOS_THEN_ONLINE" });
    expect(status(await read()).operState).toBe("LOS");
    expect(state(await control({ behaviour: "ONLINE_OK", rxPowerDbm: -23.5 })).status).toMatchObject({ operState: "ONLINE", rxPowerDbm: -23.5 });
    expect(state(await control({ behaviour: "ONLINE_OK", rxPowerDbm: -23.5 })).changed).toBe(false);
    const row = await stored();
    expect(row.fixedBy).toBeUndefined();
    expect(row.fixedAtSim).toBeUndefined();
  });

  it("starts resolved when the world seeds `onu {fixed: true}`", async () => {
    seed([{ behaviour: "LOS_THEN_ONLINE", fixedAtSim: AT }]);
    expect(status(await read())).toMatchObject({ operState: "ONLINE", rxPowerDbm: -21.4 });
    expect(state(await act("INSTALLER_STEP")).changed).toBe(false);
  });
});

describe("world events are guarded", () => {
  beforeEach(() => seed([{ behaviour: "LOS_THEN_ONLINE" }]));

  it("accepts a physical action only from the worker, the console and QA", async () => {
    for (const caller of ["HARNESS", "CHANNEL", "SCHEDULER", "none"]) expect((await act("INSTALLER_STEP", { caller })).status).toBe(403);
    for (const caller of ["WORKER", "CONSOLE", "QA"]) expect((await act("SUPERVISOR_FIX", { caller })).status).toBe(200);
    expect((await stored()).fixed).toBe(false);
  });

  it("accepts the demo control only from the console and QA", async () => {
    for (const caller of ["WORKER", "HARNESS", "CHANNEL"]) expect((await control({ fixed: true }, { caller })).status).toBe(403);
    expect((await control({ fixed: true }, { caller: "QA" })).status).toBe(200);
  });

  it("requires the world's time, a valid body and a known ONU", async () => {
    const noTime = await handleNetworkRequest(
      { method: "POST", path: `/v1/onus/${SERIAL}/physical-action`, headers: { "x-world": DEMO, "x-caller": "WORKER" }, body: '{"kind":"INSTALLER_STEP"}' },
      deps,
    );
    expect(noTime.status).toBe(400);
    expect((await act("CLEAN_CONNECTOR")).status).toBe(400);
    expect((await event("/physical-action", "not json")).status).toBe(400);
    expect((await event("/physical-action", { kind: "INSTALLER_STEP", override: true })).status).toBe(400);
    expect((await control({})).status).toBe(400);
    expect((await event("/physical-action", { kind: "INSTALLER_STEP" }, { serial: "DEMO00000000" })).status).toBe(404);
    expect((await act("INSTALLER_STEP", { clockId: QA })).status).toBe(404);
  });
});

describe("faults only in qa-* worlds", () => {
  beforeEach(() => seed([{ behaviour: "ONLINE_OK" }, { behaviour: "ONLINE_OK", clockId: QA }]));

  it("[FL-026] ERROR_503 answers 503 with Retry-After and counts the attempt apart from the reads", async () => {
    const answer = await read({ clockId: QA, headers: { "X-Fault": "ERROR_503" } });
    expect(answer.status).toBe(503);
    expect(answer.headers["retry-after"]).toBe("1");
    const row = await stored(QA);
    expect(row.faultCount).toBe(1);
    expect(row.queryCount).toBe(0);
  });

  it("[FL-026] TIMEOUT holds the answer past the client's timeout; LATENCY answers late but answers", async () => {
    expect((await read({ clockId: QA, headers: { "X-Fault": "TIMEOUT" } })).status).toBe(503);
    expect(deps.sleep).toHaveBeenLastCalledWith(FAULT_TIMEOUT_MS);
    expect(status(await read({ clockId: QA, headers: { "X-Fault": "LATENCY" } })).operState).toBe("ONLINE");
    expect(deps.sleep).toHaveBeenLastCalledWith(FAULT_LATENCY_MS);
  });

  it("ignores a fault header in demo, guest and evaluation worlds", async () => {
    for (const clockId of [DEMO, GUEST, EVAL]) {
      if (clockId !== DEMO) seed([{ behaviour: "ONLINE_OK", clockId }]);
      expect(status(await read({ clockId, headers: { "X-Fault": "ERROR_503" } })).operState).toBe("ONLINE");
    }
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("rejects an unknown fault in a qa world and never faults a world event", async () => {
    expect((await read({ clockId: QA, headers: { "X-Fault": "EXPLODE" } })).status).toBe(400);
    const answer = await handleNetworkRequest(
      { method: "POST", path: `/v1/onus/${SERIAL}/behaviour`, headers: { "x-world": QA, "x-world-time": LATER, "x-caller": "QA", "x-fault": "ERROR_503" }, body: '{"behaviour":"LOW_POWER"}' },
      deps,
    );
    expect(state(answer).changed).toBe(true);
  });
});

describe("requests outside the happy path", () => {
  beforeEach(() => seed([{ behaviour: "ONLINE_OK" }]));

  it("serves health and rejects unknown routes and methods", async () => {
    expect(await handleNetworkRequest({ method: "GET", path: "/v1/health", headers: {} }, deps)).toMatchObject({ status: 200 });
    expect((await handleNetworkRequest({ method: "POST", path: "/v1/health", headers: {} }, deps)).status).toBe(405);
    expect((await handleNetworkRequest({ method: "DELETE", path: `/v1/onus/${SERIAL}`, headers: { "X-World": DEMO } }, deps)).status).toBe(405);
    expect((await handleNetworkRequest({ method: "GET", path: `/v1/onus/${SERIAL}/behaviour`, headers: { "X-World": DEMO } }, deps)).status).toBe(405);
    expect((await handleNetworkRequest({ method: "GET", path: "/v1/olts", headers: {} }, deps)).status).toBe(404);
    expect((await handleNetworkRequest({ method: "GET", path: `/v1/onus/${SERIAL}/reboot`, headers: {} }, deps)).status).toBe(404);
  });

  it("rejects a missing or malformed world, serial, reader or world time", async () => {
    expect((await handleNetworkRequest({ method: "GET", path: `/v1/onus/${SERIAL}`, headers: {} }, deps)).status).toBe(400);
    expect((await read({ clockId: "GLOBAL#isp-qa-1" })).status).toBe(400);
    expect((await read({ serial: "demo3f2c19a0" })).status).toBe(400);
    expect((await read({ serial: "SHORT" })).status).toBe(400);
    expect((await read({ reader: "AGENT" })).status).toBe(400);
    expect((await read({ at: "yesterday" })).status).toBe(400);
    expect((await read({ serial: "ABCDEF123456" })).status).toBe(404);
  });

  it("stamps observedAt with the world's time, or its own clock when the caller does not send it", async () => {
    expect(status(await read({ at: LATER })).observedAt).toBe(LATER);
    const answer = await handleNetworkRequest({ method: "GET", path: `/v1/onus/${SERIAL}`, headers: { "X-World": DEMO } }, deps);
    expect(status(answer).observedAt).toBe(REAL_NOW.toISOString());
  });

  it("answers the contract's route only with the contract's codes", async () => {
    const codes = new Set<number>();
    codes.add((await read()).status);
    codes.add((await read({ serial: "ABCDEF123456" })).status);
    seed([{ behaviour: "ONLINE_OK", clockId: QA }]);
    codes.add((await read({ clockId: QA, headers: { "X-Fault": "ERROR_503" } })).status);
    expect([...codes].sort()).toEqual([...NETWORK_OPERATIONS.getOnu.responses].sort());
  });
});
