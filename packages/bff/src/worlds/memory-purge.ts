// Purge of AgentCore Memory for the installers of a world's past epoch (docs/architecture.md §9.3): the
// second layer after a new epoch gives a reset world new actors (`<installerId>-e<epoch>`,
// turns/identity.ts) and new sessions. The three strategies extract asynchronously, so a record of the
// last turn may appear after a first deletion; the purge runs in passes, one module for its callers
// ("Reiniciar demo", "Saltar a escena", `world.destroy`, `WorldJanitor`, `GuestAccountDeletion`, `seed:load`):
//
//   pass 1     in the call itself (`purgeFirstPass`)
//   pass 2     60 real seconds later
//   listings   every 15 s over the sessions' events and the actors' records, deleting what they find,
//              until two listings in a row find nothing
//   cap        10 minutes from pass 1: `ACTION MEMORY_PURGE_INCOMPLETE` and one log line with the
//              `MemoryPurgeIncomplete` metric
//
// From the console and the `QaDriver` the passes after the first run in `WorldJanitor` (asynchronous
// invocation with `MEMORY_PURGE`); `seed:load` and the nightly job run every pass in the same process.
// Nothing here trusts the event: every actor must belong to the world and the epoch it names.
import { z } from "zod";
import { ClockId, clockTagOf, parseClockId } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";
import type { Logger } from "../lib/log";

/** Memory as the purge sees it; memory-admin.ts pages through every listing. */
export interface MemoryAdmin {
  /** Sessions Memory lists for the actor; `[]` when the role may not list them (the computed ones still go). */
  listSessionIds(actorId: string): Promise<string[]>;
  listEventIds(actorId: string, sessionId: string): Promise<string[]>;
  deleteEvent(actorId: string, sessionId: string, eventId: string): Promise<void>;
  /** Ids of the records in every namespace that starts with the prefix. */
  listRecordIds(namespacePrefix: string): Promise<string[]>;
  deleteRecord(recordId: string): Promise<void>;
  /** Every actor with a record under `/installers/` (the nightly sweep of expired sign-up generations). */
  listRecordActors(): Promise<string[]>;
}

/** Root of an actor's three namespaces (`/installers/{actorId}/tips/`, `…/preferences/`, `…/<session>/summary/`). */
export function actorNamespace(actorId: string): string {
  return `/installers/${actorId}/`;
}

const ActorId = z.string().regex(/^inst-[A-Za-z0-9-]{1,200}-e\d{1,6}$/, "expected an actor id inst-…-e<epoch>");
const SessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "expected a session id");

