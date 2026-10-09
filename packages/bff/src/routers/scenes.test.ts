// "Saltar a escena" over the console's ports with the real world factory (worlds/rebuild.ts) shaped as the
// stage builds it (routers/console-ports.ts `stageRebuild`): no case handlers in process, the `case`
// preset handed to the installer queue, every seeded evidence with its object (FL-084, W4 review B1/B2).
import { describe, expect, it } from "vitest";
import { GUEST_TEST_ISP_ID } from "@cuadrilla/shared";
import { REAL_NOW, type WorldSpec, hashPhone } from "../services/people/testing";
import type { InstallerQueueEventInput } from "../worker/events";
import { worldRebuild } from "../worlds/rebuild";
import { scenesOf } from "../worlds/scenes";
import { memoryWorlds } from "../worlds/testing";
import { consoleTestWorld } from "./console-testing";

const GUEST_TEST: WorldSpec = { ispId: GUEST_TEST_ISP_ID, tag: "-gtest", installerBlock: "0299", supervisorBlock: "0299" };

async function stageShapedConsole(options: { readonly queue?: boolean } = {}) {
  const t = await consoleTestWorld(GUEST_TEST);
  const queued: InstallerQueueEventInput[] = [];
  const queue = options.queue === false ? {} : { queue: { enqueue: async (event: InstallerQueueEventInput) => void queued.push(event) } };
  const worlds = memoryWorlds({ ...t.memory, now: () => new Date(REAL_NOW) }, { ...queue, certificates: false, phoneHash: hashPhone });
  Object.assign(t.ports, { rebuild: worldRebuild(worlds.deps) });
  return { t, worlds, queued };
}

describe("Saltar a escena with the stage's world factory [W4 review B1] [FL-084]", () => {
  it("[FL-084] loads every scene of the guest template; the case scenes hand their case to the installer queue", async () => {
    const { t, worlds, queued } = await stageShapedConsole();
    const guest = t.qa("GUEST");
    const scenes = await scenesOf(worlds.deps, GUEST_TEST_ISP_ID);
    expect(scenes.map((scene) => scene.sceneId)).toEqual(expect.arrayContaining(["caso-con-supervisora", "caso-con-respaldo", "checklist-completo"]));
    for (const scene of scenes) {
      const before = queued.length;
      const jumped = await guest.clock.jumpToScene({ sceneId: scene.sceneId });
      expect(Date.parse(jumped.simNow)).toBe(Date.parse(scene.advanceToSim));
      const cases = Object.entries(scene.orders).filter(([, preset]) => preset.case !== undefined);
      const presets = queued.slice(before).filter((event) => event.type === "CASE_PRESET");
      expect(presets.map((event) => (event.type === "CASE_PRESET" ? [event.workOrderId, event.rung, event.worldEpoch] : []))).toEqual(cases.map(([workOrderId, preset]) => [workOrderId, preset.case?.rung, jumped.worldEpoch]));
    }
  });

  it("[FL-084] a factory that cannot seed a scene's case refuses the jump before the world is touched", async () => {
    const { t } = await stageShapedConsole({ queue: false });
    const guest = t.qa("GUEST");
    const clock = await t.memory.connector.runtime.getClock(t.world.clockId);
    const orders = t.memory.client.dump("WorkOrders").length;
    await expect(guest.clock.jumpToScene({ sceneId: "caso-con-supervisora" })).rejects.toMatchObject({ cause: { reason: "PRESET_UNAVAILABLE" } });
    expect(await t.memory.connector.runtime.getClock(t.world.clockId)).toEqual(clock);
    expect(t.memory.client.dump("WorkOrders")).toHaveLength(orders);
  });

  it("[W4 review B2] every evidence a scene seeds has its object at its key, copied from the seed's photo", async () => {
    const { t, worlds } = await stageShapedConsole();
    await t.qa("GUEST").clock.jumpToScene({ sceneId: "checklist-completo" });
    const evidence = t.memory.client.dump("WorkOrders").filter((row) => row.entity === "Evidence" && row.seeded === true);
    expect(evidence.length).toBeGreaterThan(0);
    for (const row of evidence) expect(worlds.evidencePhotos.get(String(row.s3Key))).toBe(row.photoId);
  });
});
