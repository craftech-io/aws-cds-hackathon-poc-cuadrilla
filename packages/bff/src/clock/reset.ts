// `reset_demo_world` and `jump_to_scene` (docs/architecture.md §8, docs/tool-catalog.md, ADR-0010), the
// clock's half of both; the other half (writing the world again from its template, a scene's seeded
// state, the Memory purge in passes) is the world factory's (`WorldRebuild`, worlds/, WP-39).
//
//   1. limits. "Reiniciar demo" from the console: once every 10 real minutes per world
//      (`Clock.settings.lastResetAtReal`, written first and pinned to the clock's version, so two
//      concurrent resets cannot both run); the `QaDriver`, `WorldJanitor` and `seed:load` are exempt.
//      "Saltar a escena": only `GUEST` and `qa-*` worlds, outside the reset limit, with its own limit
//      of scene jumps per real hour per world (`JUMP#<clockId>#<realHour>`, conditional; 30, or the
//      world's `simulatorCaps.sceneJumpsPerRealHour`; `CAP_REACHED` with when it frees up);
//   2. the epoch goes up from `COUNTER#EPOCH#<clockId>` (`ADD`: never back, never reused) and
//      `TOMB#<clockId>#<previous epoch>` is written;
//   3. the world's schedules go, then every item of the world except what both keep
//      (clock/world-items.ts: `CLOCK#`, `COUNTER#EPOCH#` and the real-time counters `RATE#…#REAL#…`,
//      `SIMCAP#`, `TURNCAP#`, `JUMP#`, so neither empties a world's caps), phone leases included;
//   4. the clock is PAUSED at the world's start with the new epoch;
//   5. the factory writes the world again (`reload`, with the scene for a jump) and answers where its
//      clock stands; the Memory of the previous epoch's installers is purged (`purgeMemory`);
//   6. `ACTION WORLD_RESET` or `WORLD_SCENE_JUMP`. No other world changes.
import { z } from "zod";
import { ConnectorError, IsoInstant, ToolError, ispKindOfClock } from "@cuadrilla/shared";
import { COUNTER_KEYS, hourKey } from "../connector/keys";
import type { Connector } from "../connector/ports";
import type { TableClient } from "../connector/table-client";
import type { Actor, JsonObject } from "../domain/common";
import type { Clock as StoredClock } from "../domain/runtime";
import type { Tombstone } from "../domain/runtime-world";
import { simNowOf } from "../lib/clock";
import { readWorldClock } from "../timers/timers";
import { type ClockDeps, auditClock, scheduledTimers } from "./state";
import { type DeletedCounts, purgeWorldItems } from "./world-items";

/** "Reiniciar demo" from the console: at most once every 10 real minutes per world. */
export const CONSOLE_RESET_INTERVAL_MS = 10 * 60_000;

/** Scene jumps per real hour per world unless its settings say otherwise (docs/architecture.md §8). */
export const DEFAULT_SCENE_JUMPS_PER_REAL_HOUR = 30;

/** How far back a world whose start is not recorded is searched (orders, decisions, rate counters). */
export const UNKNOWN_START_LOOKBACK_MS = 3 * 24 * 60 * 60_000;

/** A counter behind its world catches up at most this many steps. */
const MAX_EPOCH_CATCH_UP = 1_000;

export const SceneId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "expected a scene id such as caso-abierto-1150");

/** Who resets: only the console is limited in frequency. */
export type ResetCaller = "CONSOLE" | "QA" | "JANITOR" | "SEED";

/** A reset asked for too soon from the console: nothing changed. */
export class ResetTooSoonError extends ToolError {
  constructor(readonly nextAllowedAtReal: string) {
    super("CONFLICT", "this world was reset less than 10 minutes ago", "RESET_TOO_SOON");
  }
}

/** The world's scene jumps of this real hour are used up: nothing changed. */
export class SceneJumpCapError extends ToolError {
  constructor(
    readonly limit: number,
    readonly resetsAtReal: string,
  ) {
    super("CAP_REACHED", `at most ${limit} scene jumps per hour in a world`, "SCENE_JUMP_CAP");
  }
}

