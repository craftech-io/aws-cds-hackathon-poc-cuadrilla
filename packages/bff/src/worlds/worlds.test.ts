// The world factory of wave 4 (docs/build-plan.md WP-39): demo, QA and evaluation worlds, "Reiniciar
// demo", "Saltar a escena" and `world.destroy` over the memory connector with the committed templates.
import { describe, expect, it } from "vitest";
import { DEMO_CLOCK_ID, DEMO_ISP_ID, GUEST_TEST_CLOCK_ID, GUEST_TEST_ISP_ID, ToolError } from "@cuadrilla/shared";
import { COUNTER_KEYS, counterRowKey, hourKey } from "../connector/keys";
import { handleWorldJanitor } from "../handlers/world-janitor";
import { DEFAULT_OPERATOR_NAME } from "../copy/brand";
import { buildWorld } from "./factory";
import { factoryDepsOf } from "./deps";
import { jumpToScene, resetWorld } from "./rebuild";
import { COBRAND, type WorldsHarness, allRows, worldsHarness } from "./testing";
import { createWorld, destroyWorld } from "./worlds";

const at = (iso: string): string => new Date(iso).toISOString();

function rowsOf(harness: WorldsHarness, table: string, predicate: (row: Record<string, unknown>) => boolean): Array<Record<string, unknown>> {
  return allRows(harness).filter((entry) => entry.table === table && predicate(entry.row)).map((entry) => entry.row);
}

describe("demo world", () => {
  it("[FL-084] is built from the demo template at its start, paused, with the brand's name and its historical certificates rendered", async () => {
    const harness = worldsHarness({ brand: COBRAND });
    const created = await createWorld(harness.deps, { clockId: DEMO_CLOCK_ID });
    expect(created).toMatchObject({ kind: "DEMO", clockId: DEMO_CLOCK_ID, worldEpoch: 1, action: "CREATED" });
    const clock = await harness.connector.runtime.getClock(DEMO_CLOCK_ID);
    expect(clock).toMatchObject({ mode: "PAUSED", kind: "DEMO", template: "demo" });
    expect(at(clock?.pausedSimNow ?? "")).toBe(at("2026-10-13T07:00:00-06:00"));
    expect((await harness.connector.isps.getIsp(DEMO_ISP_ID))?.displayName).toBe(COBRAND.partnerDisplayName);
    expect((await harness.connector.isps.getSettings(DEMO_ISP_ID))?.whatsappMode).toBe("simulated");
    const certificates = rowsOf(harness, "WorkOrders", (row) => row.entity === "Certificate");
    expect(certificates.length).toBe(12);
    expect(certificates.every((row) => row.pdfPending === undefined && typeof row.sha256 === "string")).toBe(true);
    expect(harness.pdfs.size).toBe(12);
    await expect(createWorld(harness.deps, { clockId: DEMO_CLOCK_ID })).rejects.toThrow(/reset it/);
  });

  it("takes the operator's team phones and mailboxes only into the demo world, and keeps a bound Cognito sub on reset", async () => {
    const harness = worldsHarness({ overrides: { personPhones: { "inst-rogelio": "+525512345678" }, opsMailbox: "success+ops-live@simulator.amazonses.com" } });
    await createWorld(harness.deps, { clockId: DEMO_CLOCK_ID });
    const rogelio = await harness.connector.people.requirePerson("inst-rogelio");
    expect(rogelio.phone).toBe("+525512345678");
    expect(rogelio.phoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await harness.connector.isps.getIsp(DEMO_ISP_ID))?.opsMailbox).toBe("success+ops-live@simulator.amazonses.com");
    await harness.connector.isps.setCognitoSub(DEMO_ISP_ID, "usr-adriana", "sub-adriana");
    const reset = await resetWorld(harness.deps, { clockId: DEMO_CLOCK_ID, caller: "SEED", actor: "OPERATOR" });
    expect(reset.worldEpoch).toBe(2);
    expect((await harness.connector.isps.getUser(DEMO_ISP_ID, "usr-adriana"))?.cognitoSub).toBe("sub-adriana");
    expect((await harness.connector.workOrders.requireWorkOrder("wo-24817")).worldEpoch).toBe(2);
  });
});

