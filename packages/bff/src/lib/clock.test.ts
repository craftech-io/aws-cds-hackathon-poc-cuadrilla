import { describe, expect, it } from "vitest";
import { ConnectorError } from "@cuadrilla/shared";
import {
  RUNNING_WINDOW_MS,
  type WorldClockInput,
  effectiveMode,
  fixedClock,
  moveTo,
  pauseAt,
  realInstantOf,
  simNowOf,
  startRunning,
  systemClock,
  worldClock,
} from "./clock";

// World of the demo: paused on Tuesday 13/10 07:00 in Mexico City (docs/seed-spec.md §3).
const START_SIM = "2026-10-13T13:00:00.000Z";
const REAL = Date.parse("2026-11-02T15:00:00.000Z");

const paused: WorldClockInput = { clockId: "GLOBAL#isp-demo", mode: "PAUSED", pausedSimNow: "2026-10-13T07:00:00-06:00", offsetMs: 0, worldEpoch: 3 };

describe("fixed and system clocks", () => {
  it("a fixed clock always answers the same instant and hands out copies", async () => {
    const clock = fixedClock("2026-10-13T07:00:00-06:00");
    const first = await clock.now();
    first.setUTCFullYear(1999);
    expect((await clock.now()).toISOString()).toBe(START_SIM);
    expect((await fixedClock(new Date(START_SIM)).now()).toISOString()).toBe(START_SIM);
  });

  it("rejects an instant that does not parse", () => {
    expect(() => fixedClock("mañana")).toThrow();
    expect(() => fixedClock(new Date(Number.NaN))).toThrow(RangeError);
  });

  it("the system clock follows real time", async () => {
    const before = Date.now();
    const now = (await systemClock.now()).getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});

describe("simulated time of a world", () => {
  it("a paused world stays at its instant whatever the real time does", () => {
    expect(simNowOf(paused, REAL).toISOString()).toBe(START_SIM);
    expect(simNowOf(paused, REAL + 7 * 86_400_000).toISOString()).toBe(START_SIM);
    expect(effectiveMode(paused, REAL)).toBe("PAUSED");
  });

  it("a running world follows real time with its offset and pauses itself after 30 minutes", () => {
    const running = { ...paused, ...startRunning(paused, REAL) };
    expect(running.mode).toBe("RUNNING");
    expect(running.runningUntilReal).toBe(new Date(REAL + RUNNING_WINDOW_MS).toISOString());
    expect(simNowOf(running, REAL).toISOString()).toBe(START_SIM);
    expect(simNowOf(running, REAL + 60_000).toISOString()).toBe("2026-10-13T13:01:00.000Z");
    expect(effectiveMode(running, REAL + RUNNING_WINDOW_MS - 1)).toBe("RUNNING");
    // Past the window the world reads as paused at the instant it had reached.
    expect(effectiveMode(running, REAL + RUNNING_WINDOW_MS)).toBe("PAUSED");
    expect(simNowOf(running, REAL + 2 * RUNNING_WINDOW_MS).toISOString()).toBe("2026-10-13T13:30:00.000Z");
  });

  it("maps a simulated due time to the real instant a schedule fires at", () => {
    const running = { ...paused, ...startRunning(paused, REAL) };
    // The 60-second demo timeout of a case notified at the start of the run.
    expect(realInstantOf(running, new Date("2026-10-13T13:01:00.000Z")).getTime()).toBe(REAL + 60_000);
    expect(() => realInstantOf(running, new Date(Number.NaN))).toThrow(RangeError);
  });

  it("pausing keeps the simulated instant reached", () => {
    const running = { ...paused, ...startRunning(paused, REAL) };
    const patch = pauseAt(running, REAL + 5 * 60_000);
    expect(patch).toEqual({ mode: "PAUSED", pausedSimNow: "2026-10-13T13:05:00.000Z", offsetMs: running.offsetMs, runningUntilReal: undefined });
  });

  it("moves forward in either mode and never back", () => {
    const target = new Date("2026-10-13T13:30:00.000Z"); // "Iniciar el día": 07:30 in Mexico City
    expect(moveTo(paused, target, REAL)).toMatchObject({ mode: "PAUSED", pausedSimNow: target.toISOString() });
    const running = { ...paused, ...startRunning(paused, REAL) };
    const moved = { ...running, ...moveTo(running, target, REAL + 1_000) };
    expect(moved.mode).toBe("RUNNING");
    expect(simNowOf(moved, REAL + 1_000).toISOString()).toBe(target.toISOString());
    expect(simNowOf(moved, REAL + 61_000).toISOString()).toBe("2026-10-13T13:31:00.000Z");
    expect(() => moveTo(paused, new Date("2026-10-13T12:59:59.000Z"), REAL)).toThrow(RangeError);
    // An expired RUNNING world moves as a paused one.
    expect(moveTo(running, target, REAL + RUNNING_WINDOW_MS + 1)).toMatchObject({ mode: "PAUSED", pausedSimNow: target.toISOString() });
  });

  it("rejects a clock item without a valid shape", () => {
    expect(() => simNowOf({ ...paused, mode: "STOPPED" } as unknown as WorldClockInput, REAL)).toThrow();
    expect(() => simNowOf({ ...paused, worldEpoch: -1 }, REAL)).toThrow();
    expect(() => startRunning(paused, REAL, 0)).toThrow(RangeError);
  });
});

describe("worldClock", () => {
  const realClock = fixedClock(new Date(REAL));

  it("reads the world's state on every call, so another writer's move is seen", async () => {
    let stored = { ...paused, world: "guest", settings: { demoMode: true }, version: 4 } as WorldClockInput;
    const clock = worldClock("GLOBAL#isp-demo", { readClock: async () => stored, realClock });
    expect((await clock.now()).toISOString()).toBe(START_SIM);
    stored = { ...stored, ...moveTo(stored, new Date("2026-10-13T13:30:00.000Z"), REAL) };
    expect((await clock.now()).toISOString()).toBe("2026-10-13T13:30:00.000Z");
    expect(await clock.snapshot()).toEqual({ clockId: "GLOBAL#isp-demo", mode: "PAUSED", simNow: new Date("2026-10-13T13:30:00.000Z"), worldEpoch: 3 });
  });

  it("keeps each world on its own clock: moving a guest's world never moves the demo", async () => {
    const worlds = new Map<string, WorldClockInput>([
      ["GLOBAL#isp-demo", { ...paused }],
      ["GUEST#isp-guest-07", { ...paused, clockId: "GUEST#isp-guest-07", worldEpoch: 1 }],
    ]);
    const deps = { readClock: async (id: string) => worlds.get(id), realClock };
    const guest = worlds.get("GUEST#isp-guest-07") as WorldClockInput;
    worlds.set("GUEST#isp-guest-07", { ...guest, ...moveTo(guest, new Date("2026-10-13T18:00:00.000Z"), REAL) });
    expect((await worldClock("GUEST#isp-guest-07", deps).now()).toISOString()).toBe("2026-10-13T18:00:00.000Z");
    expect((await worldClock("GLOBAL#isp-demo", deps).now()).toISOString()).toBe(START_SIM);
  });

  it("measures a running world against the injected real clock", async () => {
    const stored = { ...paused, ...startRunning(paused, REAL - 10 * 60_000) };
    const clock = worldClock("GLOBAL#isp-demo", { readClock: async () => stored, realClock });
    expect(await clock.snapshot()).toMatchObject({ mode: "RUNNING", simNow: new Date("2026-10-13T13:10:00.000Z") });
  });

  it("fails on an unknown world, a mismatched item and an invalid clock id", async () => {
    await expect(worldClock("qa-812-1-sc-02", { readClock: async () => undefined, realClock }).now()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(worldClock("GUEST#isp-guest-01", { readClock: async () => paused, realClock }).now()).rejects.toBeInstanceOf(ConnectorError);
    expect(() => worldClock("tomorrow", { readClock: async () => paused })).toThrow();
  });
});
