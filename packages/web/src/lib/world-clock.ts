// The world clock as the shell reads it (ADR-0010, docs/architecture.md §8): the simulated time of
// the user's world, its mode, and whether the world is busy (a turn, a transcription, a photo
// validation, a queued event or an email waiting for its first SES event). `clock.get` feeds the
// simulated-time bar of every view; the shell polls it every 3 s while something is in progress and
// every 15 s at rest (docs/design-brief.md §6). Everything here is pure: formatting, the polling
// interval and the choice of what the bar says while the world is busy.
import { CalendarDate, ClockMode, IsoInstant, TimerKind, type Weekday, weekdayOf } from "@cuadrilla/shared";
import { z } from "zod";

/** Procedures of the `clock` router the shell calls (docs/tool-catalog.md, "Procedimientos de la consola"). */
export const CLOCK_PROCEDURES = {
  get: "clock.get",
  advanceToNext: "clock.advanceToNext",
  advance: "clock.advance",
} as const;

/** The bar's "+10 min" and "+1 h": `clock.advance({ minutes })`. */
export const ADVANCE_STEPS = [10, 60] as const;
export type AdvanceStep = (typeof ADVANCE_STEPS)[number];

/** While something is in progress (or the clock runs in real time) and at rest. */
export const LIVE_POLL_MS = 3_000;
export const IDLE_POLL_MS = 15_000;

/** "Avanzar igual" appears once the world has been busy this long (docs/architecture.md §8). */
export const FORCE_AFTER_MS = 5 * 60_000;

// Simulated instants carry the world's own offset (`2026-10-13T09:20:00-06:00`, America/Mexico_City):
// the wall time is read from the string itself, so no time-zone database is involved.
const SIM_INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const SimInstant = z.string().regex(SIM_INSTANT, "expected an ISO 8601 instant with offset").pipe(IsoInstant);

export const PendingKind = z.enum(["TURN", "TRANSCRIBE", "VALIDATION", "EVENT", "MAIL"]);
export type PendingKind = z.infer<typeof PendingKind>;

/** Something the world is waiting for; `sinceReal` is real time (docs/architecture.md §8, `WORLD_BUSY`). */
export const PendingWork = z.looseObject({
  kind: PendingKind,
  detail: z.string().optional(),
  sinceReal: IsoInstant,
});
export type PendingWork = z.infer<typeof PendingWork>;

/** A pending `TIMER#` of the world, with the reason the console shows. */
export const UpcomingEvent = z.looseObject({
  kind: TimerKind,
  dueAtSim: SimInstant,
  reason: z.string().optional(),
});
export type UpcomingEvent = z.infer<typeof UpcomingEvent>;

/** Answer of `clock.get`. Loose: what the BFF adds later does not break an older console. */
export const WorldClock = z.looseObject({
  mode: ClockMode,
  simNow: SimInstant,
  busy: z.boolean(),
  pending: z.array(PendingWork).default([]),
  next: z.array(UpcomingEvent).default([]),
});
export type WorldClock = z.infer<typeof WorldClock>;

/** Input of `clock.advance`. */
export const AdvanceInput = z.object({ minutes: z.number().int().positive().max(3 * 24 * 60) }).strict();
export type AdvanceInput = z.infer<typeof AdvanceInput>;

export interface SimTimeParts {
  readonly date: CalendarDate;
  readonly weekday: Weekday;
  /** `dd/mm`. */
  readonly dayMonth: string;
  /** `HH:MM`. */
  readonly time: string;
}

export function simTimeParts(iso: string): SimTimeParts {
  const match = SIM_INSTANT.exec(iso);
  if (!match) throw new RangeError(`not a simulated instant: ${iso}`);
  const date = CalendarDate.parse(match[1]);
  const [, month, day] = date.split("-");
  return { date, weekday: weekdayOf(date), dayMonth: `${day}/${month}`, time: `${match[2]}:${match[3]}` };
}

/** "mar 13/10 09:20", with the weekday abbreviations of the surface's language. */
export function formatSimTime(iso: string, weekdays: Readonly<Record<Weekday, string>>): string {
  const parts = simTimeParts(iso);
  return `${weekdays[parts.weekday]} ${parts.dayMonth} ${parts.time}`;
}

/** Something in progress (or a clock running in real time) is polled fast; a quiet world slowly. */
export function pollIntervalMs(clock: WorldClock | undefined): number {
  if (!clock) return IDLE_POLL_MS;
  return clock.busy || clock.mode === "RUNNING" ? LIVE_POLL_MS : IDLE_POLL_MS;
}

/** What the world has been waiting for longest: the item the bar names. */
export function oldestPending(pending: readonly PendingWork[]): PendingWork | undefined {
  return pending.reduce<PendingWork | undefined>((oldest, item) => (oldest === undefined || Date.parse(item.sinceReal) < Date.parse(oldest.sinceReal) ? item : oldest), undefined);
}

/** True once a busy world has waited `FORCE_AFTER_MS` (real time) for its oldest pending item. */
export function forceAvailable(clock: WorldClock | undefined, nowRealMs: number): boolean {
  if (!clock?.busy) return false;
  const oldest = oldestPending(clock.pending);
  return oldest !== undefined && nowRealMs - Date.parse(oldest.sinceReal) >= FORCE_AFTER_MS;
}
