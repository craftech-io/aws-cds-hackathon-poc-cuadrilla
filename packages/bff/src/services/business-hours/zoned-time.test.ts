import { describe, expect, it } from "vitest";
import { MEXICO_CITY_TIME_ZONE, atLocalTime, isValidTimeZone, localDateOf, minutesOf, minutesOfDay, toZonedIso, zonedInstant, zonedParts } from "./zoned-time";

const at = (iso: string): Date => new Date(iso);
const iso = (date: Date): string => date.toISOString();
const MX = MEXICO_CITY_TIME_ZONE;
// Tijuana still follows US daylight saving time: it exercises the gap and the repeated hour.
const TJ = "America/Tijuana";

describe("wall clock by zone", () => {
  it("reads the local date, time, weekday and offset of an instant", () => {
    expect(zonedParts(at("2026-10-13T15:20:00Z"), MX)).toEqual({ date: "2026-10-13", time: "09:20", hour: 9, minute: 20, second: 0, weekday: "TUE", offsetMinutes: -360 });
    expect(zonedParts(at("2026-10-13T15:20:00Z"), TJ)).toMatchObject({ date: "2026-10-13", time: "08:20", offsetMinutes: -420 });
    expect(localDateOf(at("2026-10-14T05:30:00Z"), MX)).toBe("2026-10-13");
    expect(localDateOf(at("2026-10-14T06:00:00Z"), MX)).toBe("2026-10-14");
    expect(minutesOfDay(at("2026-10-13T15:20:30Z"), MX)).toBe(560.5);
    expect(minutesOf("21:00")).toBe(1260);
  });

  it("prints ISO 8601 with the zone's offset, with and without daylight saving time", () => {
    expect(toZonedIso(at("2026-10-13T15:20:00Z"), MX)).toBe("2026-10-13T09:20:00-06:00");
    expect(toZonedIso(at("2026-07-13T15:20:00Z"), MX)).toBe("2026-07-13T09:20:00-06:00");
    expect(toZonedIso(at("2026-07-13T15:20:00Z"), TJ)).toBe("2026-07-13T08:20:00-07:00");
    expect(toZonedIso(at("2026-12-13T15:20:00Z"), TJ)).toBe("2026-12-13T07:20:00-08:00");
  });

  it("turns a local date and time into an instant, across daylight saving changes", () => {
    expect(iso(zonedInstant("2026-10-13", "07:30", MX))).toBe("2026-10-13T13:30:00.000Z");
    expect(iso(zonedInstant("2026-10-13", "07:30", TJ))).toBe("2026-10-13T14:30:00.000Z");
    // Skipped hour (spring forward, 8 March 2026): lands after the gap.
    expect(toZonedIso(zonedInstant("2026-03-08", "02:30", TJ), TJ)).toBe("2026-03-08T03:30:00-07:00");
    // Repeated hour (fall back, 1 November 2026): the second occurrence.
    expect(toZonedIso(zonedInstant("2026-11-01", "01:30", TJ), TJ)).toBe("2026-11-01T01:30:00-08:00");
  });

  it("finds the 07:30 of the next local day from an instant after local midnight in UTC terms", () => {
    // 13/10 22:00 in Mexico City is already 14/10 in UTC; the next day is still 14/10 locally.
    expect(iso(atLocalTime(at("2026-10-14T04:00:00Z"), 1, "07:30", MX))).toBe("2026-10-14T13:30:00.000Z");
    expect(iso(atLocalTime(at("2026-10-13T13:00:00Z"), 0, "07:30", MX))).toBe("2026-10-13T13:30:00.000Z");
    expect(() => atLocalTime(at("2026-10-13T13:00:00Z"), 1.5, "07:30", MX)).toThrow(RangeError);
  });

  it("rejects unknown zones, malformed times and invalid instants", () => {
    expect(isValidTimeZone(MX)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(() => zonedInstant("2026-10-13", "7:30", MX)).toThrow();
    expect(() => zonedInstant("2026-13-01", "07:30", MX)).toThrow();
    expect(() => zonedParts(new Date(Number.NaN), MX)).toThrow(RangeError);
  });
});