describe("QA and evaluation worlds", () => {
  const RUN = "qa-812-1-sc-04";

  it("[FL-084] get their own operator, roster, customers of the simulator, Network and Dispatch rows and leased numbers and phones", async () => {
    const harness = worldsHarness();
    const created = await createWorld(harness.deps, { clockId: RUN, operations: [{ key: "a", model: "wo-24817", installer: "own" }, { key: "b", model: "wo-24818", installer: "a" }] });
    if (created.kind !== "QA") throw new Error("expected a QA world");
    const { world } = created;
    expect(world.ispId).toBe(`isp-${RUN}`);
    expect(world.operations.map((operation) => operation.installerId)).toEqual([`inst-${RUN}-a`, `inst-${RUN}-a`]);
    for (const operation of world.operations) expect(Number(operation.workOrderId.slice(3))).toBeGreaterThanOrEqual(70000);
    const isp = await harness.connector.isps.getIsp(world.ispId);
    expect(isp).toMatchObject({ kind: "QA", displayName: DEFAULT_OPERATOR_NAME });
    const roster = await harness.connector.isps.getRoster(world.ispId, "crew-n3", "2026-10-13");
    expect(roster).toMatchObject({ primaryId: `sup-adriana-${RUN}`, secondaryId: `sup-hector-${RUN}` });
    expect((await harness.connector.isps.getZone(world.ispId, "zone-norte"))?.zoneChiefId).toBe(`zc-marisol-${RUN}`);
    for (const person of world.people.filter((entry) => entry.phone !== undefined)) expect(person.phone).toMatch(/^\+525509\d{6}$/);
    const order = await harness.connector.workOrders.requireWorkOrder(world.operations[0]?.workOrderId ?? "");
    const customer = await harness.connector.people.getCustomer(order.customerId);
    expect(customer?.email).toMatch(/^success\+qa-812-1-sc-04-a@simulator\.amazonses\.com$/);
    expect(await harness.client.get("Network", { PK: `ONU#${RUN}#${order.onuSerial}`, SK: "META" })).toMatchObject({ behaviour: "LOS_THEN_ONLINE", fixed: false });
    expect(await harness.client.get("Dispatch", { PK: `DWO#${world.ispId}#${order.workOrderNumber}`, SK: "META" })).toMatchObject({ workOrderId: order.workOrderId, installerId: order.installerId });
    expect((await harness.connector.workOrders.listChecklist(order.workOrderId)).map((item) => item.status)).toEqual(["PENDING", "PENDING", "PENDING", "PENDING", "PENDING"]);
    expect(rowsOf(harness, "Isps", (row) => row.ispId === world.ispId).every((row) => row.world === "qa" && typeof row.expiresAt === "number")).toBe(true);
    const timers = await harness.connector.timers.listDueTimers(RUN);
    expect(timers.map((timer) => timer.kind)).toEqual(["DAY_START"]);
  });

  it("answers a repeated request with the same world and refuses another request for the same clock", async () => {
    const harness = worldsHarness();
    const request = { clockId: RUN, operations: [{ key: "a", model: "wo-24820", installer: "own" }] };
    const first = await createWorld(harness.deps, request);
    const again = await createWorld(harness.deps, request);
    if (first.kind !== "QA" || again.kind !== "QA") throw new Error("expected QA worlds");
    expect(again.world).toMatchObject({ existing: true, operations: first.world.operations });
    await expect(createWorld(harness.deps, { clockId: RUN, operations: [{ key: "a", model: "wo-24821", installer: "own" }] })).rejects.toThrow(ToolError);
  });

  it("numbers an evaluation run in 80000-89999 and refuses a global caps override outside qa-*", async () => {
    const harness = worldsHarness();
    const created = await createWorld(harness.deps, { clockId: "eval-77", operations: [{ key: "q1", model: "wo-24817", installer: "own" }] });
    if (created.kind !== "EVAL") throw new Error("expected an evaluation world");
    expect(Number(created.world.operations[0]?.workOrderId.slice(3))).toBeGreaterThanOrEqual(80000);
    expect((await harness.connector.isps.getIsp("isp-eval-77"))?.kind).toBe("EVAL");
    await expect(createWorld(harness.deps, { clockId: "eval-78", operations: [{ key: "q1", model: "wo-24817", installer: "own" }], globalCapsOverride: { turnsPerDay: 1 } })).rejects.toThrow();
  });

  it("keeps a global caps override in the settings of a qa-* world only, with the request's settings", async () => {
    const harness = worldsHarness();
    await createWorld(harness.deps, { clockId: "qa-4-sc-12", operations: [{ key: "a", model: "wo-24817", installer: "own" }], settings: { demoMode: false, rateLimitPerHour: 5 }, globalCapsOverride: { turnsPerDay: 3 } });
    expect(await harness.connector.isps.getSettings("isp-qa-4-sc-12")).toMatchObject({ demoMode: false, rateLimitPerHour: 5, globalCapsOverride: { turnsPerDay: 3 }, whatsappMode: "simulated" });
  });

  it("world.create {template: guest} builds the rehearsal world with the TEST caps, and resets it when it exists", async () => {
    const harness = worldsHarness();
    expect(await createWorld(harness.deps, { clockId: GUEST_TEST_CLOCK_ID, template: "guest" })).toMatchObject({ kind: "GUEST", worldEpoch: 1, action: "CREATED" });
    expect((await harness.connector.isps.getSettings(GUEST_TEST_ISP_ID))?.simulatorCaps).toMatchObject({ messagesPerRealHourPerIdentity: 80, turnsPerHour: 180, emailsPerDay: 60 });
    expect(await harness.connector.isps.getUser(GUEST_TEST_ISP_ID, "usr-qa-guest")).toMatchObject({ role: "GUEST", guestOrigin: "TEST" });
    expect(rowsOf(harness, "Isps", (row) => row.ispId === GUEST_TEST_ISP_ID).every((row) => row.world === "qa" && row.expiresAt === undefined)).toBe(true);
    expect(await createWorld(harness.deps, { clockId: GUEST_TEST_CLOCK_ID, template: "guest" })).toMatchObject({ kind: "GUEST", worldEpoch: 2, action: "RESET" });
  });

  it("builds qa-min with its metrics fixture and rebuilds the same world on a reset", async () => {
    const harness = worldsHarness();
    await createWorld(harness.deps, { clockId: "qa-9-sc-15", template: "qa-min" });
    expect((await harness.connector.metrics.listKpis("isp-qa-9-sc-15")).map((kpi) => kpi.agentMode)).toEqual(["SCRIPTED", "SCRIPTED"]);
    const before = rowsOf(harness, "WorkOrders", (row) => row.clockId === "qa-9-sc-15" && row.entity === "WorkOrder").map((row) => row.workOrderId);
    const reset = await resetWorld(harness.deps, { clockId: "qa-9-sc-15", caller: "QA", actor: "QA" });
    expect(reset.worldEpoch).toBe(2);
    const after = rowsOf(harness, "WorkOrders", (row) => row.clockId === "qa-9-sc-15" && row.entity === "WorkOrder");
    expect(after.map((row) => row.workOrderId)).toEqual(before);
    expect(after.every((row) => row.worldEpoch === 2)).toBe(true);
  });
});

