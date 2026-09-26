import { describe, expect, it } from "vitest";
import {
  AdvanceInput,
  FORCE_AFTER_MS,
  IDLE_POLL_MS,
  LIVE_POLL_MS,
  WorldClock,
  forceAvailable,
  formatSimTime,
  oldestPending,
  pollIntervalMs,
  simTimeParts,
} from "./world-clock";

const WEEKDAYS = { MON: "lun", TUE: "mar", WED: "mié", THU: "jue", FRI: "vie", SAT: "sáb", SUN: "dom" } as const;

const QUIET = WorldClock.parse({ mode: "PAUSED", simNow: "2026-10-13T07:00:00-06:00", busy: false });

function busy(...sinceReal: string[]) {
  return WorldClock.parse({ ...QUIET, busy: true, pending: sinceReal.map((since, index) => ({ kind: index === 0 ? "TRANSCRIBE" : "TURN", sinceReal: since })) });
}

describe("clock.get answer", () => {
  it("defaults the lists and keeps fields added later", () => {
    expect(QUIET).toMatchObject({ mode: "PAUSED", busy: false, pending: [], next: [] });
    const clock = WorldClock.parse({ ...QUIET, next: [{ kind: "DAY_START", dueAtSim: "2026-10-13T07:30:00-06:00", reason: "Inicio del día" }], worldEpoch: 3 });
    expect(clock.next[0]?.kind).toBe("DAY_START");
    expect(clock).toMatchObject({ worldEpoch: 3 });
  });

  it("wants simulated instants with the world's offset", () => {
    expect(WorldClock.safeParse({ ...QUIET, simNow: "2026-10-13T07:00:00" }).success).toBe(false);
    expect(WorldClock.safeParse({ ...QUIET, simNow: "13/10/2026 07:00" }).success).toBe(false);
    expect(WorldClock.safeParse({ ...QUIET, mode: "STOPPED" }).success).toBe(false);
    expect(WorldClock.safeParse({ ...QUIET, busy: true, pending: [{ kind: "SLEEP", sinceReal: "2026-09-26T10:00:00Z" }] }).success).toBe(false);
  });
});

describe("simulated time on screen", () => {
  it("reads the wall time of the world from the instant itself", () => {
    expect(formatSimTime("2026-10-13T09:20:00-06:00", WEEKDAYS)).toBe("mar 13/10 09:20");
    expect(formatSimTime("2026-10-18T23:59:59.500-06:00", WEEKDAYS)).toBe("dom 18/10 23:59");
    expect(simTimeParts("2026-10-12T15:10:00-06:00")).toEqual({ date: "2026-10-12", weekday: "MON", dayMonth: "12/10", time: "15:10" });
  });

  it("refuses what is not a simulated instant", () => {
    expect(() => formatSimTime("2026-10-13", WEEKDAYS)).toThrow(RangeError);
  });
});

describe("polling interval", () => {
  it("polls every 3 s while something is in progress or the clock runs, every 15 s at rest", () => {
    expect(pollIntervalMs(busy("2026-09-26T10:00:00Z"))).toBe(LIVE_POLL_MS);
    expect(pollIntervalMs({ ...QUIET, mode: "RUNNING" })).toBe(LIVE_POLL_MS);
    expect(pollIntervalMs(QUIET)).toBe(IDLE_POLL_MS);
    expect(pollIntervalMs(undefined)).toBe(IDLE_POLL_MS);
    expect([LIVE_POLL_MS, IDLE_POLL_MS]).toEqual([3_000, 15_000]);
  });
});

describe("what a busy world waits for", () => {
  it("names the item it has been waiting for longest", () => {
    const clock = busy("2026-09-26T10:00:05Z", "2026-09-26T10:00:01Z");
    expect(oldestPending(clock.pending)).toMatchObject({ kind: "TURN", sinceReal: "2026-09-26T10:00:01Z" });
    expect(oldestPending([])).toBeUndefined();
  });

  it("offers to advance anyway only after five busy minutes", () => {
    const since = Date.parse("2026-09-26T10:00:00Z");
    const clock = busy("2026-09-26T10:00:00Z");
    expect(forceAvailable(clock, since + FORCE_AFTER_MS - 1)).toBe(false);
    expect(forceAvailable(clock, since + FORCE_AFTER_MS)).toBe(true);
    expect(forceAvailable(QUIET, since + 60 * FORCE_AFTER_MS)).toBe(false);
    expect(forceAvailable(undefined, since)).toBe(false);
  });
});

describe("clock.advance input", () => {
  it("moves by whole minutes, at most three days, nothing else", () => {
    expect(AdvanceInput.parse({ minutes: 10 })).toEqual({ minutes: 10 });
    expect(AdvanceInput.safeParse({ minutes: 0 }).success).toBe(false);
    expect(AdvanceInput.safeParse({ minutes: 1.5 }).success).toBe(false);
    expect(AdvanceInput.safeParse({ minutes: 3 * 24 * 60 + 1 }).success).toBe(false);
    expect(AdvanceInput.safeParse({ minutes: 10, force: true }).success).toBe(false);
  });
});
