// Wall-clock time by IANA zone. Every business date of a world is simulated time shown in the
// operator's zone (`IspSettings.timezone`, America/Mexico_City in the demo): the quiet hours of
// `CP-QUIET-HOURS`, the 07:30 of `DAY_START`, the local day of `CP-ONE-DAYSTART` and the ISO 8601
// dates with offset the tools return. Every function takes the instant it evaluates; none reads a
// clock (ADR-0010).
//
// Zone offsets come from the runtime's time zone database (`Intl.DateTimeFormat`, full ICU in Node
// 22 and Lambda); no output depends on the locale: callers build texts from the parts (copy/).
import { z } from "zod";
import { CalendarDate, type Weekday, addCalendarDays, weekdayOf } from "@cuadrilla/shared";

/** Zone of the demo operator (docs/seed-spec.md §4); Mexico City has no daylight saving time. */
export const MEXICO_CITY_TIME_ZONE = "America/Mexico_City";

/** `HH:mm`, 24 h. */
export const LocalTime = z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/, "expected HH:mm");
export type LocalTime = z.infer<typeof LocalTime>;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** An IANA zone the runtime knows (`America/Mexico_City`, `America/Tijuana`, …). */
export const TimeZone = z.string().refine(isValidTimeZone, "expected an IANA time zone");

export interface ZonedParts {
  readonly date: CalendarDate;
  /** `HH:mm`. */
  readonly time: LocalTime;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: Weekday;
  /** Local time minus UTC, in minutes (−360 in Mexico City). */
  readonly offsetMinutes: number;
}

function pad(value: number, width = 2): string {
  return value.toString().padStart(width, "0");
}

function validInstant(instant: Date): number {
  const ms = instant.getTime();
  if (Number.isNaN(ms)) throw new RangeError("invalid instant");
  return ms;
}

/** Wall clock of `instant` in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const ms = validInstant(instant);
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const year = values.year ?? 0;
  const month = values.month ?? 1;
  const day = values.day ?? 1;
  const hour = (values.hour ?? 0) % 24;
  const minute = values.minute ?? 0;
  const second = values.second ?? 0;
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  const offsetMinutes = Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / 1000) * 1000) / 60_000);
  return { date, time: `${pad(hour)}:${pad(minute)}`, hour, minute, second, weekday: weekdayOf(date), offsetMinutes };
}

/** Local calendar date of `instant` in `timeZone` (the simulated day of `CP-ONE-DAYSTART`). */
export function localDateOf(instant: Date, timeZone: string): CalendarDate {
  return zonedParts(instant, timeZone).date;
}

/** Minutes since local midnight, with seconds as a fraction. */
export function minutesOfDay(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  return parts.hour * 60 + parts.minute + parts.second / 60;
}

/** Minutes since midnight of an `HH:mm`. */
export function minutesOf(time: string): number {
  const [hour = 0, minute = 0] = LocalTime.parse(time).split(":").map(Number);
  return hour * 60 + minute;
}

// Real offsets stay within ±14 h, so 36 h on either side of the wall time read as UTC lie before
// and after any transition that could affect it (zones never change twice within three days).
const BRACKET_MS = 36 * 3_600_000;

/**
 * The instant a wall clock shows `date time` in `timeZone`. A time skipped by a spring-forward
 * change lands after the gap (02:30 → 03:30); a repeated time takes the second occurrence.
 */
export function zonedInstant(date: CalendarDate, time: string, timeZone: string): Date {
  const localDate = CalendarDate.parse(date);
  const localTime = LocalTime.parse(time);
  const [year = 0, month = 1, day = 1] = localDate.split("-").map(Number);
  const [hour = 0, minute = 0] = localTime.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = zonedParts(new Date(wall - BRACKET_MS), timeZone).offsetMinutes;
  const after = zonedParts(new Date(wall + BRACKET_MS), timeZone).offsetMinutes;
  const shows = (instant: number): boolean => {
    const parts = zonedParts(new Date(instant), timeZone);
    return parts.date === localDate && parts.time === localTime;
  };
  const matching = [...new Set([before, after])].map((offset) => wall - offset * 60_000).filter(shows);
  // Two matches: the repeated hour, take the later one. None: the skipped hour, read it with the
  // offset in force before the change, which lands after the gap.
  return new Date(matching.length > 0 ? Math.max(...matching) : wall - before * 60_000);
}

/** `2026-10-13T09:20:00-06:00`: ISO 8601 with the zone's offset, as tools return business dates. */
export function toZonedIso(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  const sign = parts.offsetMinutes < 0 ? "-" : "+";
  const offset = Math.abs(parts.offsetMinutes);
  return `${parts.date}T${parts.time}:${pad(parts.second)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

/** `dayOffset` local days from `instant`'s local date, at `time` in `timeZone` (07:30 of the next day). */
export function atLocalTime(instant: Date, dayOffset: number, time: string, timeZone: string): Date {
  if (!Number.isInteger(dayOffset)) throw new RangeError(`dayOffset must be an integer, got ${dayOffset}`);
  return zonedInstant(addCalendarDays(localDateOf(instant, timeZone), dayOffset), time, timeZone);
}