/** A guest world with activity, its real-time and simulated-hour counters. */
async function busyGuestWorld(harness: WorldsHarness): Promise<{ readonly phoneHash: string; readonly realHour: string; readonly simHour: string }> {
  await buildWorld(factoryDepsOf(harness.deps), { ispId: GUEST_TEST_ISP_ID, origin: "TEST" });
  const rogelio = await harness.connector.people.requirePerson("inst-rogelio-gtest");
  const phoneHash = rogelio.phoneHash ?? "";
  const realHour = hourKey(harness.now());
  const simHour = hourKey(new Date("2026-10-13T09:00:00-06:00"));
  await harness.connector.runtime.reserve([
    { counterKey: COUNTER_KEYS.rateSim(GUEST_TEST_CLOCK_ID, phoneHash, simHour), kind: "RATE", by: 1 },
    { counterKey: COUNTER_KEYS.rateReal(GUEST_TEST_CLOCK_ID, phoneHash, realHour), kind: "RATE", by: 1 },
  ]);
  for (const PK of [`SIMCAP#${GUEST_TEST_CLOCK_ID}#turns#2026-10-01`, `TURNCAP#${GUEST_TEST_ISP_ID}#2026-10-01`]) await harness.client.put("Runtime", { PK, SK: "META", entity: "CapCounter", used: 3, ledger: "SIMULATOR", resource: "turns", period: "DAY", capLimit: 300 });
  return { phoneHash, realHour, simHour };
}

