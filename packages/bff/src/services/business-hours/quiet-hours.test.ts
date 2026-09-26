import { describe, expect, it } from "vitest";
import { DEFAULT_QUIET_HOURS, evaluateQuietHours, isQuietAt, parseQuietHoursWindow, quietEndsAt, quietHours } from "./quiet-hours";

const at = (iso: string): Date => new Date(iso);
const iso = (date: Date): string => date.toISOString();

// 21:00-07:00 America/Mexico_City (UTC−6 all year).
const DEMO = quietHours();

describe("quiet hours of the demo operator", () => {
  it("default to 21:00-07:00 in Mexico City", () => {
    expect(DEMO).toEqual({ timeZone: "America/Mexico_City", ...DEFAULT_QUIET_HOURS });
  });

  it("are quiet from 21:00 sharp until just before 07:00, across midnight", () => {
    expect(isQuietAt(at("2026-10-14T02:59:59Z"), DEMO)).toBe(false); // 13/10 20:59:59
    expect(isQuietAt(at("2026-10-14T03:00:00Z"), DEMO)).toBe(true); // 13/10 21:00
    expect(isQuietAt(at("2026-10-14T06:00:00Z"), DEMO)).toBe(true); // 14/10 00:00
    expect(isQuietAt(at("2026-10-14T12:59:59Z"), DEMO)).toBe(true); // 14/10 06:59:59
    expect(isQuietAt(at("2026-10-14T13:00:00Z"), DEMO)).toBe(false); // 14/10 07:00
    expect(isQuietAt(at("2026-10-13T13:30:00Z"), DEMO)).toBe(false); // 13/10 07:30, DAY_START
  });

  it("end at the next 07:00: the next local day in the evening, the same day before dawn", () => {
    // Dispatch reschedules at 22:00 (FL-073): the notice waits until 07:00 of 14/10.
    expect(iso(quietEndsAt(at("2026-10-14T04:00:00Z"), DEMO))).toBe("2026-10-14T13:00:00.000Z");
    expect(iso(quietEndsAt(at("2026-10-14T11:00:00Z"), DEMO))).toBe("2026-10-14T13:00:00.000Z");
    const noon = at("2026-10-13T18:00:00Z");
    expect(quietEndsAt(noon, DEMO)).toEqual(noon);
    expect(quietEndsAt(noon, DEMO)).not.toBe(noon);
  });

  it("answer CP-QUIET-HOURS in one call with nextAllowedAt only when quiet", () => {
    expect(evaluateQuietHours(at("2026-10-14T03:30:00Z"), DEMO)).toEqual({ quiet: true, nextAllowedAt: at("2026-10-14T13:00:00Z") });
    expect(evaluateQuietHours(at("2026-10-13T15:20:00Z"), DEMO)).toEqual({ quiet: false });
  });
});

describe("other windows and zones", () => {
  it("handle a window that does not wrap midnight", () => {
    const siesta = quietHours("America/Mexico_City", { start: "14:00", end: "16:00" });
    expect(isQuietAt(at("2026-10-13T19:59:00Z"), siesta)).toBe(false); // 13:59
    expect(isQuietAt(at("2026-10-13T20:00:00Z"), siesta)).toBe(true); // 14:00
    expect(iso(quietEndsAt(at("2026-10-13T21:00:00Z"), siesta))).toBe("2026-10-13T22:00:00.000Z"); // 15:00 → 16:00
  });

  it("follow the zone's own offset, daylight saving time included", () => {
    const tijuana = quietHours("America/Tijuana");
    // 13/10 21:30 in Tijuana (UTC−7): quiet until 07:00 of 14/10 local = 14:00Z.
    expect(iso(quietEndsAt(at("2026-10-14T04:30:00Z"), tijuana))).toBe("2026-10-14T14:00:00.000Z");
    // After the fall-back change (UTC−8), 07:00 local is 15:00Z.
    expect(iso(quietEndsAt(at("2026-11-02T06:00:00Z"), tijuana))).toBe("2026-11-02T15:00:00.000Z");
  });

  it("parse the settings in object or text form and refuse an empty or unknown window", () => {
    expect(parseQuietHoursWindow("21:00-07:00")).toEqual(DEFAULT_QUIET_HOURS);
    expect(parseQuietHoursWindow({ start: "22:00", end: "06:30" })).toEqual({ start: "22:00", end: "06:30" });
    expect(() => parseQuietHoursWindow("21:00-21:00")).toThrow();
    expect(() => parseQuietHoursWindow("21:00-07:00-08:00")).toThrow(RangeError);
    expect(() => parseQuietHoursWindow({ start: "9pm", end: "07:00" })).toThrow();
    expect(() => quietHours("Mars/Olympus_Mons")).toThrow();
  });
});
