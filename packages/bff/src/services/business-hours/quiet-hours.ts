// Quiet hours of the operator by IANA zone (docs/design-brief.md §5.7, `CP-QUIET-HOURS`): from 21:00
// to 07:00 America/Mexico_City nothing proactive goes to the staff (safety, open cases and replies to
// an inbound message are exempt; the policy decides that). A window may wrap midnight. The policy
// passes the instant of the clock the recipient's transport dictates (ADR-0002): the world's
// simulated time for a synthetic identity, real time for a real phone of the live world; a phone
// leased by code gets `NOT_APPLICABLE_LEASE` and never reaches this module.
import { z } from "zod";
import { LocalTime, MEXICO_CITY_TIME_ZONE, TimeZone, atLocalTime, minutesOf, minutesOfDay } from "./zoned-time";

/** `IspSettings.quietHours`: start inclusive, end exclusive, local to the operator's zone. */
export const QuietHoursWindow = z
  .object({ start: LocalTime, end: LocalTime })
  .strict()
  .refine((window) => window.start !== window.end, { message: "a quiet window cannot start and end at the same time", path: ["end"] });
export type QuietHoursWindow = z.infer<typeof QuietHoursWindow>;

/** The demo's window (docs/seed-spec.md §4, CONTEXT.md "Horario de silencio"). */
export const DEFAULT_QUIET_HOURS: QuietHoursWindow = { start: "21:00", end: "07:00" };

/** Accepts the object form or the `"21:00-07:00"` text form of the settings. */
export function parseQuietHoursWindow(value: unknown): QuietHoursWindow {
  if (typeof value === "string") {
    const [start, end, ...rest] = value.split("-");
    if (rest.length > 0) throw new RangeError(`expected HH:mm-HH:mm, got "${value}"`);
    return QuietHoursWindow.parse({ start, end });
  }
  return QuietHoursWindow.parse(value);
}

export interface QuietHours extends QuietHoursWindow {
  readonly timeZone: string;
}

export function quietHours(timeZone: string = MEXICO_CITY_TIME_ZONE, window: unknown = DEFAULT_QUIET_HOURS): QuietHours {
  return { timeZone: TimeZone.parse(timeZone), ...parseQuietHoursWindow(window) };
}

function wrapsMidnight(quiet: QuietHours): boolean {
  return minutesOf(quiet.start) > minutesOf(quiet.end);
}

/** True inside the window: at 21:00 sharp it is quiet, at 07:00 sharp it is not. */
export function isQuietAt(instant: Date, quiet: QuietHours): boolean {
  const minutes = minutesOfDay(instant, quiet.timeZone);
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return wrapsMidnight(quiet) ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}

/**
 * `instant` itself outside the window, otherwise the instant the window ends (the `nextAllowedAt`
 * of a `DEFER`, the due time of `TIMER#DEFERRED_SEND`): 22:00 → 07:00 of the next local day,
 * 05:00 → 07:00 of the same day.
 */
export function quietEndsAt(instant: Date, quiet: QuietHours): Date {
  if (!isQuietAt(instant, quiet)) return new Date(instant.getTime());
  const endsTomorrow = wrapsMidnight(quiet) && minutesOfDay(instant, quiet.timeZone) >= minutesOf(quiet.start);
  return atLocalTime(instant, endsTomorrow ? 1 : 0, quiet.end, quiet.timeZone);
}

export type QuietHoursDecision = { readonly quiet: false } | { readonly quiet: true; readonly nextAllowedAt: Date };

/** What `CP-QUIET-HOURS` needs in one call: whether the instant is quiet and, if so, until when. */
export function evaluateQuietHours(instant: Date, quiet: QuietHours): QuietHoursDecision {
  return isQuietAt(instant, quiet) ? { quiet: true, nextAllowedAt: quietEndsAt(instant, quiet) } : { quiet: false };
}
