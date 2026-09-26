import { beforeEach, describe, expect, it } from "vitest";
import { COUNTER_KEYS } from "../keys";
import { CLOCK, HASH_A, HASH_B, ISP, QA_CLOCK, QA_ISP, testConnector } from "../testing";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const JUDGE = "JUDGE#isp-judge-07";
const session = { sessionId: "01J9ZQX0000000000000000000", turnId: "turn-1", ispId: ISP, installerId: "inst-rogelio", workOrderId: "wo-24817", trigger: "INSTALLER_MESSAGE" as const, clockId: CLOCK, eventAtSim: "2026-10-13T09:20:00-06:00" };

describe("runtime state over the memory connector", () => {
  let world: ReturnType<typeof testConnector>;

  beforeEach(() => {
    world = testConnector();
  });

  it("keeps a session for an hour and closes its turn", async () => {
    await world.connector.runtime.putSession(session);
    await expect(world.connector.runtime.putSession(session)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await world.connector.runtime.getSession(session.sessionId)).toMatchObject({ installerId: "inst-rogelio", workOrderId: "wo-24817" });
    expect(await world.connector.runtime.getTurn("turn-1")).toBeUndefined();
    expect((await world.connector.runtime.closeTurn("turn-1", { stopReason: "end_turn" })).closedAtReal).toBe(world.now().toISOString());
    world.advance(HOUR);
    expect(await world.connector.runtime.getSession(session.sessionId)).toBeUndefined();
  });

  it("stores the tool results of a turn with a sequence per tool", async () => {
    await world.connector.runtime.putTurnResult("turn-1", "get_onu_status", { operState: "LOS" });
    await world.connector.runtime.putTurnResult("turn-1", "search_procedures", { coverage: "FOUND" });
    const second = await world.connector.runtime.putTurnResult("turn-1", "get_onu_status", { operState: "ONLINE" });
    expect(second.seq).toBe(2);
    expect((await world.connector.runtime.listTurnResults("turn-1")).map((result) => `${result.tool}#${result.seq}`)).toEqual(["get_onu_status#1", "get_onu_status#2", "search_procedures#1"]);
    expect(await world.connector.runtime.listTurnResults("turn-1", "search_procedures")).toHaveLength(1);
  });

  it("resolves a nonce while valid, counts its taps and expires it on demand", async () => {
    const nonce = { nonce: "n0nce-01J9ZQX", clockId: CLOCK, phoneHash: HASH_A, personId: "sup-hector", action: "TAKE_CASE" as const, object: { kind: "CASE" as const, id: "case-01J9ZQX0000000000000000000" } };
    await world.connector.runtime.putNonce(nonce);
    expect((await world.connector.runtime.useNonce(nonce.nonce)).useCount).toBe(1);
    await world.connector.runtime.expireNonce(nonce.nonce);
    expect(await world.connector.runtime.getNonce(nonce.nonce)).toBeUndefined();
    await expect(world.connector.runtime.useNonce(nonce.nonce)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("moves a clock only from the version read and hands out epochs that never go back", async () => {
    await world.connector.runtime.createClock({ clockId: CLOCK, ispId: ISP, kind: "DEMO", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-13T07:00:00-06:00", worldEpoch: 1 });
    const moved = await world.connector.runtime.updateClock(CLOCK, { pausedSimNow: "2026-10-13T07:30:00-06:00" }, 1);
    expect(moved).toMatchObject({ version: 2, pausedSimNow: "2026-10-13T07:30:00-06:00" });
    await expect(world.connector.runtime.updateClock(CLOCK, { pausedSimNow: "2026-10-13T08:00:00-06:00" }, 1)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await world.connector.runtime.currentEpoch(CLOCK)).toBe(0);
    expect([await world.connector.runtime.nextEpoch(CLOCK), await world.connector.runtime.nextEpoch(CLOCK)]).toEqual([1, 2]);
    expect(world.client.dump("Runtime").find((row) => row.PK === `COUNTER#EPOCH#${CLOCK}`)?.expiresAt).toBeUndefined();
  });

  it("scopes a QA world's clock to a 48 h TTL", async () => {
    const clock = await world.connector.runtime.createClock({ clockId: QA_CLOCK, ispId: QA_ISP, kind: "QA", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-13T07:00:00-06:00", worldEpoch: 1 });
    expect(clock).toMatchObject({ world: "qa", expiresAt: Math.floor(world.now().getTime() / 1000) + 48 * 3600 });
  });

  it("claims an event once within its window", async () => {
    expect(await world.connector.runtime.claimIdempotency("INBOUND", "wamid.SIM.1")).toBe(true);
    expect(await world.connector.runtime.claimIdempotency("INBOUND", "wamid.SIM.1")).toBe(false);
    world.advance(7 * 24 * HOUR);
    expect(await world.connector.runtime.claimIdempotency("INBOUND", "wamid.SIM.1")).toBe(true);
  });

  it("gives a claim back so a redelivery of work that failed is claimed again", async () => {
    expect(await world.connector.runtime.claimIdempotency("INBOUND", "wamid.SIM.2")).toBe(true);
    await world.connector.runtime.releaseIdempotency("INBOUND", "wamid.SIM.2");
    expect(await world.connector.runtime.getIdempotency("INBOUND", "wamid.SIM.2")).toBeUndefined();
    expect(await world.connector.runtime.claimIdempotency("INBOUND", "wamid.SIM.2")).toBe(true);
    expect(await world.connector.runtime.claimIdempotency("INBOUND", "wamid.SIM.2")).toBe(false);
  });

  it("reserves plain counters all or nothing, gives them back, and refuses cost-cap keys", async () => {
    const jump = { counterKey: COUNTER_KEYS.jump(JUDGE, "2026-10-13T13"), kind: "JUMP" as const, by: 1, max: 2 };
    const rate = { counterKey: COUNTER_KEYS.rateReal(JUDGE, HASH_A, "2026-10-13T13"), kind: "RATE" as const, by: 1, max: 20 };
    expect(await world.connector.runtime.reserve([jump, rate])).toEqual({ ok: true, values: [1, 1] });
    expect(await world.connector.runtime.reserve([jump])).toEqual({ ok: true, values: [2] });
    expect(await world.connector.runtime.reserve([rate, jump])).toEqual({ ok: false, blockedBy: jump.counterKey });
    expect((await world.connector.runtime.getCounter(rate.counterKey))?.count).toBe(1);
    await world.connector.runtime.release([jump]);
    expect((await world.connector.runtime.getCounter(jump.counterKey))?.count).toBe(1);
    await expect(world.connector.runtime.reserve([{ counterKey: `SIMCAP#${JUDGE}#turns#2026-10-13`, kind: "COUNTER", by: 1 }])).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("reads the cost-cap counters ops/cost-caps.ts keeps, until they expire", async () => {
    const key = `SIMCAP#${JUDGE}#turns#2026-10-13`;
    const epoch = Math.floor(world.now().getTime() / 1000);
    await world.client.put("Runtime", { PK: key, SK: "META", entity: "CapCounter", used: 12, ledger: "SIMULATOR", resource: "turns", period: "DAY", capLimit: 300, expiresAt: epoch + 3600 });
    expect(await world.connector.runtime.getCapCounter(key)).toMatchObject({ used: 12, capLimit: 300 });
    world.advance(HOUR);
    expect(await world.connector.runtime.getCapCounter(key)).toBeUndefined();
    await expect(world.connector.runtime.getCapCounter(COUNTER_KEYS.jump(JUDGE, "2026-10-13T13"))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("world runtime state over the memory connector", () => {
  let world: ReturnType<typeof testConnector>;

  beforeEach(() => {
    world = testConnector();
  });

  it("marks events in flight for the installer and the world and clears them", async () => {
    await world.connector.worlds.markInFlight("inst-rogelio", CLOCK, "evt-1");
    await world.connector.worlds.markInFlight("inst-rogelio", CLOCK, "evt-2");
    await world.connector.worlds.markWorldInFlight(CLOCK, "evt-unknown");
    expect((await world.connector.worlds.getInstallerState("inst-rogelio"))?.inFlight).toEqual(["evt-1", "evt-2"]);
    expect((await world.connector.worlds.getWorldState(CLOCK))?.inFlight).toEqual(["evt-1", "evt-2", "evt-unknown"]);
    await world.connector.worlds.clearInFlight("inst-rogelio", CLOCK, "evt-1");
    await world.connector.worlds.clearInFlight("inst-rogelio", CLOCK, "evt-2");
    await world.connector.worlds.clearWorldInFlight(CLOCK, "evt-unknown");
    expect((await world.connector.worlds.getInstallerState("inst-rogelio"))?.inFlight).toEqual([]);
    expect((await world.connector.worlds.getWorldState(CLOCK))?.inFlight).toEqual([]);
  });

  it("keeps the active order and the last processing error of an installer", async () => {
    await world.connector.worlds.markInFlight("inst-rogelio", CLOCK, "evt-1");
    const active = await world.connector.worlds.setActiveWorkOrder("inst-rogelio", CLOCK, "wo-24817", "2026-10-13T09:20:00-06:00");
    expect(active).toMatchObject({ activeWorkOrderId: "wo-24817", inFlight: ["evt-1"] });
    const failed = await world.connector.worlds.setProcessError("inst-rogelio", CLOCK, { eventId: "evt-1", message: "turn failed", atReal: world.now().toISOString() });
    expect(failed.processError?.eventId).toBe("evt-1");
    expect((await world.connector.worlds.setActiveWorkOrder("inst-rogelio", CLOCK, null)).activeWorkOrderId).toBeUndefined();
    expect((await world.connector.worlds.setActiveWorkOrder("inst-karina", CLOCK, "wo-24820", "2026-10-13T09:00:00-06:00")).version).toBe(1);
  });

  it("keeps a world busy with pending emails until their first SES event or 10 real minutes", async () => {
    await world.connector.worlds.addPendingMail(CLOCK, "mail-1");
    await world.connector.worlds.addPendingMail(CLOCK, "mail-2");
    expect((await world.connector.worlds.listPendingMail(CLOCK)).open).toHaveLength(2);
    await world.connector.worlds.closePendingMail(CLOCK, "mail-1", "DELIVERY");
    world.advance(10 * MINUTE);
    const state = await world.connector.worlds.listPendingMail(CLOCK);
    expect({ open: state.open.length, stale: state.stale.map((mail) => mail.mailId) }).toEqual({ open: 0, stale: ["mail-2"] });
    expect(await world.connector.worlds.closePendingMail(CLOCK, "mail-9", "DELIVERY")).toBeUndefined();
  });

  it("leases numbers to one run at a time until they expire", async () => {
    expect(await world.connector.worlds.acquireLease("PHONE", 1, "run-a")).toBe(true);
    expect(await world.connector.worlds.acquireLease("PHONE", 1, "run-a")).toBe(true);
    expect(await world.connector.worlds.acquireLease("PHONE", 1, "run-b")).toBe(false);
    await world.connector.worlds.releaseLease("PHONE", 1, "run-b");
    expect(await world.connector.worlds.acquireLease("PHONE", 1, "run-b")).toBe(false);
    world.advance(48 * HOUR);
    expect(await world.connector.worlds.acquireLease("PHONE", 1, "run-b")).toBe(true);
    await world.connector.worlds.releaseLease("PHONE", 1, "run-b");
    expect(await world.connector.worlds.acquireLease("PHONE", 1, "run-c")).toBe(true);
  });

  it("binds a real phone once with a one-use code, lists it in the world and frees it", async () => {
    await world.connector.worlds.createJoinCode({ code: "J07-4F2K", clockId: JUDGE, personId: "inst-rogelio-j07", userId: "usr-judge-07" });
    const lease = await world.connector.worlds.bindPhoneLease("J07-4F2K", HASH_A);
    expect(lease).toMatchObject({ clockId: JUDGE, personId: "inst-rogelio-j07", joinCode: "J07-4F2K" });
    await expect(world.connector.worlds.bindPhoneLease("J07-4F2K", HASH_B)).rejects.toMatchObject({ code: "CONFLICT" });
    await world.connector.worlds.createJoinCode({ code: "J03-7QPM", clockId: "JUDGE#isp-judge-03", personId: "inst-rogelio-j03", userId: "usr-judge-03" });
    await expect(world.connector.worlds.bindPhoneLease("J03-7QPM", HASH_A)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await world.connector.worlds.getJoinCode("J03-7QPM"))?.usedAtReal).toBeUndefined();
    expect((await world.connector.worlds.touchPhoneLease(HASH_A, "2026-10-13T13:05:00.000Z")).lastInboundAtReal).toBe("2026-10-13T13:05:00.000Z");
    expect((await world.connector.worlds.listPhoneLeases(JUDGE)).map((listed) => listed.phoneHash)).toEqual([HASH_A]);
    await world.connector.worlds.deletePhoneLease(HASH_A);
    expect(await world.connector.worlds.getPhoneLease(HASH_A)).toBeUndefined();
    expect(await world.connector.worlds.listPhoneLeases(JUDGE)).toEqual([]);
    world.advance(31 * MINUTE);
    await expect(world.connector.worlds.bindPhoneLease("J03-7QPM", HASH_B)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses a simulator upload once and only while it is valid", async () => {
    const upload = { uploadId: "up-1", userId: "usr-judge-07", clockId: JUDGE, key: "sim/abcd-e1/up-1", kind: "PHOTO" as const, maxBytes: 3_500_000 };
    await world.connector.worlds.createUpload(upload);
    expect((await world.connector.worlds.useUpload("up-1")).usedAtReal).toBeDefined();
    await expect(world.connector.worlds.useUpload("up-1")).rejects.toMatchObject({ code: "CONFLICT" });
    await world.connector.worlds.createUpload({ ...upload, uploadId: "up-2" });
    world.advance(10 * MINUTE);
    await expect(world.connector.worlds.useUpload("up-2")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps a single live world", async () => {
    await world.connector.worlds.setLiveWorld(CLOCK, "OPERATOR");
    expect((await world.connector.worlds.setLiveWorld(CLOCK, "OPERATOR")).clockId).toBe(CLOCK);
    await expect(world.connector.worlds.setLiveWorld(JUDGE, "OPERATOR")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(world.connector.worlds.clearLiveWorld(JUDGE)).rejects.toMatchObject({ code: "CONFLICT" });
    await world.connector.worlds.clearLiveWorld(CLOCK);
    expect(await world.connector.worlds.getLiveWorld()).toBeUndefined();
  });

  it("writes tombstones and probes idempotently, and faults only for qa-* worlds", async () => {
    await world.connector.worlds.putTombstone({ clockId: JUDGE, worldEpoch: 3, reason: "RESET", atReal: world.now().toISOString() });
    expect((await world.connector.worlds.getTombstone(JUDGE, 3))?.reason).toBe("RESET");
    expect(await world.connector.worlds.putProbe("foreign#wamid.X")).toBe(true);
    expect(await world.connector.worlds.putProbe("foreign#wamid.X")).toBe(false);
    expect(await world.connector.worlds.getProbe("foreign#wamid.X")).toBeDefined();
    await world.connector.worlds.setFaults({ clockId: QA_CLOCK, network: "ERROR_503", knowledge: { mode: "UNAVAILABLE" } });
    expect(await world.connector.worlds.getFaults(QA_CLOCK)).toMatchObject({ network: "ERROR_503", knowledge: { mode: "UNAVAILABLE" } });
    expect(await world.connector.worlds.getFaults(CLOCK)).toBeUndefined();
    await expect(world.connector.worlds.setFaults({ clockId: CLOCK, network: "ERROR_503" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
