import { describe, expect, it } from "vitest";
import type { Clock } from "../lib/clock";
import { createLogger } from "../lib/log";
import { type CostAuditEvent, type CostCapsDeps, type GlobalCostCaps, type ReserveCostRequest, costFailure, globalCapUsage, planCounters, realDayKey, realHourKey, releaseCost, reserveCost } from "./cost-caps";
import { createKillSwitchReader, setKillSwitch } from "./kill-switch";
import { createMemoryRuntimeStore } from "./memory-runtime-store";

// Real time of the test: Tuesday 20/10 15:20 UTC (the demo world is paused on 13/10, which does not matter here).
const REAL = Date.parse("2026-10-20T15:20:00.000Z");
const GLOBAL: GlobalCostCaps = { turnsPerDay: 1500, validationsPerDay: 400, transcribeSecondsPerDay: 5400 };
// Settings of a guest world (docs/seed-spec.md §4).
const GUEST_SETTINGS = {
  timezone: "America/Mexico_City",
  turnCaps: { perHour: 200, perDay: 1000 },
  simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 20 },
};
const GUEST = { clockId: "GUEST#isp-guest-07", settings: GUEST_SETTINGS };

function movableClock(start = REAL): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: async () => new Date(now), advance: (ms) => void (now += ms) };
}

function setup(globalCaps: GlobalCostCaps = GLOBAL) {
  const store = createMemoryRuntimeStore();
  const clock = movableClock();
  const events: CostAuditEvent[] = [];
  const lines: string[] = [];
  const kill = createKillSwitchReader({ store, realClock: clock });
  const deps: CostCapsDeps = {
    store,
    kill,
    globalCaps: () => globalCaps,
    realClock: clock,
    audit: async (event) => void events.push(event),
    logger: createLogger({ level: "info", sink: (line) => lines.push(line) }),
  };
  const used = (key: string): number => Number(store.items.get(key)?.used ?? 0);
  return { store, clock, kill, deps, events, lines, used };
}

// The worker before InvokeHarness: the operator's caps and the stage's ceiling, gated by KILL#AGENT.
const turnSpend = (world: ReserveCostRequest["world"]): ReserveCostRequest => ({ world, resource: "turns", amount: 1, reserve: ["OPERATOR", "GLOBAL"], surface: "AGENT" });
// The simulator before enqueueing: the world's caps, a check of the ceiling, gated by KILL#SIMULATOR.
const simulatorEnqueue = (world: ReserveCostRequest["world"]): ReserveCostRequest => ({ world, resource: "turns", amount: 1, reserve: ["SIMULATOR"], check: ["GLOBAL"], surface: "SIMULATOR" });

