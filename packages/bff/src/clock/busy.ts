// Busy worlds (`WORLD_BUSY`, docs/architecture.md §7-§8, FL-085). A world is quiet when
// `WORLDSTATE#<clockId>.inFlight` is empty, no SCHEDULED timer of its clock is due (`dueAtSim ≤ simNow`)
// and `PENDING#<clockId>` has no open mail younger than 10 real minutes. From the console,
// `clock.advance*`, `forceCaseTimeout` and the demo controls change nothing in a busy world: they
// answer the pending list (`{kind: TURN | TRANSCRIBE | VALIDATION | EVENT | MAIL, detail, sinceReal}`).
// After five real minutes of the same wait the console may send `force: true` ("Avanzar igual"),
// accepted only when the oldest pending is older than that, and audited `ACTION CLOCK_FORCED`. The
// `QaDriver` never goes through this gate: it waits with `installer.settle` / `world.settle`.
//
// An in-flight entry is an event id; a producer that knows the phase may write it as
// `<KIND>:<eventId>` (`TRANSCRIBE:wa-in-…` while Transcribe works). A bare inbound id (`wa-…`) reads as
// a TURN, a timer's (`tm-…`) and anything else as an EVENT. Details are ids and kinds, never content.
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import type { Actor } from "../domain/common";
import type { Clock as StoredClock } from "../domain/runtime";
import { simNowOf } from "../lib/clock";
import { timerEventId } from "../timers/dispatch";
import { auditClock, scheduledTimers } from "./state";

export const PendingKind = z.enum(["TURN", "TRANSCRIBE", "VALIDATION", "EVENT", "MAIL"]);
export type PendingKind = z.infer<typeof PendingKind>;

/** "Avanzar igual" appears, and `force` is accepted, after the oldest pending waited this long. */
export const FORCE_AFTER_MS = 5 * 60_000;

/** `reason` of a busy world's refusal (the console maps it to its `WORLD_BUSY` answer). */
export const WORLD_BUSY = "WORLD_BUSY";

export interface WorldPending {
  readonly kind: PendingKind;
  /** An event id, a mail id or the kind of a due timer: never an address or a message. */
  readonly detail: string;
  /** Real instant the wait started (the last change of the in-flight set for events: never overstated). */
  readonly sinceReal: string;
}

/** A busy world's refusal: nothing changed, here is what it waits for. */
export class WorldBusyError extends ToolError {
  constructor(
    readonly pending: readonly WorldPending[],
    readonly forceAllowedAtReal: string,
  ) {
    super("CONFLICT", "the world is busy: wait until it is quiet", WORLD_BUSY);
  }
}

const PHASED = /^(TURN|TRANSCRIBE|VALIDATION|EVENT|MAIL):(.+)$/;

/** The kind and id of one in-flight entry. */
export function pendingOfInFlight(entry: string): { readonly kind: PendingKind; readonly detail: string } {
  const phased = PHASED.exec(entry);
  if (phased !== null) return { kind: PendingKind.parse(phased[1]), detail: phased[2] ?? entry };
  if (entry.startsWith("wa-")) return { kind: "TURN", detail: entry };
  return { kind: "EVENT", detail: entry };
}

export interface BusyDeps {
  readonly data: Pick<Connector, "worlds" | "timers" | "audit">;
  readonly realClock: { now(): Promise<Date> };
}

/** What the world waits for right now; stale pending mails are no longer waited for. */
export async function worldPending(clock: StoredClock, deps: BusyDeps): Promise<WorldPending[]> {
  const realNow = await deps.realClock.now();
  const simNow = simNowOf(clock, realNow.getTime()).toISOString();
  const [state, mails, due] = await Promise.all([deps.data.worlds.getWorldState(clock.clockId), deps.data.worlds.listPendingMail(clock.clockId), scheduledTimers(clock, deps, simNow)]);
  const since = state?.updatedAt ?? realNow.toISOString();
  const events = (state?.inFlight ?? []).map((entry): WorldPending => ({ ...pendingOfInFlight(entry), sinceReal: since }));
  const open = mails.open.map((mail): WorldPending => ({ kind: "MAIL", detail: mail.mailId, sinceReal: mail.sentAtReal }));
  // A due timer already on its way is the in-flight event above; one that is not (its dispatch was
  // lost) waits since the clock reached it or since it was written, whichever is later.
  const inFlight = new Set(events.map((event) => event.detail));
  const timers = due
    .filter((timer) => !inFlight.has(timerEventId(timer, clock.worldEpoch)))
    .map((timer): WorldPending => ({ kind: "EVENT", detail: `TIMER ${timer.kind}`, sinceReal: new Date(Math.max(Date.parse(clock.updatedAt), Date.parse(timer.updatedAt))).toISOString() }));
  return [...events, ...open, ...timers];
}

export interface GateInput {
  readonly clock: StoredClock;
  /** "Avanzar igual": accepted only once the oldest pending waited `FORCE_AFTER_MS`. */
  readonly force?: boolean;
  readonly actor: Actor;
}

/**
 * The console's gate before a move: returns when the world is quiet, or when `force` is accepted (and
 * audited); throws `WorldBusyError` otherwise. Answers whether it was forced.
 */
export async function assertWorldQuiet(input: GateInput, deps: BusyDeps): Promise<{ readonly forced: boolean }> {
  const pending = await worldPending(input.clock, deps);
  if (pending.length === 0) return { forced: false };
  const realNow = await deps.realClock.now();
  const oldest = Math.min(...pending.map((item) => Date.parse(item.sinceReal)));
  const forceAllowedAtReal = new Date(oldest + FORCE_AFTER_MS);
  if (input.force !== true || realNow.getTime() < forceAllowedAtReal.getTime()) throw new WorldBusyError(pending, forceAllowedAtReal.toISOString());
  await auditClock(deps, {
    clock: input.clock,
    action: "CLOCK_FORCED",
    actor: input.actor,
    atSim: simNowOf(input.clock, realNow.getTime()).toISOString(),
    reason: "moved a world that had been busy for five minutes",
    detail: { pending: pending.map((item) => ({ kind: item.kind, detail: item.detail, sinceReal: item.sinceReal })) },
  });
  return { forced: true };
}
