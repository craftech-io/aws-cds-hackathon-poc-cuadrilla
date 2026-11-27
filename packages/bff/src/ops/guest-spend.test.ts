import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { GUEST_SPEND_TEST_CAPS } from "../worker/testing";
import { reserveTurn } from "../worker/turn-cap";
import { createLogger } from "../lib/log";
import { type CapWorld, type CostCapsDeps, type GlobalCostCaps, type ReserveCostRequest, costFailure, planCounters, reserveCost } from "./cost-caps";
import { createDynamoRuntimeStore } from "./dynamo-runtime-store";
import { guestSpendKey, settleSpend, spendEstimate } from "./guest-spend";
import { createKillSwitchReader } from "./kill-switch";
import { createMemoryRuntimeStore } from "./memory-runtime-store";

const REAL = new Date("2026-10-20T15:20:00.000Z");
const OWNER = "usr-g01K60000000000000000000001";
const SPEND = guestSpendKey(OWNER);
const CAPS: GlobalCostCaps = {
  turnsPerDay: 1500,
  validationsPerDay: 400,
  transcribeSecondsPerDay: 5400,
  guestSignup: { turnsPerDay: 600, validationsPerDay: 150, transcribeSecondsPerDay: 1800, perUserTurnsPerDay: 40, ...GUEST_SPEND_TEST_CAPS },
};
const SIGNUP_WORLD = { clockId: "GUEST#isp-guest-s261020abcde", settings: { ownerUserId: OWNER } };
const INVITED_WORLD = { clockId: "GUEST#isp-guest-07", settings: {} };
const log = createLogger({ level: "error", sink: () => undefined });

function setup(spentMicroUsd = 0) {
  const store = createMemoryRuntimeStore();
  const realClock = { now: async () => REAL };
  const deps: CostCapsDeps = { store, globalCaps: () => CAPS, realClock, kill: createKillSwitchReader({ store, realClock }) };
  const seed = async () => {
    if (spentMicroUsd > 0) await store.adjust(SPEND, spentMicroUsd, { idempotencyKey: "seed", nowIso: REAL.toISOString() });
  };
  const used = (key: string): number => Number(store.items.get(key)?.used ?? 0);
  return { store, deps, seed, used };
}

const turn = (world: CapWorld = SIGNUP_WORLD): ReserveCostRequest => ({ world, resource: "turns", amount: 1, reserve: ["GLOBAL"], surface: "AGENT" });
const photo = (id: string): ReserveCostRequest => ({ world: SIGNUP_WORLD, resource: "validations", amount: 1, reserve: ["GLOBAL"], surface: "AGENT", idempotencyKey: id });
const audio = (seconds: number, id: string): ReserveCostRequest => ({ world: SIGNUP_WORLD, resource: "transcribe", amount: seconds, reserve: ["GLOBAL"], surface: "AGENT", idempotencyKey: id });

