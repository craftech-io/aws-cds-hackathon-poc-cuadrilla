// "Now" for every deterministic rule (ADR-0010). Nothing in services/, policy/ or the tools reads the
// machine clock: they receive a `Clock`, so tests run with fixed dates. Every work order lives in the
// simulated time of its world's demo clock (`Runtime/CLOCK#<clockId>`, docs/architecture.md §8):
//
//   PAUSED   simNow = pausedSimNow; only the controls ("Iniciar el día", "Avanzar al próximo evento",
//            "+10 min", "+1 h", "Forzar vencimiento") move it
//   RUNNING  simNow = realNow + offsetMs, until `runningUntilReal` (30 real minutes); then the world
//            reads as paused at the simulated instant it had reached
//
// This module reads that state and computes the mode transitions as pure functions; persisting them
// (conditional on `version`) and dispatching timers belong to packages/bff/src/clock/ (WP-36).
// Tokens, presigned URLs, logins, anti-abuse limits and cost caps use real time (`systemClock`).
import { z } from "zod";
import { ClockId, ClockMode, ConnectorError, IsoInstant } from "@cuadrilla/shared";

export interface Clock {
  now(): Promise<Date>;
}

/** Real time. Only for what is real by definition: token ages, TTLs, cost caps, audit stamps. */
export const systemClock: Clock = { now: async () => new Date() };

export function fixedClock(instant: string | Date): Clock {
  const date = instant instanceof Date ? new Date(instant.getTime()) : new Date(IsoInstant.parse(instant));
  if (Number.isNaN(date.getTime())) throw new RangeError("fixedClock needs a valid instant");
  return { now: async () => new Date(date.getTime()) };
}

/** "Reloj en vivo" lasts 30 real minutes, then the world pauses itself. */
export const RUNNING_WINDOW_MS = 30 * 60_000;

/**
 * The fields of `Runtime/CLOCK#<clockId>` that define simulated time; the item carries more
 * (`world`, `ispId`, `settings`, `version`), which this schema ignores. `clockId` is in the key; an
 * item that also carries it must name the same world.
 */
export const WorldClockTime = z.object({
  clockId: ClockId.optional(),
  mode: ClockMode,
  /** Simulated instant while PAUSED, and the instant the world had when it last started running. */
  pausedSimNow: IsoInstant,
  /** simNow − realNow while RUNNING. */
  offsetMs: z.number().int().default(0),
  /** Real instant a RUNNING world pauses itself at. */
  runningUntilReal: IsoInstant.optional(),
  worldEpoch: z.number().int().min(0),
});
export type WorldClockTime = z.infer<typeof WorldClockTime>;

/** What a world clock reads; accepts the whole `CLOCK#` item of the connector (extra keys ignored). */
export type WorldClockInput = z.input<typeof WorldClockTime>;

function parseState(state: WorldClockInput): WorldClockTime {
  return WorldClockTime.parse(state);
}

function msOf(instant: string): number {
  return new Date(instant).getTime();
}

/** True while a RUNNING world has not reached `runningUntilReal`. */
export function isRunning(state: WorldClockInput, realNowMs: number): boolean {
  const time = parseState(state);
  if (time.mode !== "RUNNING") return false;
  return time.runningUntilReal === undefined || realNowMs < msOf(time.runningUntilReal);
}

/** The mode the world is in at `realNowMs`: an expired RUNNING window reads as PAUSED. */
export function effectiveMode(state: WorldClockInput, realNowMs: number): ClockMode {
  return isRunning(state, realNowMs) ? "RUNNING" : "PAUSED";
}

/** Simulated "now" of a world at the real instant `realNowMs`. */
export function simNowOf(state: WorldClockInput, realNowMs: number): Date {
  const time = parseState(state);
  if (time.mode === "PAUSED") return new Date(msOf(time.pausedSimNow));
  const until = time.runningUntilReal === undefined ? realNowMs : Math.min(realNowMs, msOf(time.runningUntilReal));
  return new Date(until + time.offsetMs);
}

/** Real instant a simulated instant falls on in a RUNNING world (`dueAtReal = dueAtSim − offsetMs`). */
export function realInstantOf(state: WorldClockInput, simInstant: Date): Date {
  const target = simInstant.getTime();
  if (Number.isNaN(target)) throw new RangeError("realInstantOf needs a valid instant");
  return new Date(target - parseState(state).offsetMs);
}

