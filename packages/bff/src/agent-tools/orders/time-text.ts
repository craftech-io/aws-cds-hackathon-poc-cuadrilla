// The `…Text` of every business date the orders tools return (docs/tool-catalog.md "Fechas"): the
// simulated instant on the operator's wall clock, already written in es-MX, so the model copies it and
// never computes a date. Digits and fixed words only, built from the zoned parts (no `Intl` wording):
// "hoy martes 13/10", "09:00 a 11:00", "martes 13/10 09:20". The order choice list of the day plan uses
// the same window text, so a window reads the same in every message.
import { type CalendarDate, type Weekday, weekdayOf } from "@cuadrilla/shared";
import { formatWindow } from "../../copy/helpers";
import type { AppointmentWindow } from "../../domain/work-orders";
import { zonedParts } from "../../services/business-hours/zoned-time";

const WEEKDAY_ES: Readonly<Record<Weekday, string>> = {
  MON: "lunes",
  TUE: "martes",
  WED: "miércoles",
  THU: "jueves",
  FRI: "viernes",
  SAT: "sábado",
  SUN: "domingo",
};

/** Days around the reference day that get a word of their own. */
const RELATIVE_DAY: Readonly<Record<string, string>> = { "-1": "ayer", "0": "hoy", "1": "mañana" };

function instantOf(value: string | Date): Date {
  const instant = typeof value === "string" ? new Date(Date.parse(value)) : value;
  if (Number.isNaN(instant.getTime())) throw new RangeError("invalid instant");
  return instant;
}

/** `13/10`. */
export function shortDate(date: CalendarDate): string {
  const [, month = "", day = ""] = date.split("-");
  return `${day}/${month}`;
}

/** Whole days from `from` to `to` (both calendar dates). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** "hoy martes 13/10", "mañana miércoles 14/10", "ayer lunes 12/10", "jueves 15/10": `date` seen from `today`. */
export function dayText(date: CalendarDate, today: CalendarDate): string {
  const named = `${WEEKDAY_ES[weekdayOf(date)]} ${shortDate(date)}`;
  const relative = RELATIVE_DAY[String(daysBetween(today, date))];
  return relative === undefined ? named : `${relative} ${named}`;
}

/** "09:00 a 11:00": an appointment window on the operator's wall clock. */
export function windowText(window: AppointmentWindow, timeZone: string): string {
  return formatWindow(zonedParts(instantOf(window.startSim), timeZone).time, zonedParts(instantOf(window.endSim), timeZone).time);
}

/** "martes 13/10 09:20": the simulated now of the world. */
export function instantText(value: string | Date, timeZone: string): string {
  const parts = zonedParts(instantOf(value), timeZone);
  return `${WEEKDAY_ES[parts.weekday]} ${shortDate(parts.date)} ${parts.time}`;
}

/** "hoy 09:21" (or "ayer 18:02", "lunes 12/10 18:02"): an observation seen from `today`. */
export function observedText(value: string | Date, today: CalendarDate, timeZone: string): string {
  const parts = zonedParts(instantOf(value), timeZone);
  const relative = RELATIVE_DAY[String(daysBetween(today, parts.date))];
  return `${relative ?? `${WEEKDAY_ES[parts.weekday]} ${shortDate(parts.date)}`} ${parts.time}`;
}
