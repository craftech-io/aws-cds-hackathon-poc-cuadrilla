import { describe, expect, it } from "vitest";
import { createMemoryConnector } from "../connector/memory/index";
import type { TableClient } from "../connector/table-client";
import { qaRunOfAddress } from "../leads/keys";
import { RunId } from "../qa-driver/contract";
import { SIGNUP_WORLD_LIMITS, type SlotScope, activeWindow, activeWorlds, claimRetry, confirmedDayKey, planSlot, qaSlotScope, retryAfterSeconds, setQaSlotLimits, slotScopeOf, worldsDayKey } from "./slots";

const NOW = new Date("2026-10-20T15:20:30.000Z");
const DAY_MS = 86_400_000;

async function seedDay(client: TableClient, key: string, count: number): Promise<void> {
  await client.put("Runtime", { PK: key, SK: "META", count });
}

async function take(client: TableClient, scope: SlotScope, now = NOW): Promise<boolean> {
  const plan = await planSlot(client, scope, now);
  if (!plan.ok) return false;
  await client.transact(plan.ops, now.toISOString());
  return true;
}

describe("[FL-112] slots of the sign-up worlds", () => {
  it("[FL-112] the active worlds are the sum of the last 7 days; the 151st is refused, and a world of 8 days ago no longer counts", async () => {
    const { client } = createMemoryConnector({ now: () => NOW });
    expect(activeWindow(NOW)).toEqual(["261020", "261019", "261018", "261017", "261016", "261015", "261014"]);
    for (const [index, day] of activeWindow(NOW).entries()) await seedDay(client, worldsDayKey("PUBLIC", day), index === 0 ? 0 : 20);
    await seedDay(client, worldsDayKey("PUBLIC", "261013"), 90);
    expect(await activeWorlds(client, "PUBLIC", NOW)).toBe(120);
    for (let world = 0; world < 30; world += 1) expect(await take(client, "PUBLIC")).toBe(true);
    expect(await activeWorlds(client, "PUBLIC", NOW)).toBe(SIGNUP_WORLD_LIMITS.activeWorlds);
    expect(await planSlot(client, "PUBLIC", NOW)).toEqual({ ok: false, reason: "WORLDS_FULL" });
    // A day later the oldest day of the window leaves it.
    expect((await planSlot(client, "PUBLIC", new Date(NOW.getTime() + DAY_MS))).ok).toBe(true);
  });

  it("[FL-112] the ceiling of today's counter is computed from the sum read: a reservation planned before another one at the limit fails", async () => {
    const { client } = createMemoryConnector({ now: () => NOW });
    await seedDay(client, worldsDayKey("PUBLIC", "261019"), SIGNUP_WORLD_LIMITS.activeWorlds - 1);
    const first = await planSlot(client, "PUBLIC", NOW);
    const second = await planSlot(client, "PUBLIC", NOW);
    if (!first.ok || !second.ok) throw new Error("both plans see room");
    await client.transact(first.ops, NOW.toISOString());
    await expect(client.transact(second.ops, NOW.toISOString())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await activeWorlds(client, "PUBLIC", NOW)).toBe(SIGNUP_WORLD_LIMITS.activeWorlds);
  });

  it("[FL-112] at most 150 worlds granted to confirmed sign-ups a day", async () => {
    const { client } = createMemoryConnector({ now: () => NOW });
    await seedDay(client, confirmedDayKey("PUBLIC", "2026-10-20"), SIGNUP_WORLD_LIMITS.confirmedPerDay);
    expect(await planSlot(client, "PUBLIC", NOW)).toEqual({ ok: false, reason: "CONFIRMED_FULL" });
    expect((await planSlot(client, "PUBLIC", new Date(NOW.getTime() + DAY_MS))).ok).toBe(true);
  });

  it("[FL-112] guest.capsOverride uses test keys of its own run and never touches the real ones nor another run's [W5 review B1]", async () => {
    const { client } = createMemoryConnector({ now: () => NOW });
    const run = qaSlotScope("812-1");
    expect(await setQaSlotLimits(client, "812-1", { activeWorlds: 1, confirmedPerDay: 5 }, NOW)).toEqual({ key: "GUESTWORLDS#QA#qa-812-1#LIMITS" });
    expect(await take(client, run)).toBe(true);
    expect(await planSlot(client, run, NOW)).toEqual({ ok: false, reason: "WORLDS_FULL" });
    const keys = client.dump("Runtime").map((row) => row.PK).sort();
    expect(keys).toEqual(["GUESTWORLDS#QA#qa-812-1#261020", "GUESTWORLDS#QA#qa-812-1#LIMITS", "SIGNUPOK#QA#qa-812-1#2026-10-20"]);
    // Another run keeps the default limits and its own counters.
    expect(await take(client, qaSlotScope("813-1"))).toBe(true);
    expect(await activeWorlds(client, qaSlotScope("813-1"), NOW)).toBe(1);
    expect(await activeWorlds(client, "PUBLIC", NOW)).toBe(0);
    expect(await take(client, "PUBLIC")).toBe(true);
  });

  it("[FL-112] the scope of an account is decided from its lead's address: a QA address counts in its run's room", () => {
    for (const runId of ["812-1", "812-1-r2", "local-01k60000000000000000000000"]) {
      expect(RunId.safeParse(runId).success, runId).toBe(true);
      expect(qaRunOfAddress(`success+qa-${runId}-ip0@simulator.amazonses.com`)).toBe(runId);
      expect(slotScopeOf({ origin: "QA", email: `success+qa-${runId}-7@simulator.amazonses.com` })).toBe(`QA#qa-${runId}`);
    }
    expect(slotScopeOf({ origin: "QA", email: "success+qa-rehearsal@simulator.amazonses.com" })).toBe("QA#qa-rehearsal");
    expect(slotScopeOf({ origin: "WEB", email: "success+qa-812-1-7@simulator.amazonses.com" })).toBe("PUBLIC");
    expect(slotScopeOf({ origin: "WEB", email: "ana@example.com" })).toBe("PUBLIC");
  });

  it("[FL-112] retryWorld once a minute per guest", async () => {
    const { connector } = createMemoryConnector({ now: () => NOW });
    expect(await claimRetry(connector.runtime, "usr-g01K60000000000000000000001", NOW)).toBe(true);
    expect(await claimRetry(connector.runtime, "usr-g01K60000000000000000000001", new Date(NOW.getTime() + 20_000))).toBe(false);
    expect(await claimRetry(connector.runtime, "usr-g01K60000000000000000000002", NOW)).toBe(true);
    expect(await claimRetry(connector.runtime, "usr-g01K60000000000000000000001", new Date(NOW.getTime() + 30_000))).toBe(true);
    expect(retryAfterSeconds(NOW)).toBe(30);
  });
});
