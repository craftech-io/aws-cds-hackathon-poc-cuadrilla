// The world factory of the local UI server (docs/test-plan.md §2, level UI): the real `worldRebuild` behind
// "Reiniciar demo" and "Saltar a escena", over the server's memory, the committed templates and photo
// catalog (packages/bff/src/worlds/testing.ts), the server's phone hashes and its in-memory buckets. A
// scene's `case` preset runs in process through the real case handlers with the outbound fake that applies
// the contact policy (packages/bff/src/cases/testing.ts): no worker runs here. Seeded evidence and the
// candidates' photos are copied from the repository's seed photos into the emulated `Evidence` and `Media`,
// so the console's links open them. Memory, schedules and due timers are recorded, never sent.
import type { WorldRebuild } from "../../packages/bff/src/clock/reset";
import type { CaseDeps } from "../../packages/bff/src/cases/ports";
import { type World, fakeNetwork, memoryTimers, policyOutbound } from "../../packages/bff/src/cases/testing";
import type { MemoryConnector } from "../../packages/bff/src/connector/index";
import { createLogger } from "../../packages/bff/src/lib/log";
import type { MemoryObjects } from "../../packages/bff/src/routers/console-testing";
import { seedPhotoKey } from "../../packages/bff/src/worlds/photo-catalog";
import { casePresetEffects } from "../../packages/bff/src/worlds/preset-effects";
import type { SeedMediaCopier } from "../../packages/bff/src/worlds/presets";
import { worldRebuild } from "../../packages/bff/src/worlds/rebuild";
import { type MemoryWorlds, memoryWorlds } from "../../packages/bff/src/worlds/testing";
import { uiPhoneHash } from "./world";

export interface UiWorlds {
  readonly rebuild: WorldRebuild;
  readonly worlds: MemoryWorlds;
}

/** `Seed/photos/<photoId>.jpg` (the repository's file through the emulator's fallback) into a bucket. */
function seedCopier(objects: MemoryObjects): SeedMediaCopier {
  const copy = async (photoId: string, bucket: "Media" | "Evidence", key: string): Promise<void> => {
    const source = await objects.get("Seed", seedPhotoKey(photoId));
    if (source === undefined) throw new Error(`no seed photo ${photoId}`);
    objects.put(bucket, key, source.bytes, "image/jpeg");
  };
  return { copySeedPhoto: (photoId, key) => copy(photoId, "Media", key), copySeedPhotoToEvidence: (photoId, key) => copy(photoId, "Evidence", key) };
}

export function createUiWorlds(memory: MemoryConnector, objects: MemoryObjects, now: () => Date = () => new Date()): UiWorlds {
  const world = { ...memory, now, advance: () => undefined } as World;
  const cases: CaseDeps = {
    connector: memory.connector,
    outbound: policyOutbound(world),
    timers: memoryTimers(world),
    turns: { enqueueCaseClosed: async () => undefined },
    network: fakeNetwork(),
    realClock: { now: async () => now() },
    logger: createLogger({ level: "warn", bindings: { service: "ui-server" } }),
  };
  const worlds = memoryWorlds({ ...memory, now }, { effects: casePresetEffects(cases), certificates: false, phoneHash: uiPhoneHash });
  return { rebuild: worldRebuild({ ...worlds.deps, media: seedCopier(objects) }), worlds };
}
