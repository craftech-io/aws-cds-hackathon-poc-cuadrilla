// "Now" for every deterministic rule. Nothing in services/, policy/ or the tools reads the machine
// clock directly: they receive a `Clock`, so tests run with fixed dates. WP-12 adds the world clock
// (`worldClock(clockId)`, ADR-0010): every work order lives in the simulated time of its world, which
// the demo clock of the console pauses and advances.
import { IsoInstant } from "@cuadrilla/shared";

export interface Clock {
  now(): Promise<Date>;
}

/** Real time. Only for what is real by definition: token ages, TTLs in real time, audit stamps. */
export const systemClock: Clock = { now: async () => new Date() };

export function fixedClock(instant: string | Date): Clock {
  const date = instant instanceof Date ? new Date(instant.getTime()) : new Date(IsoInstant.parse(instant));
  return { now: async () => new Date(date.getTime()) };
}