describe("[FL-112] the spend of a sign-up account: USD 1 ever, no daily reset (COSTUSD#GUESTUSER#)", () => {
  it("plans the spend counter with the resource's estimate, no TTL and no reset", () => {
    const [account, spend] = planCounters(turn(), CAPS, REAL);
    expect(account).toMatchObject({ key: `TURNCAP#GUESTUSER#${OWNER}#2026-10-20`, tier: "GUEST_ACCOUNT", limit: 40 });
    expect(spend).toEqual({ key: SPEND, ledger: "GLOBAL", resource: "turns", period: "TOTAL", limit: 1_000_000, amount: 150_000, minRoom: 150_000, tier: "GUEST_SPEND" });
    expect(spendEstimate("validations", 2, GUEST_SPEND_TEST_CAPS)).toBe(60_000);
    expect(spendEstimate("transcribe", 60, GUEST_SPEND_TEST_CAPS)).toBe(24_000);
  });

  it("two turns that start together at the edge: only the one that fits opens, the other gets GUEST_SPEND", async () => {
    const { deps, seed, used } = setup(800_000);
    await seed();
    const results = await Promise.all([reserveCost(deps, { ...turn(), idempotencyKey: "turn#a" }), reserveCost(deps, { ...turn(), idempotencyKey: "turn#b" })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused).toMatchObject({ ok: false, code: "CAP_REACHED", counter: { key: SPEND, tier: "GUEST_SPEND" } });
    expect(used(SPEND)).toBe(950_000);
    // The refused one took nothing anywhere: the day's counters moved once.
    expect(used(`TURNCAP#GUESTUSER#${OWNER}#2026-10-20`)).toBe(1);
    expect(used("TURNCAP#GLOBAL#2026-10-20")).toBe(1);
  });

  it("over the edge no turn opens at all, and the worker refuses it without a reset time", async () => {
    const { deps, seed, used } = setup(900_000);
    await seed();
    const budget = await reserveTurn({ kill: deps.kill!, costCaps: deps }, SIGNUP_WORLD, "evt-1", log);
    expect(budget).toEqual({ allowed: false, refusal: "TURN_CAP", scope: "GUEST_SPEND", ledger: "GLOBAL", period: "TOTAL", limit: 1_000_000 });
    expect(used(SPEND)).toBe(900_000);
  });

  it("a turn settles from its estimate to its priced cost, once per event", async () => {
    const { deps, used } = setup();
    const budget = await reserveTurn({ kill: deps.kill!, costCaps: deps }, SIGNUP_WORLD, "evt-2", log);
    if (!budget.allowed) throw new Error("expected the turn to open");
    expect(used(SPEND)).toBe(150_000);
    await settleSpend(deps, budget.reserved, 61_250, "turn#evt-2");
    await settleSpend(deps, budget.reserved, 61_250, "turn#evt-2");
    expect(used(SPEND)).toBe(61_250);
    // An unpriced turn keeps the estimate; a turn that cost more than it adds the difference.
    await settleSpend(deps, budget.reserved, undefined, "turn#evt-2b");
    expect(used(SPEND)).toBe(61_250);
  });

  it("the spend never starts over: a new real day keeps it", async () => {
    const { deps, seed, used } = setup(990_000);
    await seed();
    const tomorrow = { ...deps, realClock: { now: async () => new Date("2026-10-27T09:00:00.000Z") } };
    expect(await reserveCost(tomorrow, turn())).toMatchObject({ ok: false, counter: { tier: "GUEST_SPEND" } });
    expect(used(SPEND)).toBe(990_000);
  });

  it("photos: each validation reserves its estimate; at the edge it is refused with a message without a reset time", async () => {
    const { deps, seed, used } = setup(950_000);
    await seed();
    expect(await reserveCost(deps, photo("p1"))).toMatchObject({ ok: true });
    expect(used(SPEND)).toBe(980_000);
    const refused = await reserveCost(deps, photo("p2"));
    expect(refused).toMatchObject({ ok: false, code: "CAP_REACHED", counter: { tier: "GUEST_SPEND" } });
    if (refused.ok || refused.code !== "CAP_REACHED") throw new Error("expected a refusal");
    const envelope = costFailure(refused);
    expect(envelope).toMatchObject({ ok: false, error: { code: "CAP_REACHED", reason: "GUEST_SPEND" } });
    expect(JSON.stringify(envelope)).not.toContain("until");
  });

  it("photos: the account's own day quota holds below the shared sub-ceiling", async () => {
    const { deps, used } = setup();
    for (let index = 0; index < GUEST_SPEND_TEST_CAPS.perUserValidationsPerDay; index += 1) expect(await reserveCost(deps, photo(`v${index}`))).toMatchObject({ ok: true });
    expect(await reserveCost(deps, photo("v-extra"))).toMatchObject({ ok: false, counter: { key: `VALCAP#GUESTUSER#${OWNER}#2026-10-20`, tier: "GUEST_ACCOUNT" } });
    expect(used("VALCAP#GUESTSIGNUP#2026-10-20")).toBe(GUEST_SPEND_TEST_CAPS.perUserValidationsPerDay);
  });

  it("audio: seconds are priced into the spend and capped per account and day", async () => {
    const { deps, seed, used } = setup(980_000);
    await seed();
    expect(await reserveCost(deps, audio(60, "a1"))).toMatchObject({ ok: false, counter: { tier: "GUEST_SPEND" } });
    expect(await reserveCost(deps, audio(40, "a2"))).toMatchObject({ ok: true });
    expect(used(SPEND)).toBe(996_000);
    const fresh = setup();
    expect(await reserveCost(fresh.deps, audio(100, "a3"))).toMatchObject({ ok: true });
    expect(await reserveCost(fresh.deps, audio(1, "a4"))).toMatchObject({ ok: false, counter: { key: `TRANSCRIBE#GUESTUSER#${OWNER}#2026-10-20`, tier: "GUEST_ACCOUNT" } });
  });

  it("invited guests and the staff's worlds never touch the account spend", () => {
    const keys = planCounters(turn(INVITED_WORLD), CAPS, REAL).map((counter) => counter.key);
    expect(keys).toEqual(["TURNCAP#GLOBAL#2026-10-20"]);
    expect(planCounters(turn({ clockId: "GUEST#isp-guest-test", settings: {} }), CAPS, REAL).some((counter) => counter.tier === "GUEST_SPEND")).toBe(false);
  });
});

describe("DynamoDB runtime store: the spend counter", () => {
  const docMock = mockClient(DynamoDBDocumentClient);
  const store = () => createDynamoRuntimeStore({ client: DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })), table: () => "poc-Runtime", retry: { sleep: async () => undefined } });

  it("reserves it with room for the whole estimate and without a TTL", async () => {
    docMock.reset();
    docMock.on(TransactWriteCommand).resolves({});
    const counters = planCounters(turn(), CAPS, REAL);
    expect(await store().reserve(counters, { nowIso: REAL.toISOString(), idempotencyKey: "turn#evt" })).toEqual({ ok: true });
    const items = docMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    const spend = items.find((item) => item.Update?.Key?.PK === SPEND)?.Update;
    expect(spend?.ExpressionAttributeValues).toMatchObject({ ":amount": 150_000, ":limit": 1_000_000, ":max": 850_000, ":period": "TOTAL" });
    expect(spend?.UpdateExpression).not.toContain("expiresAt");
    expect(spend?.ExpressionAttributeValues).not.toHaveProperty(":expiresAt");
  });

  it("checks it (the simulator) with room for the estimate, not for 1", async () => {
    docMock.reset();
    docMock.on(TransactWriteCommand).resolves({});
    const checked = planCounters({ ...turn(), reserve: [], check: ["GLOBAL"] }, CAPS, REAL);
    await store().reserve(checked, { nowIso: REAL.toISOString() });
    const items = docMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items.find((item) => item.ConditionCheck?.Key?.PK === SPEND)?.ConditionCheck?.ExpressionAttributeValues).toEqual({ ":max": 850_000 });
  });

  it("settles with one unconditional signed ADD carrying a client token", async () => {
    docMock.reset();
    docMock.on(TransactWriteCommand).resolves({});
    await store().adjust(SPEND, -88_750, { idempotencyKey: "turn#evt", nowIso: REAL.toISOString() });
    const input = docMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(input?.ClientRequestToken).toHaveLength(32);
    expect(input?.TransactItems?.[0]?.Update).toMatchObject({ Key: { PK: SPEND, SK: "META" }, UpdateExpression: "ADD #used :delta SET #updatedAt = :now", ExpressionAttributeValues: { ":delta": -88_750 } });
    expect(input?.TransactItems?.[0]?.Update?.ConditionExpression).toBeUndefined();
  });
});