async function counter(harness: WorldsHarness, key: string): Promise<unknown> {
  return harness.client.get("Runtime", counterRowKey(key));
}

describe("reset, scene jump and destruction of a guest world [FL-084] [FL-086]", () => {
  it("[FL-086] keep RATE#…#REAL#…, SIMCAP#, TURNCAP# and JUMP# and delete the simulated-hour counters and the rest", async () => {
    const harness = worldsHarness();
    const activity = await busyGuestWorld(harness);
    await jumpToScene(harness.deps, { clockId: GUEST_TEST_CLOCK_ID, sceneId: "evidencia", actor: "QA" });
    const jump = COUNTER_KEYS.jump(GUEST_TEST_CLOCK_ID, hourKey(harness.now()));
    expect(await counter(harness, jump)).toMatchObject({ count: 1 });
    await resetWorld(harness.deps, { clockId: GUEST_TEST_CLOCK_ID, caller: "QA", actor: "QA" });
    await harness.connector.worlds.createJoinCode({ code: "GT1-4F2K", clockId: GUEST_TEST_CLOCK_ID, personId: "inst-rogelio-gtest", userId: "usr-qa-guest" });
    await harness.connector.worlds.bindPhoneLease("GT1-4F2K", "c".repeat(64));
    await destroyWorld(harness.deps, { clockId: GUEST_TEST_CLOCK_ID, actor: "QA" });
    expect(await harness.connector.worlds.getPhoneLease("c".repeat(64))).toBeUndefined();
    expect(await counter(harness, COUNTER_KEYS.rateReal(GUEST_TEST_CLOCK_ID, activity.phoneHash, activity.realHour))).toMatchObject({ count: 1 });
    expect(await counter(harness, COUNTER_KEYS.rateSim(GUEST_TEST_CLOCK_ID, activity.phoneHash, activity.simHour))).toBeUndefined();
    expect(await counter(harness, jump)).toMatchObject({ count: 1 });
    expect(await harness.client.get("Runtime", { PK: `SIMCAP#${GUEST_TEST_CLOCK_ID}#turns#2026-10-01`, SK: "META" })).toMatchObject({ used: 3 });
    expect(await harness.client.get("Runtime", { PK: `TURNCAP#${GUEST_TEST_ISP_ID}#2026-10-01`, SK: "META" })).toMatchObject({ used: 3 });
    expect(rowsOf(harness, "WorkOrders", (row) => row.clockId === GUEST_TEST_CLOCK_ID)).toEqual([]);
    expect(rowsOf(harness, "People", (row) => row.clockId === GUEST_TEST_CLOCK_ID)).toEqual([]);
    expect(await harness.connector.runtime.getClock(GUEST_TEST_CLOCK_ID)).toBeUndefined();
    expect(await harness.connector.worlds.getTombstone(GUEST_TEST_CLOCK_ID, 3)).toMatchObject({ reason: "DESTROY" });
  });

  it("[FL-084] a jump loads the scene: its presets, the active order, the clock at the scene and the day starts it passed sent to the queue", async () => {
    const harness = worldsHarness();
    await busyGuestWorld(harness);
    const jumped = await jumpToScene(harness.deps, { clockId: GUEST_TEST_CLOCK_ID, sceneId: "checklist-completo", actor: "USER:usr-qa-guest" });
    expect(at(jumped.simNow)).toBe(at("2026-10-13T10:00:00-06:00"));
    const clock = await harness.connector.runtime.getClock(GUEST_TEST_CLOCK_ID);
    expect(at(clock?.pausedSimNow ?? "")).toBe(at("2026-10-13T10:00:00-06:00"));
    const checklist = await harness.connector.workOrders.listChecklist("wo-24817-gtest");
    expect(checklist.every((item) => item.status === "PASSED")).toBe(true);
    expect((await harness.connector.worlds.getInstallerState("inst-rogelio-gtest"))?.activeWorkOrderId).toBe("wo-24817-gtest");
    const offers = (await harness.connector.conversations.listMessages("inst-rogelio-gtest")).filter((message) => message.direction === "OUT" && message.refs?.seeded === true);
    expect(offers.map((message) => message.refs?.offer)).toEqual(["CLOSE_INSTALLATION"]);
    expect(harness.dispatcher.sent.map((due) => due.timer.kind).every((kind) => kind === "DAY_START")).toBe(true);
    expect(harness.dispatcher.sent.length).toBeGreaterThan(0);
    await expect(jumpToScene(harness.deps, { clockId: GUEST_TEST_CLOCK_ID, sceneId: "no-such-scene", actor: "QA" })).rejects.toThrow(/no scene/);
  });

  it("refuses to destroy the demo world, and destroying a world that is gone is a no-op", async () => {
    const harness = worldsHarness();
    await expect(destroyWorld(harness.deps, { clockId: DEMO_CLOCK_ID, actor: "QA" })).rejects.toThrow(ToolError);
    await expect(destroyWorld(harness.deps, { clockId: "qa-1-sc-01", actor: "QA" })).resolves.toMatchObject({ items: 0 });
  });
});