/** The part of a reset and of a scene jump that belongs to the world factory (worlds/, WP-39). */
export interface WorldRebuild {
  /**
   * Writes the world again from its template with the new epoch (`Network` and `Dispatch` rows
   * included) and, for a jump, the seeded state of the scene. Answers the template's start and, for a
   * scene, the simulated instant its clock stands at.
   */
  reload(input: { readonly clockId: string; readonly ispId: string; readonly template?: string; readonly worldEpoch: number; readonly previousEpoch: number; readonly sceneId?: string }): Promise<{ readonly startAtSim: string; readonly sceneAtSim?: string }>;
  /** First pass of the Memory purge of the previous epoch's installers, and the asynchronous rest. */
  purgeMemory(input: { readonly clockId: string; readonly ispId: string; readonly previousEpoch: number; readonly installerIds: readonly string[] }): Promise<void>;
}

export interface ResetDeps extends ClockDeps {
  readonly data: ClockDeps["data"] & Pick<Connector, "people" | "isps">;
  readonly client: TableClient;
  readonly rebuild: WorldRebuild;
}

export interface WorldReset {
  readonly clockId: string;
  readonly previousEpoch: number;
  readonly worldEpoch: number;
  readonly startAtSim: string;
  /** Where the clock stands: the start, or the scene's instant after a jump. */
  readonly simNow: string;
  readonly deleted: DeletedCounts;
}

/** What the clock row keeps for resets in `settings` (other keys, such as the owner, pass through). */
const ResetSettings = z.object({ lastResetAtReal: IsoInstant.optional(), startAtSim: IsoInstant.optional() });

function resetSettingsOf(clock: StoredClock): z.infer<typeof ResetSettings> {
  const parsed = ResetSettings.safeParse(clock.settings ?? {});
  return parsed.success ? parsed.data : {};
}

/** When the console may reset the world again; `undefined` when it may now. */
export function nextConsoleResetAtReal(clock: StoredClock, realNow: Date): string | undefined {
  const last = resetSettingsOf(clock).lastResetAtReal;
  if (last === undefined) return undefined;
  const next = Date.parse(last) + CONSOLE_RESET_INTERVAL_MS;
  return next > realNow.getTime() ? new Date(next).toISOString() : undefined;
}

/** `ADD 1` on `COUNTER#EPOCH#<clockId>` until it passes the world's epoch: an epoch is never given back. */
async function nextWorldEpoch(clockId: string, previousEpoch: number, deps: ResetDeps): Promise<number> {
  let epoch = await deps.data.runtime.nextEpoch(clockId);
  for (let tries = 0; epoch <= previousEpoch && tries < MAX_EPOCH_CATCH_UP; tries += 1) epoch = await deps.data.runtime.nextEpoch(clockId);
  if (epoch <= previousEpoch) throw new ToolError("CONFLICT", `the epoch counter of ${clockId} is behind its world`, "EPOCH_BEHIND");
  return epoch;
}

interface Rebuild {
  readonly clock: StoredClock;
  readonly reason: Tombstone["reason"];
  readonly action: "WORLD_RESET" | "WORLD_SCENE_JUMP";
  readonly actor: Actor;
  readonly sceneId?: string;
  readonly detail: JsonObject;
}

/** Steps 2 to 6, from a clock already claimed for this reset. */
async function rebuildWorld(input: Rebuild, deps: ResetDeps): Promise<WorldReset> {
  const { clock } = input;
  const realNow = await deps.realClock.now();
  const previousEpoch = clock.worldEpoch;
  const worldEpoch = await nextWorldEpoch(clock.clockId, previousEpoch, deps);
  await deps.data.worlds.putTombstone({ clockId: clock.clockId, worldEpoch: previousEpoch, reason: input.reason, atReal: realNow.toISOString() });

  const installerIds = (await deps.data.people.listPeople(clock.ispId, "INSTALLER")).map((person) => person.personId);
  for (const timer of await scheduledTimers(clock, deps)) if (timer.scheduleName !== undefined) await deps.scheduler.delete(timer.scheduleName);
  const simNow = simNowOf(clock, realNow.getTime()).toISOString();
  const settings = resetSettingsOf(clock);
  // A world written before its start was recorded is searched back from where its clock stands.
  const startSim = settings.startAtSim ?? new Date(Date.parse(simNow) - UNKNOWN_START_LOOKBACK_MS).toISOString();
  const deleted = await purgeWorldItems({ clockId: clock.clockId, ispId: clock.ispId, startSim, toSim: simNow }, { client: deps.client, data: deps.data });

  await deps.data.runtime.updateClock(clock.clockId, { worldEpoch, mode: "PAUSED", pausedSimNow: settings.startAtSim ?? simNow, offsetMs: 0 }, clock.version);
  const reloaded = await deps.rebuild.reload({
    clockId: clock.clockId,
    ispId: clock.ispId,
    ...(clock.template === undefined ? {} : { template: clock.template }),
    worldEpoch,
    previousEpoch,
    ...(input.sceneId === undefined ? {} : { sceneId: input.sceneId }),
  });
  const standsAt = reloaded.sceneAtSim ?? reloaded.startAtSim;
  const paused = await readWorldClock(deps.data, clock.clockId);
  await deps.data.runtime.updateClock(clock.clockId, { pausedSimNow: standsAt, settings: { ...(paused.settings ?? {}), startAtSim: reloaded.startAtSim } }, paused.version);
  await deps.rebuild.purgeMemory({ clockId: clock.clockId, ispId: clock.ispId, previousEpoch, installerIds });

  await auditClock(deps, { clock, action: input.action, actor: input.actor, atSim: standsAt, detail: { ...input.detail, previousEpoch, worldEpoch, deleted: { ...deleted } } });
  return { clockId: clock.clockId, previousEpoch, worldEpoch, startAtSim: reloaded.startAtSim, simNow: standsAt, deleted };
}

