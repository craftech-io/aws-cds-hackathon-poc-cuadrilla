import { describe, expect, it } from "vitest";
import { createMemoryConnector } from "../connector/memory/index";
import type { TableClient } from "../connector/table-client";
import { SIGNUP_WORLD_LIMITS, activeWindow, activeWorlds, claimRetry, confirmedDayKey, planSlot, retryAfterSeconds, setQaSlotLimits, worldsDayKey } from "./slots";

const NOW = new Date("2026-10-20T15:20:30.000Z");
const DAY_MS = 86_400_000;

async function seedDay(client: TableClient, key: string, count: number): Promise<void> {
  await client.put("Runtime", { PK: key, SK: "META", count });
}

async function take(client: TableClient, scope: "PUBLIC" | "QA", now = NOW): Promise<boolean> {
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

  it("[FL-112] guest.capsOverride uses test keys and never touches the real ones", async () => {
    const { client } = createMemoryConnector({ now: () => NOW });
    await setQaSlotLimits(client, { activeWorlds: 1, confirmedPerDay: 5 }, NOW);
    expect(await take(client, "QA")).toBe(true);
    expect(await planSlot(client, "QA", NOW)).toEqual({ ok: false, reason: "WORLDS_FULL" });
    const keys = client.dump("Runtime").map((row) => row.PK).sort();
    expect(keys).toEqual(["GUESTWORLDS#QA#261020", "GUESTWORLDS#QA#LIMITS", "SIGNUPOK#QA#2026-10-20"]);
    expect(await activeWorlds(client, "PUBLIC", NOW)).toBe(0);
    expect(await take(client, "PUBLIC")).toBe(true);
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