/** The actors of one past epoch of a world and the Harness sessions each one may have had. */
export const PurgeTarget = z
  .object({
    clockId: ClockId,
    epoch: z.int().min(0),
    actorIds: z.array(ActorId).max(500),
    sessions: z.array(z.object({ actorId: ActorId, sessionId: SessionId }).strict()).max(5_000),
    /** Real instant of pass 1: the 10-minute cap counts from here. */
    startedAtReal: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PurgeTarget = z.infer<typeof PurgeTarget>;

/** Event of the asynchronous invocation of `WorldJanitor`; without `startedAtReal` the cap counts from its arrival. */
export const MemoryPurgeEvent = PurgeTarget.extend({ kind: z.literal("MEMORY_PURGE"), startedAtReal: PurgeTarget.shape.startedAtReal.optional() }).strict();
export type MemoryPurgeEvent = z.input<typeof MemoryPurgeEvent>;

export const PURGE_TIMING = {
  secondPassAfterMs: 60_000,
  listingEveryMs: 15_000,
  emptyListingsToStop: 2,
  capMs: 10 * 60_000,
} as const;

export const MEMORY_PURGE_INCOMPLETE_METRIC = "MemoryPurgeIncomplete";
export const MEMORY_PURGE_INCOMPLETE_LOG = "worlds.memory_purge_incomplete";

export interface PurgeDeps {
  readonly memory: MemoryAdmin;
  readonly data: Pick<Connector, "audit">;
  readonly log: Logger;
  /** Real time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Whether an actor is an installer of the world of `clockId` in `epoch`: a guest world's installers carry
 * its clock tag (`inst-rogelio-g07`), a QA or evaluation world's start with its clock id
 * (`inst-qa-812-1-sc-02-a`), the demo world's are the plain ones of the seed (never a QA or tagged id).
 */
export function actorBelongsTo(clockId: string, epoch: number, actorId: string): boolean {
  const suffix = `-e${epoch}`;
  if (!ActorId.safeParse(actorId).success || !actorId.endsWith(suffix)) return false;
  const installerId = actorId.slice(0, -suffix.length);
  const parsed = parseClockId(clockId);
  if (parsed === undefined) return false;
  if (parsed.kind === "QA" || parsed.kind === "EVAL") return installerId.startsWith(`inst-${clockId}-`);
  if (parsed.kind === "GUEST") return installerId.endsWith(`-${clockTagOf(clockId) ?? "?"}`);
  return !/^inst-(?:qa|eval)-/.test(installerId) && !/-g(?:\d{2}|test|s\d{6}[a-z2-7]{5})$/.test(installerId);
}

/** The target's sessions plus every other session Memory lists for its actors. */
async function sessionsOf(memory: MemoryAdmin, target: Pick<PurgeTarget, "actorIds" | "sessions">): Promise<Array<{ actorId: string; sessionId: string }>> {
  const seen = new Map(target.sessions.map((session) => [`${session.actorId}/${session.sessionId}`, session]));
  for (const actorId of target.actorIds) {
    for (const sessionId of await memory.listSessionIds(actorId)) seen.set(`${actorId}/${sessionId}`, { actorId, sessionId });
  }
  return [...seen.values()];
}

/** Lists and deletes everything of the target once; how many events and records it found. */
export async function purgePass(memory: MemoryAdmin, target: Pick<PurgeTarget, "actorIds" | "sessions">): Promise<number> {
  let found = 0;
  for (const { actorId, sessionId } of await sessionsOf(memory, target)) {
    const events = await memory.listEventIds(actorId, sessionId);
    found += events.length;
    for (const eventId of events) await memory.deleteEvent(actorId, sessionId, eventId);
  }
  for (const actorId of target.actorIds) {
    const records = await memory.listRecordIds(actorNamespace(actorId));
    found += records.length;
    for (const recordId of records) await memory.deleteRecord(recordId);
  }
  return found;
}

/** Throws unless every actor of the target belongs to its world and epoch. */
export function assertOwnActors(target: Pick<PurgeTarget, "clockId" | "epoch" | "actorIds" | "sessions">): void {
  const foreign = [...target.actorIds, ...target.sessions.map((session) => session.actorId)].filter((actorId) => !actorBelongsTo(target.clockId, target.epoch, actorId));
  if (foreign.length > 0) throw new RangeError(`${foreign.length} actor(s) of the purge do not belong to ${target.clockId} in epoch ${target.epoch}`);
}

/** Pass 1, in the reset, jump or destroy call itself; the target the remaining passes continue with. */
export async function purgeFirstPass(deps: Pick<PurgeDeps, "memory" | "now">, target: Omit<PurgeTarget, "startedAtReal">): Promise<{ readonly target: PurgeTarget; readonly deleted: number }> {
  const parsed = PurgeTarget.parse({ ...target, startedAtReal: deps.now().toISOString() });
  assertOwnActors(parsed);
  const deleted = await purgePass(deps.memory, parsed);
  return { target: parsed, deleted };
}

export interface PurgeOutcome {
  readonly complete: boolean;
  /** Passes run by this call (pass 2 and the listings). */
  readonly passes: number;
  readonly deleted: number;
}

async function recordIncomplete(deps: PurgeDeps, target: PurgeTarget, outcome: Omit<PurgeOutcome, "complete">): Promise<void> {
  deps.log.error(MEMORY_PURGE_INCOMPLETE_LOG, { metric: MEMORY_PURGE_INCOMPLETE_METRIC, value: 1, clockId: target.clockId, epoch: target.epoch, passes: outcome.passes });
  const parsed = parseClockId(target.clockId);
  if (parsed === undefined) return;
  await deps.data.audit.append({
    ispId: parsed.ispId,
    clockId: target.clockId,
    decision: "ACTION",
    action: "MEMORY_PURGE_INCOMPLETE",
    actor: "SYSTEM",
    reason: "Memory still had records of the past epoch after 10 minutes of passes",
    detail: { epoch: target.epoch, actors: target.actorIds.length, sessions: target.sessions.length, passes: outcome.passes, deleted: outcome.deleted },
  });
}

/** Pass 2 and the listings until two in a row come back empty, within the cap. */
export async function purgeRemainingPasses(deps: PurgeDeps, raw: PurgeTarget): Promise<PurgeOutcome> {
  const target = PurgeTarget.parse(raw);
  assertOwnActors(target);
  const deadline = Date.parse(target.startedAtReal) + PURGE_TIMING.capMs;
  let passes = 0;
  let deleted = 0;
  let emptyInARow = 0;
  let wait: number = PURGE_TIMING.secondPassAfterMs;
  while (emptyInARow < PURGE_TIMING.emptyListingsToStop) {
    if (deps.now().getTime() + wait > deadline) {
      // One last listing right away: the previous one may have deleted the last of it.
      const last = await purgePass(deps.memory, target);
      passes += 1;
      deleted += last;
      if (last === 0) break;
      await recordIncomplete(deps, target, { passes, deleted });
      return { complete: false, passes, deleted };
    }
    await deps.sleep(wait);
    const found = await purgePass(deps.memory, target);
    passes += 1;
    deleted += found;
    // Pass 2 deletes what arrived after pass 1 and does not count as a listing.
    if (passes > 1) emptyInARow = found === 0 ? emptyInARow + 1 : 0;
    wait = PURGE_TIMING.listingEveryMs;
  }
  deps.log.info("worlds.memory_purge_done", { clockId: target.clockId, epoch: target.epoch, passes, deleted });
  return { complete: true, passes, deleted };
}

/** Every pass in this process: the first and the rest (`seed:load`, `WorldJanitor`, tests). */
export async function purgeAllPasses(deps: PurgeDeps, target: Omit<PurgeTarget, "startedAtReal">): Promise<PurgeOutcome> {
  const first = await purgeFirstPass(deps, target);
  const rest = await purgeRemainingPasses(deps, first.target);
  return { ...rest, deleted: rest.deleted + first.deleted };
}