/** Fields that change in a mode transition or a move; the caller writes them with a version check. */
export interface ClockPatch {
  readonly mode: ClockMode;
  readonly pausedSimNow: string;
  readonly offsetMs: number;
  readonly runningUntilReal: string | undefined;
}

/** "Reloj en vivo": keeps the current simulated instant and lets it run for `windowMs` real ms. */
export function startRunning(state: WorldClockInput, realNowMs: number, windowMs: number = RUNNING_WINDOW_MS): ClockPatch {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError(`invalid running window ${windowMs}`);
  const simNow = simNowOf(state, realNowMs).getTime();
  return { mode: "RUNNING", pausedSimNow: new Date(simNow).toISOString(), offsetMs: simNow - realNowMs, runningUntilReal: new Date(realNowMs + windowMs).toISOString() };
}

/** Back to PAUSED at the simulated instant the world has reached. */
export function pauseAt(state: WorldClockInput, realNowMs: number): ClockPatch {
  const time = parseState(state);
  return { mode: "PAUSED", pausedSimNow: simNowOf(time, realNowMs).toISOString(), offsetMs: time.offsetMs, runningUntilReal: undefined };
}

/**
 * Moves the simulated time to `targetSim` (`advance`, `advanceTo`, `advanceToNext`, `unfreeze`)
 * keeping the mode: a paused world gets a new `pausedSimNow`, a running one a new `offsetMs`. The
 * clock never goes back; only "Reiniciar demo" reloads a world from its template.
 */
export function moveTo(state: WorldClockInput, targetSim: Date, realNowMs: number): ClockPatch {
  const time = parseState(state);
  const target = targetSim.getTime();
  if (Number.isNaN(target)) throw new RangeError("moveTo needs a valid instant");
  const current = simNowOf(time, realNowMs).getTime();
  if (target < current) throw new RangeError(`the clock never goes back (${new Date(current).toISOString()} → ${targetSim.toISOString()})`);
  if (!isRunning(time, realNowMs)) return { mode: "PAUSED", pausedSimNow: new Date(target).toISOString(), offsetMs: time.offsetMs, runningUntilReal: undefined };
  return { mode: "RUNNING", pausedSimNow: time.pausedSimNow, offsetMs: target - realNowMs, runningUntilReal: time.runningUntilReal };
}

export interface WorldClockSnapshot {
  readonly clockId: ClockId;
  readonly mode: ClockMode;
  readonly simNow: Date;
  readonly worldEpoch: number;
}

/** A world's clock: `now()` is the simulated time, read fresh from the stored state on every call. */
export interface WorldClock extends Clock {
  readonly clockId: ClockId;
  snapshot(): Promise<WorldClockSnapshot>;
}

export interface WorldClockDeps {
  /** Reads `Runtime/CLOCK#<clockId>` (the connector); `undefined` when the world does not exist. */
  readonly readClock: (clockId: ClockId) => Promise<WorldClockInput | undefined>;
  /** Real time the RUNNING mode is measured against. */
  readonly realClock?: Clock;
}

/** The injectable clock of one world (ADR-0010): every rule of that world asks it for "now". */
export function worldClock(clockId: string, deps: WorldClockDeps): WorldClock {
  const id = ClockId.parse(clockId);
  const realClock = deps.realClock ?? systemClock;

  async function snapshot(): Promise<WorldClockSnapshot> {
    const stored = await deps.readClock(id);
    if (stored === undefined) throw new ConnectorError("NOT_FOUND", `clock "${id}" does not exist`, "Runtime");
    const time = parseState(stored);
    if (time.clockId !== undefined && time.clockId !== id) throw new ConnectorError("VALIDATION", `clock item "${time.clockId}" read for "${id}"`, "Runtime");
    const realNowMs = (await realClock.now()).getTime();
    return { clockId: id, mode: effectiveMode(time, realNowMs), simNow: simNowOf(time, realNowMs), worldEpoch: time.worldEpoch };
  }

  return { clockId: id, snapshot, now: async () => (await snapshot()).simNow };
}