describe("planCounters", () => {
  it("keys every counter by real hour and real day in UTC, with a 48-hour TTL past the period", () => {
    expect(realDayKey(new Date(REAL))).toBe("2026-10-20");
    expect(realHourKey(new Date(REAL))).toBe("2026-10-20T15");
    const [hour, day, check] = planCounters(simulatorEnqueue(GUEST), GLOBAL, new Date(REAL));
    expect(hour).toEqual({ key: "SIMCAP#GUEST#isp-guest-07#turns#2026-10-20T15", ledger: "SIMULATOR", resource: "turns", period: "HOUR", limit: 60, amount: 1, expiresAt: Date.parse("2026-10-20T16:00:00Z") / 1000 + 172_800, resetsAtReal: "2026-10-20T16:00:00.000Z" });
    expect(day).toMatchObject({ key: "SIMCAP#GUEST#isp-guest-07#turns#2026-10-20", period: "DAY", limit: 300, resetsAtReal: "2026-10-21T00:00:00.000Z" });
    expect(check).toMatchObject({ key: "TURNCAP#GLOBAL#2026-10-20", ledger: "GLOBAL", limit: 1500, amount: 0 });
  });

  it("caps turns by operator and stage, validations and transcription by stage, emails by world only", () => {
    const keys = (request: ReserveCostRequest) => planCounters(request, GLOBAL, new Date(REAL)).map((counter) => counter.key);
    expect(keys(turnSpend(GUEST))).toEqual(["TURNCAP#isp-guest-07#2026-10-20T15", "TURNCAP#isp-guest-07#2026-10-20", "TURNCAP#GLOBAL#2026-10-20"]);
    expect(keys({ world: GUEST, resource: "validations", amount: 1, reserve: ["SIMULATOR", "OPERATOR", "GLOBAL"] })).toEqual(["SIMCAP#GUEST#isp-guest-07#validations#2026-10-20", "VALCAP#GLOBAL#2026-10-20"]);
    expect(keys({ world: GUEST, resource: "transcribe", amount: 14, reserve: ["SIMULATOR", "GLOBAL"] })).toEqual(["SIMCAP#GUEST#isp-guest-07#transcribe#2026-10-20", "TRANSCRIBE#GLOBAL#2026-10-20"]);
    expect(keys({ world: GUEST, resource: "emails", amount: 1, reserve: ["SIMULATOR", "OPERATOR", "GLOBAL"] })).toEqual(["SIMCAP#GUEST#isp-guest-07#emails#2026-10-20"]);
  });

  it("[FL-098] QA and evaluation worlds never touch the stage's ceiling; a qa-* world with an override gets a test scope", () => {
    const keys = (request: ReserveCostRequest) => planCounters(request, GLOBAL, new Date(REAL)).map((counter) => `${counter.key}/${counter.limit}`);
    expect(keys(turnSpend({ clockId: "qa-812-1-sc-12", settings: { turnCaps: { perDay: 50 } } }))).toEqual(["TURNCAP#isp-qa-812-1-sc-12#2026-10-20/50"]);
    expect(keys(turnSpend({ clockId: "eval-812-1", settings: {} }))).toEqual([]);
    expect(keys(turnSpend({ clockId: "qa-812-1-sc12-global", settings: { globalCapsOverride: { turnsPerDay: 2 } } }))).toEqual(["TURNCAP#GLOBAL#qa-812-1-sc12-global#2026-10-20/2"]);
    // An override outside a qa-* world is ignored: the real ceiling applies.
    expect(keys(turnSpend({ clockId: "GLOBAL#isp-demo", settings: { globalCapsOverride: { turnsPerDay: 1_000_000 } } }))).toEqual(["TURNCAP#GLOBAL#2026-10-20/1500"]);
  });

  it("refuses an amount that is not a positive integer and a clock that is not a world", () => {
    expect(() => planCounters({ ...turnSpend(GUEST), amount: 0 }, GLOBAL, new Date(REAL))).toThrow();
    expect(() => planCounters({ ...turnSpend(GUEST), amount: 1.5 }, GLOBAL, new Date(REAL))).toThrow();
    expect(() => planCounters(turnSpend({ clockId: "tomorrow", settings: {} }), GLOBAL, new Date(REAL))).toThrow();
  });
});

