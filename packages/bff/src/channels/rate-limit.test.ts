import { describe, expect, it } from "vitest";
import { HASH_A, HASH_B, T0, testConnector } from "../connector/testing";
import { DEFAULT_MESSAGES_PER_HOUR, type RateAdmissionInput, admitMessage, rateLimitsOf, rateReservations } from "./rate-limit";

const HOUR = 3_600_000;
// The judge world's settings (docs/seed-spec.md §4): 20 messages per identity and real hour.
const JUDGE_SETTINGS = { simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 20 } };
// `sc12-rate` of SC-12: a QA world with `rateLimitPerHour 3`.
const QA_RATE_SETTINGS = { rateLimitPerHour: 3, simulatorCaps: { messagesPerRealHourPerIdentity: 20 } };

function world(clockId: string, settings: unknown) {
  const store = testConnector(T0);
  let simMs = Date.parse("2026-10-13T15:20:00.000Z");
  const input = (addressHash: string = HASH_A): RateAdmissionInput => ({ clockId, addressHash, simNow: new Date(simMs), realNow: store.now(), settings });
  return {
    runtime: store.connector.runtime,
    input,
    admit: (addressHash?: string) => admitMessage(store.connector.runtime, input(addressHash)),
    /** "+1 h" of the demo clock: simulated time only. */
    plusOneSimHour: () => void (simMs += HOUR),
    /** Real time passing. */
    plusRealMs: (ms: number) => store.advance(ms),
  };
}

async function admitTimes(admit: () => ReturnType<typeof admitMessage>, times: number) {
  const outcomes = [];
  for (let index = 0; index < times; index += 1) outcomes.push(await admit());
  return outcomes;
}

describe("rateLimitsOf", () => {
  it("uses the simulator's real-hour cap for both windows, bounded by rateLimitPerHour when the world sets it", () => {
    expect(rateLimitsOf(JUDGE_SETTINGS)).toEqual({ perSimHour: 20, perRealHour: 20 });
    expect(rateLimitsOf(QA_RATE_SETTINGS)).toEqual({ perSimHour: 3, perRealHour: 3 });
    expect(rateLimitsOf({ simulatorCaps: { messagesPerRealHourPerIdentity: 80 } })).toEqual({ perSimHour: 80, perRealHour: 80 });
    expect(rateLimitsOf(undefined)).toEqual({ perSimHour: DEFAULT_MESSAGES_PER_HOUR, perRealHour: DEFAULT_MESSAGES_PER_HOUR });
    expect(rateLimitsOf({ rateLimitPerHour: "many" })).toEqual({ perSimHour: DEFAULT_MESSAGES_PER_HOUR, perRealHour: DEFAULT_MESSAGES_PER_HOUR });
  });

  it("keys the two counters by world, sender hash, simulated hour and real hour", () => {
    const { input } = world("GLOBAL#isp-demo", JUDGE_SETTINGS);
    const { sim, real } = rateReservations(input());
    expect(sim).toMatchObject({ counterKey: `RATE#GLOBAL#isp-demo#${HASH_A}#2026-10-13T15`, kind: "RATE", by: 1, max: 20 });
    expect(real).toMatchObject({ counterKey: `RATE#GLOBAL#isp-demo#${HASH_A}#REAL#2026-10-13T13`, kind: "RATE", by: 1, max: 20 });
  });
});

describe("admitMessage [FL-098]", () => {
  it("[FL-098] denies the fourth message of the hour with RATE_LIMIT and does not count it", async () => {
    const { admit } = world("qa-812-1-sc12-rate", QA_RATE_SETTINGS);
    const outcomes = await admitTimes(admit, 4);
    expect(outcomes.slice(0, 3).map((outcome) => outcome.ok)).toEqual([true, true, true]);
    expect(outcomes[2]).toMatchObject({ ok: true, counts: { simHour: 3, realHour: 3 } });
    expect(outcomes[3]).toEqual({ ok: false, ruleId: "RATE_LIMIT", window: "SIM_HOUR", limit: 3, resetsAt: "2026-10-13T16:00:00.000Z" });
    expect(await admit()).toMatchObject({ ok: false, window: "SIM_HOUR" });
  });

  it("[FL-098] '+1 h' of the demo clock opens a new simulated hour but never resets the real hour", async () => {
    const { admit, plusOneSimHour, plusRealMs } = world("qa-812-1-sc12-rate", QA_RATE_SETTINGS);
    await admitTimes(admit, 3);
    plusOneSimHour();
    expect(await admit()).toEqual({ ok: false, ruleId: "RATE_LIMIT", window: "REAL_HOUR", limit: 3, resetsAt: "2026-10-13T14:00:00.000Z" });
    plusRealMs(HOUR);
    expect(await admit()).toMatchObject({ ok: true, counts: { simHour: 1, realHour: 1 } });
  });

  it("[FL-098] counts each identity and each world on its own", async () => {
    const demo = world("GLOBAL#isp-demo", QA_RATE_SETTINGS);
    await admitTimes(() => demo.admit(HASH_A), 3);
    expect(await demo.admit(HASH_A)).toMatchObject({ ok: false });
    expect(await demo.admit(HASH_B)).toMatchObject({ ok: true, counts: { simHour: 1, realHour: 1 } });
    const other = world("JUDGE#isp-judge-07", QA_RATE_SETTINGS);
    expect(await other.admit(HASH_A)).toMatchObject({ ok: true });
  });
});

describe("admitMessage in a judge world [FL-083]", () => {
  it("[FL-083] allows 20 messages per identity and hour and denies the 21st", async () => {
    const { admit } = world("JUDGE#isp-judge-07", JUDGE_SETTINGS);
    const outcomes = await admitTimes(admit, 21);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(20);
    expect(outcomes[20]).toMatchObject({ ok: false, ruleId: "RATE_LIMIT", limit: 20 });
  });

  it("[FL-083] a judge cannot empty the real-hour cap by moving the clock forward", async () => {
    const { admit, plusOneSimHour } = world("JUDGE#isp-judge-07", JUDGE_SETTINGS);
    await admitTimes(admit, 20);
    for (let hour = 0; hour < 3; hour += 1) {
      plusOneSimHour();
      expect(await admit()).toMatchObject({ ok: false, window: "REAL_HOUR", resetsAt: "2026-10-13T14:00:00.000Z" });
    }
  });

  it("[FL-083] refuses an invalid world or sender hash instead of counting under a wrong key", async () => {
    const { runtime } = world("JUDGE#isp-judge-07", JUDGE_SETTINGS);
    const base = { simNow: new Date(T0), realNow: new Date(T0), settings: JUDGE_SETTINGS };
    await expect(admitMessage(runtime, { ...base, clockId: "JUDGE#someone-else", addressHash: HASH_A })).rejects.toThrow();
    await expect(admitMessage(runtime, { ...base, clockId: "JUDGE#isp-judge-07", addressHash: "+525501010001" })).rejects.toThrow();
  });
});
