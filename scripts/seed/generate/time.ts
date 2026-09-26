// Simulated time of the seed without `Intl` (docs/seed-spec.md, "Determinismo"): every business
// instant is written in America/Mexico_City, which has kept UTC−06:00 all year since 2022, so a fixed
// offset formats it the same on any machine.
const OFFSET_MINUTES = -6 * 60;
const OFFSET = "-06:00";

/** Days of the story (docs/seed-spec.md §3, §7): the closed history, the demo day and the next one. */
export const DAYS = { history: "2026-10-12", demo: "2026-10-13", next: "2026-10-14" } as const;

/** Start of every world clock: Tuesday 13/10/2026, 07:00 in Mexico City. */
export const WORLD_START_SIM = `${DAYS.demo}T07:00:00${OFFSET}`;

/** When `DAY_START` fires for every active installer (docs/architecture.md §8). */
export const DAY_START_TIME = "07:30";

/** Window of the judges' tour on 13/10 (docs/seed-spec.md §3). */
export const TOUR_WINDOW = { start: `${DAYS.demo}T07:00:00${OFFSET}`, end: `${DAYS.demo}T15:30:00${OFFSET}` } as const;

function pad(value: number, width = 2): string {
  return value.toString().padStart(width, "0");
}

/** `2026-10-13T09:00:00-06:00` from a calendar date and `HH:MM`. */
export function sim(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError(`invalid date or time: ${date} ${time}`);
  return `${date}T${time}:00${OFFSET}`;
}

/** The same instant written in Mexico City time. */
export function toLocal(instant: string | number): string {
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError(`invalid instant: ${String(instant)}`);
  const local = new Date(ms + OFFSET_MINUTES * 60_000);
  const date = `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  return `${date}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${OFFSET}`;
}

export function addMinutes(instant: string, minutes: number): string {
  return toLocal(Date.parse(instant) + minutes * 60_000);
}

/** Calendar date of an instant in Mexico City. */
export function localDate(instant: string): string {
  return toLocal(instant).slice(0, 10);
}