describe("reserveCost", () => {
  it("[FL-098] reserves every counter of a turn at once and returns what it reserved", async () => {
    const { deps, used } = setup();
    const outcome = await reserveCost(deps, turnSpend(GUEST));
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.reserved.map((counter) => counter.key)).toEqual(["TURNCAP#isp-guest-07#2026-10-20T15", "TURNCAP#isp-guest-07#2026-10-20", "TURNCAP#GLOBAL#2026-10-20"]);
    expect([used("TURNCAP#isp-guest-07#2026-10-20T15"), used("TURNCAP#GLOBAL#2026-10-20")]).toEqual([1, 1]);
  });

  it("[FL-098] on a full stage ceiling: TURN_CAP of global scope, nothing reserved, audited and counted", async () => {
    const { deps, events, lines, used } = setup({ ...GLOBAL, turnsPerDay: 2 });
    expect((await reserveCost(deps, turnSpend(GUEST))).ok).toBe(true);
    expect((await reserveCost(deps, turnSpend(GUEST))).ok).toBe(true);
    const third = await reserveCost(deps, turnSpend(GUEST));
    expect(third).toMatchObject({ ok: false, code: "CAP_REACHED", counter: { ledger: "GLOBAL", key: "TURNCAP#GLOBAL#2026-10-20", limit: 2 }, used: 2 });
    // All or nothing: the operator's counters did not move on the denied turn.
    expect(used("TURNCAP#isp-guest-07#2026-10-20T15")).toBe(2);
    expect(events).toEqual([expect.objectContaining({ code: "CAP_REACHED", resource: "turns", atReal: "2026-10-20T15:20:00.000Z" })]);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.action === "CAP_REACHED")).toMatchObject({ metric: "TurnCapHits", scope: "GLOBAL", ledger: "GLOBAL" });
  });

  it("[FL-098] the operator's hourly cap stops a turn before the stage's ceiling is touched", async () => {
    const { deps, lines, used } = setup();
    const world = { clockId: "GUEST#isp-guest-07", settings: { turnCaps: { perHour: 1, perDay: 10 } } };
    expect((await reserveCost(deps, turnSpend(world))).ok).toBe(true);
    expect(await reserveCost(deps, turnSpend(world))).toMatchObject({ ok: false, code: "CAP_REACHED", counter: { ledger: "OPERATOR", period: "HOUR", resetsAtReal: "2026-10-20T16:00:00.000Z" } });
    expect(used("TURNCAP#GLOBAL#2026-10-20")).toBe(1);
    expect(lines.join("\n")).toContain('"scope":"OPERATOR"');
  });

  it("[FL-083] the simulator stops at the world's cap, checks the ceiling without consuming it, and only a real hour frees it", async () => {
    const { deps, clock, used } = setup();
    const world = { clockId: "GUEST#isp-guest-07", settings: { simulatorCaps: { turnsPerHour: 2, turnsPerDay: 300 } } };
    expect((await reserveCost(deps, simulatorEnqueue(world))).ok).toBe(true);
    expect((await reserveCost(deps, simulatorEnqueue(world))).ok).toBe(true);
    const capped = await reserveCost(deps, simulatorEnqueue(world));
    expect(capped).toMatchObject({ ok: false, code: "CAP_REACHED", counter: { ledger: "SIMULATOR", period: "HOUR" } });
    expect(!capped.ok && costFailure(capped)).toEqual({ ok: false, error: { code: "CAP_REACHED", message: "the turns cap of this period is reached until 2026-10-20T16:00:00.000Z", reason: "SIMULATOR" } });
    expect(used("TURNCAP#GLOBAL#2026-10-20")).toBe(0);
    // "+1 h" on the demo clock moves simulated time only; the counters follow the real clock.
    clock.advance(40 * 60_000);
    expect((await reserveCost(deps, simulatorEnqueue(world))).ok).toBe(true);
  });

  it("[FL-083] the simulator is refused while the stage's ceiling is full, before anything is enqueued", async () => {
    const { deps, used } = setup({ ...GLOBAL, turnsPerDay: 1 });
    expect((await reserveCost(deps, turnSpend(GUEST))).ok).toBe(true);
    expect(await reserveCost(deps, simulatorEnqueue(GUEST))).toMatchObject({ ok: false, code: "CAP_REACHED", counter: { ledger: "GLOBAL", amount: 0 } });
    expect(used("SIMCAP#GUEST#isp-guest-07#turns#2026-10-20T15")).toBe(0);
  });

  it("[FL-098] SC-12/10: a qa-* world with a ceiling of 2 stops the third turn in its test scope and never touches the real one", async () => {
    const { deps, used } = setup();
    const world = { clockId: "qa-812-1-sc12-global", settings: { globalCapsOverride: { turnsPerDay: 2 } } };
    await reserveCost(deps, turnSpend(world));
    await reserveCost(deps, turnSpend(world));
    expect(await reserveCost(deps, turnSpend(world))).toMatchObject({ ok: false, code: "CAP_REACHED", counter: { ledger: "GLOBAL", key: "TURNCAP#GLOBAL#qa-812-1-sc12-global#2026-10-20" } });
    expect(used("TURNCAP#GLOBAL#2026-10-20")).toBe(0);
  });

  it("[FL-100] with the agent cut nothing is reserved and KILL_SWITCH_ACTIVE is audited; emails are never cut", async () => {
    const { deps, store, kill, events, used } = setup();
    await setKillSwitch({ store, reader: kill }, { scope: "AGENT", clockId: "qa-812-1-sc-14", on: true, actor: "QA" });
    const world = { clockId: "qa-812-1-sc-14", settings: { turnCaps: { perDay: 10 }, simulatorCaps: { emailsPerDay: 5 } } };
    const cut = await reserveCost(deps, turnSpend(world));
    expect(cut).toEqual({ ok: false, code: "KILL_SWITCH_ACTIVE", scope: "AGENT", clockId: "qa-812-1-sc-14" });
    expect(!cut.ok && costFailure(cut).error).toEqual({ code: "UNAVAILABLE", message: "the service is paused", reason: "KILL_SWITCH_ACTIVE" });
    expect(used("TURNCAP#isp-qa-812-1-sc-14#2026-10-20")).toBe(0);
    expect(events[0]).toMatchObject({ code: "KILL_SWITCH_ACTIVE", resource: "turns" });
    expect((await reserveCost(deps, { world, resource: "emails", amount: 1, reserve: ["SIMULATOR"] })).ok).toBe(true);
    // Another world is not cut by this world's switch.
    expect((await reserveCost(deps, turnSpend({ clockId: "qa-812-1-sc-02", settings: {} }))).ok).toBe(true);
  });

  it("does not reserve twice for the same event, and gives a reservation back", async () => {
    const { deps, used } = setup();
    const request = { ...turnSpend(GUEST), idempotencyKey: "evt-01JB8Z9Q2W3E4R5T6Y7V8X9MSG" };
    const first = await reserveCost(deps, request);
    await reserveCost(deps, request);
    expect(used("TURNCAP#GLOBAL#2026-10-20")).toBe(1);
    if (!first.ok) throw new Error("expected a reservation");
    await releaseCost(deps, first.reserved);
    await releaseCost(deps, first.reserved);
    expect(used("TURNCAP#GLOBAL#2026-10-20")).toBe(0);
  });

  it("a ledger without a configured cap reserves nothing, and a cap of zero refuses at once", async () => {
    const { deps } = setup();
    expect(await reserveCost(deps, { world: { clockId: "qa-812-1-sc-01", settings: {} }, resource: "turns", amount: 1, reserve: ["SIMULATOR", "OPERATOR", "GLOBAL"] })).toEqual({ ok: true, reserved: [] });
    expect(await reserveCost(deps, { world: { clockId: "qa-812-1-sc-01", settings: { turnCaps: { perDay: 0 } } }, resource: "turns", amount: 1, reserve: ["OPERATOR"] })).toMatchObject({ ok: false, code: "CAP_REACHED" });
  });
});

describe("globalCapUsage", () => {
  it("reports today's consumption of the stage's ceiling for the metrics view", async () => {
    const { deps } = setup();
    await reserveCost(deps, turnSpend(GUEST));
    await reserveCost(deps, { world: GUEST, resource: "transcribe", amount: 14, reserve: ["GLOBAL"], surface: "AGENT" });
    expect(await globalCapUsage(deps)).toEqual([
      { resource: "turns", used: 1, limit: 1500, resetsAtReal: "2026-10-21T00:00:00.000Z" },
      { resource: "validations", used: 0, limit: 400, resetsAtReal: "2026-10-21T00:00:00.000Z" },
      { resource: "transcribe", used: 14, limit: 5400, resetsAtReal: "2026-10-21T00:00:00.000Z" },
    ]);
  });
});