/** "Reiniciar demo" of one world. */
export async function resetWorld(input: { readonly clockId: string; readonly caller: ResetCaller; readonly actor: Actor }, deps: ResetDeps): Promise<WorldReset> {
  const realNow = await deps.realClock.now();
  let clock = await readWorldClock(deps.data, input.clockId);
  if (input.caller === "CONSOLE") {
    const nextAllowedAtReal = nextConsoleResetAtReal(clock, realNow);
    if (nextAllowedAtReal !== undefined) throw new ResetTooSoonError(nextAllowedAtReal);
    try {
      clock = await deps.data.runtime.updateClock(input.clockId, { settings: { ...(clock.settings ?? {}), lastResetAtReal: realNow.toISOString() } }, clock.version);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "CONFLICT") throw new ResetTooSoonError(new Date(realNow.getTime() + CONSOLE_RESET_INTERVAL_MS).toISOString());
      throw error;
    }
  }
  return rebuildWorld({ clock, reason: input.caller === "JANITOR" ? "JANITOR" : "RESET", action: "WORLD_RESET", actor: input.actor, detail: { caller: input.caller } }, deps);
}

/** The scene jumps a world may make per real hour. */
export async function sceneJumpLimit(ispId: string, deps: Pick<ResetDeps, "data">): Promise<number> {
  return (await deps.data.isps.getSettings(ispId))?.simulatorCaps.sceneJumpsPerRealHour ?? DEFAULT_SCENE_JUMPS_PER_REAL_HOUR;
}

/** "Saltar a escena": the world reset and loaded in the seeded state of one scene of the tour. */
export async function jumpToScene(input: { readonly clockId: string; readonly sceneId: string; readonly actor: Actor }, deps: ResetDeps): Promise<WorldReset> {
  const sceneId = SceneId.parse(input.sceneId);
  const kind = ispKindOfClock(input.clockId);
  if (kind !== "GUEST" && kind !== "QA") throw new ToolError("FORBIDDEN", "scene jumps exist only in guest and QA worlds", "SCENE_JUMP_NOT_ALLOWED");
  const clock = await readWorldClock(deps.data, input.clockId);
  const realNow = await deps.realClock.now();
  const limit = await sceneJumpLimit(clock.ispId, deps);
  const counter = { counterKey: COUNTER_KEYS.jump(clock.clockId, hourKey(realNow)), kind: "JUMP" as const, by: 1, max: limit };
  const reserved = await deps.data.runtime.reserve([counter]);
  if (!reserved.ok) {
    const nextHour = new Date(realNow.getTime());
    nextHour.setUTCMinutes(60, 0, 0);
    throw new SceneJumpCapError(limit, nextHour.toISOString());
  }
  try {
    return await rebuildWorld({ clock, reason: "JUMP", action: "WORLD_SCENE_JUMP", actor: input.actor, sceneId, detail: { sceneId, jumpsThisHour: reserved.values[0] ?? 1, limit } }, deps);
  } catch (error) {
    await deps.data.runtime.release([counter]);
    throw error;
  }
}
