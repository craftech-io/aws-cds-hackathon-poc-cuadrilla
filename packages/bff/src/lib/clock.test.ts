import { describe, expect, it } from "vitest";
import { fixedClock, systemClock } from "./clock";

describe("clocks", () => {
  it("a fixed clock always answers the same instant and hands out copies", async () => {
    const clock = fixedClock("2026-10-14T10:30:00-03:00");
    const first = await clock.now();
    first.setUTCFullYear(1999);
    expect((await clock.now()).toISOString()).toBe("2026-10-14T13:30:00.000Z");
  });

  it("rejects an instant that does not parse", () => {
    expect(() => fixedClock("mañana")).toThrow();
  });

  it("the system clock follows real time", async () => {
    const before = Date.now();
    const now = (await systemClock.now()).getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});
