// The world factory's half of "Reiniciar demo" and "Saltar a escena" (`WorldRebuild` of clock/reset.ts,
// docs/architecture.md §8): the clock's half has already raised the epoch, written the tombstone, deleted
// the world's schedules and items (keeping the real-time counters of a guest world and deleting its
// phone leases) and paused the clock at the start. Here:
//
//   reload        writes the world again from its template at the new epoch, by kind: a guest world
//                 through the minimal factory of wave 2b, the demo world from `demo.json` (with the
//                 operator's overrides and the live world), a QA or evaluation world from the request
//                 its clock keeps (same numbers, phones and presets); renders the historical
//                 certificates when it can; for a jump, seeds the scene (worlds/scenes.ts)
//   purgeMemory   pass 1 of the Memory purge of the previous epoch's installers here, the rest through
//                 `continuePurge` (`WorldJanitor` asynchronously, or in process)
import { type GuestOrigin, ToolError, guestOriginOfIsp, parseClockId } from "@cuadrilla/shared";
import { type ResetCaller, type ResetDeps, type WorldRebuild, type WorldReset, jumpToScene as clockJump, resetWorld as clockReset } from "../clock/reset";
import type { Actor } from "../domain/common";
import { localDateOf } from "../services/business-hours/zoned-time";
import { type WorldsDeps, factoryDepsOf, resetDepsOf } from "./deps";
import { writeDemoWorld } from "./demo";
import { buildWorld } from "./factory";
import { purgeFirstPass } from "./memory-purge";
import { purgeTargetOf, scopeOfWorld } from "./memory-targets";
import { writeQaWorld } from "./qa-world";
import { applyScene } from "./scenes";
import { GUEST_WORLD_START_SIM } from "./template";

const TIME_ZONE = "America/Mexico_City";

function ownerOf(settings: Readonly<Record<string, unknown>> | undefined): string | undefined {
  return typeof settings?.ownerUserId === "string" ? settings.ownerUserId : undefined;
}

async function reloadGuest(deps: WorldsDeps, input: Parameters<WorldRebuild["reload"]>[0]): Promise<string> {
  const origin: GuestOrigin | undefined = guestOriginOfIsp(input.ispId);
  if (origin === undefined) throw new ToolError("INVALID", `${input.ispId} is not a guest operator`);
  const clock = await deps.connector.runtime.getClock(input.clockId);
  await buildWorld({ ...factoryDepsOf(deps), ...(deps.certificates === undefined ? {} : { certificates: deps.certificates }) }, { ispId: input.ispId, origin, ownerUserId: ownerOf(clock?.settings) });
  return GUEST_WORLD_START_SIM;
}

export function worldRebuild(deps: WorldsDeps): WorldRebuild {
  return {
    async reload(input) {
      const kind = parseClockId(input.clockId)?.kind;
      let startAtSim: string;
      if (kind === "GUEST") startAtSim = await reloadGuest(deps, input);
      else if (kind === "DEMO") startAtSim = (await writeDemoWorld(deps, input.worldEpoch)).startAtSim;
      else if (kind === "QA" || kind === "EVAL") startAtSim = (await writeQaWorld(deps, input.clockId, input.worldEpoch)).startAtSim;
      else throw new ToolError("INVALID", `no world to reload for ${input.clockId}`);
      if (input.sceneId === undefined) return { startAtSim };
      if (kind !== "GUEST") throw new ToolError("NOT_FOUND", "scenes exist only in a world of the guest template", "SCENE_NOT_FOUND");
      const scene = await applyScene(deps, { clockId: input.clockId, ispId: input.ispId, sceneId: input.sceneId });
      return { startAtSim, sceneAtSim: scene.sceneAtSim };
    },

    async purgeMemory(input) {
      if (deps.memory === undefined) return;
      const clock = await deps.connector.runtime.getClock(input.clockId);
      const start = typeof clock?.settings?.startAtSim === "string" ? clock.settings.startAtSim : (clock?.pausedSimNow ?? deps.now().toISOString());
      const scope = await scopeOfWorld(deps.connector, { clockId: input.clockId, ispId: input.ispId, epoch: input.previousEpoch, startDate: localDateOf(new Date(start), TIME_ZONE), installerIds: input.installerIds });
      const { target } = await purgeFirstPass({ memory: deps.memory, now: deps.now }, purgeTargetOf(scope, deps.runtimeSessionKey));
      await deps.continuePurge(target);
    },
  };
}

/** `resetWorld`'s dependencies over the factory's ports. */
export function worldResetDeps(deps: WorldsDeps): ResetDeps {
  return resetDepsOf(deps, worldRebuild(deps));
}

/** "Reiniciar demo" of one world, the same for the console, the `QaDriver`, `WorldJanitor` and `seed:load`. */
export function resetWorld(deps: WorldsDeps, input: { readonly clockId: string; readonly caller: ResetCaller; readonly actor: Actor }): Promise<WorldReset> {
  return clockReset(input, worldResetDeps(deps));
}

/** "Saltar a escena" of a guest world (or a `qa-*` world built from the guest template). */
export function jumpToScene(deps: WorldsDeps, input: { readonly clockId: string; readonly sceneId: string; readonly actor: Actor }): Promise<WorldReset> {
  return clockJump(input, worldResetDeps(deps));
}