describe("destruction of a QA world", () => {
  it("deletes every item, gives back its leases, tombstones its epoch and starts the Memory purge of its installers", async () => {
    const harness = worldsHarness();
    const created = await createWorld(harness.deps, { clockId: "qa-5-sc-02", operations: [{ key: "a", model: "wo-24817", installer: "own" }] });
    if (created.kind !== "QA") throw new Error("expected a QA world");
    const installer = created.world.operations[0]?.installerId ?? "";
    harness.memory.addEvent(`${installer}-e1`, "session-1", "event-1");
    harness.memory.addRecord(`${installer}-e1`, "record-1");
    const destroyed = await destroyWorld(harness.deps, { clockId: "qa-5-sc-02", actor: "QA" });
    expect(destroyed.leases).toBe(4);
    expect(rowsOf(harness, "WorkOrders", (row) => row.clockId === "qa-5-sc-02")).toEqual([]);
    expect(rowsOf(harness, "Isps", (row) => row.ispId === "isp-qa-5-sc-02")).toEqual([]);
    expect(rowsOf(harness, "Network", (row) => row.clockId === "qa-5-sc-02")).toEqual([]);
    expect(rowsOf(harness, "Runtime", (row) => String(row.PK).startsWith("LEASE#"))).toEqual([]);
    expect(harness.memory.eventsOf(`${installer}-e1`)).toBe(0);
    expect(harness.memory.recordsOf(`${installer}-e1`)).toBe(0);
    expect(harness.purges).toEqual([expect.objectContaining({ clockId: "qa-5-sc-02", epoch: 1, actorIds: [`${installer}-e1`] })]);
  });
});

describe("WorldJanitor at night", () => {
  it("resets the invited guest worlds that moved and were quiet for 24 real hours, and nothing else", async () => {
    const harness = worldsHarness();
    for (const ispId of ["isp-guest-07", "isp-guest-08", "isp-guest-09"]) await buildWorld(factoryDepsOf(harness.deps), { ispId, origin: "INVITED" });
    await buildWorld(factoryDepsOf(harness.deps), { ispId: GUEST_TEST_ISP_ID, origin: "TEST" });
    const move = async (clockId: string) => {
      const clock = await harness.connector.runtime.getClock(clockId);
      if (clock === undefined) throw new Error(`no clock ${clockId}`);
      await harness.connector.runtime.updateClock(clockId, { pausedSimNow: "2026-10-13T09:00:00-06:00" }, clock.version);
    };
    await move("GUEST#isp-guest-07");
    await move(GUEST_TEST_CLOCK_ID);
    harness.advance(25 * 60 * 60_000);
    await move("GUEST#isp-guest-08");
    const outcome = await handleWorldJanitor({ worlds: () => harness.deps, log: harness.deps.log, sleep: async () => undefined }, { kind: "IDLE_GUEST_RESET" });
    // 07 moved and went quiet; 08 moved an instant ago; 09 never moved; the rehearsal world is not an invited one.
    expect(outcome.reset).toEqual(["GUEST#isp-guest-07"]);
    expect((await harness.connector.runtime.getClock("GUEST#isp-guest-07"))?.worldEpoch).toBe(2);
    expect(await harness.connector.worlds.getTombstone("GUEST#isp-guest-07", 1)).toMatchObject({ reason: "JANITOR" });
    for (const clockId of ["GUEST#isp-guest-08", "GUEST#isp-guest-09", GUEST_TEST_CLOCK_ID]) expect((await harness.connector.runtime.getClock(clockId))?.worldEpoch).toBe(1);
  });
});
