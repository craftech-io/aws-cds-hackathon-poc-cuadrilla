// `WorldJanitor` (docs/architecture.md §8 and §9.3, infra/scheduler.ts): two entries, each validated.
//
//   MEMORY_PURGE       invoked asynchronously by the `Bff` and the `QaDriver` after a reset, a scene jump
//                      or a destruction: pass 2 and the listings of the Memory purge, up to its 10 minutes
//   IDLE_GUEST_RESET   the nightly run (04:00 America/Mexico_City):
//                      - every invited guest world (`GUEST#isp-guest-<nn>`) that moved since its last
//                        reset and saw no activity for 24 real hours is reset ("Reiniciar demo" as the
//                        janitor: real-time counters kept, Memory purged in passes in this process)
//                      - the Memory of the generations of the own sign-up that expired (their items went
//                        by TTL; their actors' records did not) is purged: the actors come from the
//                        namespaces Memory lists, and only actors of a generation whose world is gone or
//                        past its expiry are touched
//
// Nothing else: never a demo, QA or evaluation world, never a world of the rehearsal or of a sign-up
// that is still alive.
import { z } from "zod";
import { GUEST_TEST_CLOCK_ID, clockIdOfIsp, guestClockId, isSignupGuestIsp } from "@cuadrilla/shared";
import { signupGenerationExpiresAt } from "../connector/world";
import type { Clock } from "../domain/runtime";
import type { WorldsDeps } from "./deps";
import { MemoryPurgeEvent, type PurgeDeps, type PurgeTarget, purgeFirstPass, purgeRemainingPasses } from "./memory-purge";
import { resetWorld } from "./rebuild";
import { GUEST_WORLD_START_SIM } from "./template";

export const NightlyEvent = z.object({ kind: z.literal("IDLE_GUEST_RESET") }).strict();
export const JanitorEvent = z.union([NightlyEvent, MemoryPurgeEvent]);

/** A guest world quiet for this long is reset at night. */
export const IDLE_MS = 24 * 60 * 60_000;
/** Invited guest slots (`isp-guest-01` … `isp-guest-98`; 99 is the rehearsal's phone block). */
export const INVITED_SLOTS = { first: 1, last: 98 } as const;

export interface JanitorOutcome {
  readonly kind: "MEMORY_PURGE" | "IDLE_GUEST_RESET";
  readonly reset: readonly string[];
  readonly purgedActors: number;
  readonly complete: boolean;
}

function purgeDeps(deps: WorldsDeps, sleep: (ms: number) => Promise<void>): PurgeDeps {
  if (deps.memory === undefined) throw new RangeError("WorldJanitor runs with the Memory link");
  return { memory: deps.memory, data: deps.connector, log: deps.log, now: deps.now, sleep };
}

/** The last real instant something happened in the world: its clock or its in-flight state moved. */
async function lastActivityOf(deps: WorldsDeps, clock: Clock): Promise<{ readonly at: number; readonly moved: boolean }> {
  const state = await deps.connector.worlds.getWorldState(clock.clockId);
  // A guest world built by the minimal factory has not recorded its start yet: it is the template's.
  const startAtSim = typeof clock.settings?.startAtSim === "string" ? clock.settings.startAtSim : GUEST_WORLD_START_SIM;
  const moved = state !== undefined || clock.mode === "RUNNING" || Date.parse(clock.pausedSimNow) !== Date.parse(startAtSim);
  const at = Math.max(Date.parse(clock.updatedAt), state === undefined ? 0 : Date.parse(state.updatedAt));
  return { at, moved };
}

async function resetIdleWorlds(deps: WorldsDeps): Promise<string[]> {
  const reset: string[] = [];
  const now = deps.now().getTime();
  for (let guest = INVITED_SLOTS.first; guest <= INVITED_SLOTS.last; guest += 1) {
    const clockId = guestClockId(guest);
    const clock = await deps.connector.runtime.getClock(clockId);
    if (clock === undefined) continue;
    const activity = await lastActivityOf(deps, clock);
    if (!activity.moved || now - activity.at < IDLE_MS) continue;
    try {
      await resetWorld(deps, { clockId, caller: "JANITOR", actor: "SCHEDULER" });
      reset.push(clockId);
    } catch (error) {
      // One world that cannot be reset tonight never stops the others; tomorrow it is tried again.
      deps.log.error("worlds.janitor_reset_failed", { clockId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return reset;
}

const SIGNUP_ACTOR = /^(inst-[A-Za-z0-9-]+-g(s\d{6}[a-z2-7]{5}))-e(\d{1,6})$/;

/** Groups the actors of expired sign-up generations by world and epoch. */
async function expiredGenerationTargets(deps: WorldsDeps): Promise<Array<Omit<PurgeTarget, "startedAtReal">>> {
  if (deps.memory === undefined) return [];
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const groups = new Map<string, Omit<PurgeTarget, "startedAtReal"> & { actorIds: string[] }>();
  const alive = new Map<string, boolean>();
  for (const actorId of await deps.memory.listRecordActors()) {
    const match = SIGNUP_ACTOR.exec(actorId);
    if (match === null) continue;
    const ispId = `isp-guest-${match[2] ?? ""}`;
    if (!isSignupGuestIsp(ispId)) continue;
    const clockId = clockIdOfIsp(ispId);
    if (!alive.has(clockId)) {
      const expiresAt = signupGenerationExpiresAt(ispId);
      const expired = expiresAt !== undefined && expiresAt <= nowSeconds;
      alive.set(clockId, !expired && (await deps.connector.runtime.getClock(clockId)) !== undefined);
    }
    if (alive.get(clockId) === true || clockId === GUEST_TEST_CLOCK_ID) continue;
    const epoch = Number(match[3]);
    const key = `${clockId}#${epoch}`;
    const group = groups.get(key) ?? { clockId, epoch, actorIds: [], sessions: [] };
    group.actorIds.push(actorId);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** One run of `WorldJanitor`. */
export async function runJanitor(deps: WorldsDeps, event: unknown, sleep: (ms: number) => Promise<void>): Promise<JanitorOutcome> {
  const parsed = JanitorEvent.parse(event);
  if (parsed.kind === "MEMORY_PURGE") {
    const { kind: _kind, startedAtReal, ...target } = parsed;
    const outcome = await purgeRemainingPasses(purgeDeps(deps, sleep), { ...target, startedAtReal: startedAtReal ?? deps.now().toISOString() });
    return { kind: "MEMORY_PURGE", reset: [], purgedActors: target.actorIds.length, complete: outcome.complete };
  }
  const reset = await resetIdleWorlds(deps);
  let purgedActors = 0;
  for (const target of await expiredGenerationTargets(deps)) {
    // Expired worlds have no turns any more: one pass leaves nothing new behind.
    await purgeFirstPass(purgeDeps(deps, sleep), target);
    purgedActors += target.actorIds.length;
  }
  deps.log.info("worlds.janitor_done", { reset: reset.length, purgedActors });
  return { kind: "IDLE_GUEST_RESET", reset, purgedActors, complete: true };
}

/**
 * The janitor's own `continuePurge`: the passes after the first of every reset of the run, together at
 * the end, so the nightly run waits for them once and not once per world.
 */
export function collectingPurge(): { readonly continuePurge: (target: PurgeTarget) => Promise<void>; readonly drain: (deps: PurgeDeps) => Promise<void> } {
  const pending: PurgeTarget[] = [];
  return {
    continuePurge: async (target) => {
      pending.push(target);
    },
    drain: async (deps) => {
      await Promise.all(pending.splice(0).map((target) => purgeRemainingPasses(deps, target)));
    },
  };
}
