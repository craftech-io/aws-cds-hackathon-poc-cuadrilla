// How the field-work views write times, days and optical power. Simulated instants carry the world's
// own offset (the BFF zones them, routers/console-ports.ts `inWorldTime`), so the wall time is read
// from the string: no time-zone database, no `Intl`. Pure, tested in orders-model.test.ts.
import { type CalendarDate, addCalendarDays, weekdayOf } from "@cuadrilla/shared";
import { copy as consoleCopy } from "../../copy/console";
import { formatSimTime, simTimeParts } from "../../lib/world-clock";

const WEEKDAYS = consoleCopy.clock.weekdays;

/** "09:20" of a simulated instant; "—" when the instant is not one. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return simTimeParts(iso).time;
  } catch {
    return "—";
  }
}

/** "mar 13/10 09:20". */
export function simDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatSimTime(iso, WEEKDAYS);
  } catch {
    return "—";
  }
}

/** "09:00–11:00" of an appointment window. */
export function windowText(window: { readonly startSim: string; readonly endSim: string }): string {
  return `${clockTime(window.startSim)}–${clockTime(window.endSim)}`;
}

function signed(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits).replace(".", ",");
  return `${value < 0 ? "−" : ""}${text}`;
}

/** "−21,4 dBm", with the true minus sign and the decimal comma of the console's texts. */
export function dbm(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${signed(value, 1)} dBm`;
}

/** "−25 a −8 dBm" of a zone's acceptance range. */
export function rangeText(range: { readonly minDbm: number; readonly maxDbm: number } | null | undefined): string {
  if (!range) return "—";
  const digits = (value: number) => (Number.isInteger(value) ? 0 : 1);
  return `${signed(range.minDbm, digits(range.minDbm))} a ${signed(range.maxDbm, digits(range.maxDbm))} dBm`;
}

/** "mar 13/10" of a calendar day, "(hoy)" when it is the world's day. */
export function dayLabel(day: CalendarDate, today: CalendarDate, todayWord: string): string {
  const [, month, date] = day.split("-");
  const label = `${WEEKDAYS[weekdayOf(day)]} ${date}/${month}`;
  return day === today ? `${label} (${todayWord})` : label;
}

/** The days a supervisor looks at: the world's day first, then yesterday and tomorrow. */
export function nearbyDays(today: CalendarDate): readonly [CalendarDate, CalendarDate, CalendarDate] {
  return [today, addCalendarDays(today, -1), addCalendarDays(today, 1)];
}
