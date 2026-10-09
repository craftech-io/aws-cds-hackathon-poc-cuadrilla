import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { COUNTER_KEYS, counterRowKey, hourKey } from "../connector/keys";
import { openCase } from "../connector/testing";
import { buildWorld } from "../worlds/factory";
import { TEMPLATE_TEXT, type WorldHarness, allRows, worldHarness } from "../worlds/testing";
import { RecordingDispatcher, RecordingScheduler } from "../timers/testing";
import { createTimerService } from "../timers/timers";
import { advanceClock } from "./advance";
import { setRunning } from "./modes";
import { CONSOLE_RESET_INTERVAL_MS, ResetTooSoonError, type ResetDeps, SceneJumpCapError, type WorldRebuild, jumpToScene, resetWorld } from "./reset";

const ISP = "isp-guest-test";
const CLOCK = "GUEST#isp-guest-test";
const OTHER_ISP = "isp-guest-07";
const ROGELIO = "inst-rogelio-gtest";
const SUPERVISOR = "USER:usr-qa-guest" as const;
const TEMPLATE = JSON.parse(TEMPLATE_TEXT) as { readonly startAtSim: string; readonly scenes: ReadonlyArray<{ readonly sceneId: string; readonly advanceToSim: string }> };
const at = (iso: string): string => new Date(iso).toISOString();

interface ResetWorld {
  readonly harness: WorldHarness;
  readonly deps: ResetDeps;
  readonly scheduler: RecordingScheduler;
  readonly reloads: Array<Parameters<WorldRebuild["reload"]>[0]>;
  readonly handOffs: Array<Parameters<WorldRebuild["handOffPurge"]>[0]>;
  /** Makes the next reload throw (a request that dies halfway). */
  failReload(): void;
}

async function resetWorldHarness(): Promise<ResetWorld> {
  const harness = worldHarness("2026-10-06T15:00:00.000Z");
  await buildWorld(harness.factoryDeps(), { ispId: ISP, origin: "TEST" });
  await buildWorld(harness.factoryDeps(), { ispId: OTHER_ISP, origin: "INVITED" });
  const scheduler = new RecordingScheduler();
  const reloads: ResetWorld["reloads"] = [];
  const handOffs: ResetWorld["handOffs"] = [];
  let failing = false;
  const rebuild: WorldRebuild = {
    async checkScene(input) {
      if (!TEMPLATE.scenes.some((candidate) => candidate.sceneId === input.sceneId)) throw new ToolError("NOT_FOUND", "no such scene", "SCENE_NOT_FOUND");
    },
    async handOffPurge(input) {
      handOffs.push(input);
    },
    async reload(input) {
      if (failing) throw new Error("the request died while reloading");
      reloads.push(input);
      await buildWorld(harness.factoryDeps(), { ispId: input.ispId, origin: "TEST" });
      const scene = TEMPLATE.scenes.find((candidate) => candidate.sceneId === input.sceneId);
      if (input.sceneId !== undefined && scene === undefined) throw new ToolError("NOT_FOUND", "no such scene");
      return { startAtSim: TEMPLATE.startAtSim, ...(scene === undefined ? {} : { sceneAtSim: scene.advanceToSim }) };
    },
  };
  const deps: ResetDeps = { data: harness.connector, scheduler, dispatcher: new RecordingDispatcher(), realClock: { now: async () => harness.now() }, client: harness.client, rebuild };
  return { harness, deps, scheduler, reloads, handOffs, failReload: () => void (failing = true) };
}

/** Rows of one guest world, per table: its partitions carry its operator or its clock tag. */
function worldCounts(harness: WorldHarness, ispId: string, tag: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { table, row } of allRows(harness)) {
    if (table === "Runtime") continue;
    const pk = String(row.PK);
    if (pk.includes(ispId) || pk.includes(`-${tag}`)) counts[table] = (counts[table] ?? 0) + 1;
  }
  return counts;
}

async function counter(world: ResetWorld, counterKey: string): Promise<unknown> {
  return world.harness.client.get("Runtime", counterRowKey(counterKey));
}

/** Activity of the world before a reset: a moved, running clock with a schedule, a case, a bound phone, counters. */
async function liveActivity(world: ResetWorld): Promise<{ readonly simHourKey: string; readonly realHourKey: string; readonly phoneHash: string }> {
  const { harness, deps } = world;
  await advanceClock({ clockId: CLOCK, target: { byMinutes: 120 }, caller: { actor: "QA" } }, deps);
  await setRunning({ clockId: CLOCK, running: true, caller: { actor: "QA" } }, deps);
  await createTimerService(deps).arm({ home: { kind: "WORK_ORDER", id: "wo-24818-gtest" }, kind: "CERT_RETRY", timerId: "cert-1", clockId: CLOCK, dueAtSim: "2026-10-13T09:10:00-06:00" });
  await harness.connector.cases.createCase(openCase({ ispId: ISP, clockId: CLOCK, workOrderId: "wo-24818-gtest", installerId: ROGELIO, roster: { primaryId: "sup-adriana-gtest", secondaryId: "sup-hector-gtest", zoneChiefId: "zc-marisol-gtest" } }));
  await harness.connector.worlds.createJoinCode({ code: "GT1-4F2K", clockId: CLOCK, personId: ROGELIO, userId: "usr-qa-guest" });
  await harness.connector.worlds.bindPhoneLease("GT1-4F2K", "c".repeat(64));
  const person = await harness.connector.people.requirePerson(ROGELIO);
  const phoneHash = person.phoneHash ?? "";
  const simHourKey = hourKey(new Date("2026-10-13T09:00:00-06:00"));
  const realHourKey = hourKey(harness.now());
  await harness.connector.runtime.reserve([
    { counterKey: COUNTER_KEYS.rateSim(CLOCK, phoneHash, simHourKey), kind: "RATE", by: 1 },
    { counterKey: COUNTER_KEYS.rateReal(CLOCK, phoneHash, realHourKey), kind: "RATE", by: 1 },
  ]);
  for (const PK of [`SIMCAP#${CLOCK}#turns#2026-10-06`, `TURNCAP#${ISP}#2026-10-06`]) await harness.client.put("Runtime", { PK, SK: "META", entity: "CapCounter", used: 3, ledger: "SIMULATOR", resource: "turns", period: "DAY", capLimit: 300 });
  await harness.client.put("Runtime", { PK: `KILL#AGENT#${CLOCK}`, SK: "META", entity: "KillSwitch", scope: "AGENT", clockId: CLOCK, state: "on", setBy: "QA", setAtReal: harness.now().toISOString() });
  return { simHourKey, realHourKey, phoneHash };
}

describe("reset_demo_world [FL-086]", () => {
  it("[FL-086] epoch + 1 and tombstone; the world goes back to its template, the clock to 07:00 PAUSED; real-time counters stay", async () => {
    const world = await resetWorldHarness();
    const template = worldCounts(world.harness, ISP, "gtest");
    const other = worldCounts(world.harness, OTHER_ISP, "g07");
    const activity = await liveActivity(world);
    const scheduled = [...world.scheduler.live.keys()];
    expect(scheduled).toHaveLength(1);

    const reset = await resetWorld({ clockId: CLOCK, caller: "CONSOLE", actor: SUPERVISOR }, world.deps);
    expect(reset).toMatchObject({ clockId: CLOCK, previousEpoch: 1, worldEpoch: 2, startAtSim: TEMPLATE.startAtSim, simNow: TEMPLATE.startAtSim });
    expect(await world.harness.connector.worlds.getTombstone(CLOCK, 1)).toMatchObject({ reason: "RESET" });
    expect(await world.harness.connector.runtime.currentEpoch(CLOCK)).toBe(2);
    expect(world.scheduler.deletes).toEqual(expect.arrayContaining(scheduled));
    expect(world.scheduler.live.size).toBe(0);

    const clock = await world.harness.connector.runtime.getClock(CLOCK);
    expect(clock).toMatchObject({ mode: "PAUSED", worldEpoch: 2, offsetMs: 0 });
    expect(at(clock?.pausedSimNow ?? "")).toBe(at(TEMPLATE.startAtSim));
    expect(clock?.settings).toMatchObject({ startAtSim: TEMPLATE.startAtSim });

    // Equal to the template: the case, the extra timer and the clock moves are gone; one WORLD_RESET row more.
    expect(worldCounts(world.harness, ISP, "gtest")).toEqual({ ...template, AuditLog: (template.AuditLog ?? 0) + 1 });
    const timers = await world.harness.connector.timers.listDueTimers(CLOCK);
    expect(timers.map((timer) => [timer.kind, timer.status, timer.version])).toEqual(timers.map(() => ["DAY_START", "SCHEDULED", 1]));
    expect(await world.harness.connector.worlds.getPhoneLease("c".repeat(64))).toBeUndefined();
    expect(world.reloads).toEqual([{ clockId: CLOCK, ispId: ISP, template: "guest", worldEpoch: 2, previousEpoch: 1 }]);
    expect(world.handOffs).toEqual([expect.objectContaining({ clockId: CLOCK, previousEpoch: 1, installerIds: expect.arrayContaining([ROGELIO]) })]);

    // What resetting never empties, and what it does.
    expect(await counter(world, COUNTER_KEYS.rateReal(CLOCK, activity.phoneHash, activity.realHourKey))).toMatchObject({ count: 1 });
    expect(await counter(world, COUNTER_KEYS.rateSim(CLOCK, activity.phoneHash, activity.simHourKey))).toBeUndefined();
    expect(await world.harness.client.get("Runtime", { PK: `SIMCAP#${CLOCK}#turns#2026-10-06`, SK: "META" })).toMatchObject({ used: 3 });
    expect(await world.harness.client.get("Runtime", { PK: `TURNCAP#${ISP}#2026-10-06`, SK: "META" })).toMatchObject({ used: 3 });
    expect(await world.harness.client.get("Runtime", { PK: `KILL#AGENT#${CLOCK}`, SK: "META" })).toMatchObject({ state: "on" });

    expect(worldCounts(world.harness, OTHER_ISP, "g07")).toEqual(other);
    const audit = await world.harness.connector.audit.listByMonth(ISP, "2026-10");
    expect(audit.find((row) => row.action === "WORLD_RESET")?.detail).toMatchObject({ caller: "CONSOLE", previousEpoch: 1, worldEpoch: 2 });
  });

  it("[FL-086] the console resets a world once every 10 minutes; QA is exempt; the epoch never goes back", async () => {
    const world = await resetWorldHarness();
    await resetWorld({ clockId: CLOCK, caller: "CONSOLE", actor: SUPERVISOR }, world.deps);
    world.harness.advance(5 * 60_000);
    const refused = await resetWorld({ clockId: CLOCK, caller: "CONSOLE", actor: SUPERVISOR }, world.deps).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ResetTooSoonError);
    expect((refused as ResetTooSoonError).reason).toBe("RESET_TOO_SOON");
    expect((refused as ResetTooSoonError).nextAllowedAtReal).toBe(new Date(Date.parse("2026-10-06T15:00:00.000Z") + CONSOLE_RESET_INTERVAL_MS).toISOString());
    expect((await resetWorld({ clockId: CLOCK, caller: "QA", actor: "QA" }, world.deps)).worldEpoch).toBe(3);
    world.harness.advance(5 * 60_000);
    expect((await resetWorld({ clockId: CLOCK, caller: "CONSOLE", actor: SUPERVISOR }, world.deps)).worldEpoch).toBe(4);
  });
});

describe("jump_to_scene [FL-084] [FL-086]", () => {
  it("[FL-084] four jumps in five minutes right after a reset pass, load each scene and keep the real-time counters", async () => {
    const world = await resetWorldHarness();
    const activity = await liveActivity(world);
    await resetWorld({ clockId: CLOCK, caller: "CONSOLE", actor: SUPERVISOR }, world.deps);
    const scenes = TEMPLATE.scenes.slice(1, 5);
    for (const scene of scenes) {
      world.harness.advance(60_000);
      const jumped = await jumpToScene({ clockId: CLOCK, sceneId: scene.sceneId, actor: SUPERVISOR }, world.deps);
      expect(jumped.simNow).toBe(scene.advanceToSim);
      expect(at((await world.harness.connector.runtime.getClock(CLOCK))?.pausedSimNow ?? "")).toBe(at(scene.advanceToSim));
    }
    expect(world.reloads.slice(-4).map((reload) => reload.sceneId)).toEqual(scenes.map((scene) => scene.sceneId));
    expect(await world.harness.connector.runtime.currentEpoch(CLOCK)).toBe(6);
    expect(await world.harness.connector.worlds.getTombstone(CLOCK, 5)).toMatchObject({ reason: "JUMP" });
    expect(await counter(world, COUNTER_KEYS.jump(CLOCK, hourKey(world.harness.now())))).toMatchObject({ count: 4 });
    expect(await counter(world, COUNTER_KEYS.rateReal(CLOCK, activity.phoneHash, activity.realHourKey))).toMatchObject({ count: 1 });
    expect(await world.harness.client.get("Runtime", { PK: `SIMCAP#${CLOCK}#turns#2026-10-06`, SK: "META" })).toMatchObject({ used: 3 });
    // A jump never counts for the reset limit: the console still may not reset within 10 minutes of its reset.
    await expect(resetWorld({ clockId: CLOCK, caller: "CONSOLE", actor: SUPERVISOR }, world.deps)).rejects.toBeInstanceOf(ResetTooSoonError);
  });

  it("[FL-084] the 31st jump of the real hour is CAP_REACHED and changes nothing; demo worlds have no jumps", async () => {
    const world = await resetWorldHarness();
    const jumpKey = COUNTER_KEYS.jump(CLOCK, hourKey(world.harness.now()));
    await world.harness.connector.runtime.reserve([{ counterKey: jumpKey, kind: "JUMP", by: 30 }]);
    const epoch = await world.harness.connector.runtime.currentEpoch(CLOCK);
    const refused = await jumpToScene({ clockId: CLOCK, sceneId: "ordenes-del-dia", actor: SUPERVISOR }, world.deps).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SceneJumpCapError);
    expect(refused).toMatchObject({ code: "CAP_REACHED", reason: "SCENE_JUMP_CAP", limit: 30, resetsAtReal: "2026-10-06T16:00:00.000Z" });
    expect(await world.harness.connector.runtime.currentEpoch(CLOCK)).toBe(epoch);
    expect(await counter(world, jumpKey)).toMatchObject({ count: 30 });
    await expect(jumpToScene({ clockId: "GLOBAL#isp-demo", sceneId: "ordenes-del-dia", actor: SUPERVISOR }, world.deps)).rejects.toMatchObject({ code: "FORBIDDEN", reason: "SCENE_JUMP_NOT_ALLOWED" });
  });

  it("[FL-084] [W4 review B5] a qa-* world has no scenes, and a scene the factory cannot load changes nothing", async () => {
    const world = await resetWorldHarness();
    await expect(jumpToScene({ clockId: "qa-31-sc-18", sceneId: "ordenes-del-dia", actor: "QA" }, world.deps)).rejects.toMatchObject({ code: "FORBIDDEN", reason: "SCENE_JUMP_NOT_ALLOWED" });
    const epoch = await world.harness.connector.runtime.currentEpoch(CLOCK);
    const before = worldCounts(world.harness, ISP, "gtest");
    await expect(jumpToScene({ clockId: CLOCK, sceneId: "no-such-scene", actor: SUPERVISOR }, world.deps)).rejects.toMatchObject({ reason: "SCENE_NOT_FOUND" });
    expect(await world.harness.connector.runtime.currentEpoch(CLOCK)).toBe(epoch);
    expect(await world.harness.connector.worlds.getTombstone(CLOCK, epoch)).toBeUndefined();
    expect(worldCounts(world.harness, ISP, "gtest")).toEqual(before);
    expect(await counter(world, COUNTER_KEYS.jump(CLOCK, hourKey(world.harness.now())))).toBeUndefined();
    expect(world.handOffs).toEqual([]);
  });
});

describe("Memory of the previous epoch [W4 review security B2]", () => {
  it("is handed off before the world's items go, so a reload that dies still leaves its purge handed off", async () => {
    const world = await resetWorldHarness();
    world.failReload();
    await expect(resetWorld({ clockId: CLOCK, caller: "QA", actor: "QA" }, world.deps)).rejects.toThrow(/died/);
    expect(world.handOffs).toEqual([expect.objectContaining({ clockId: CLOCK, previousEpoch: 1, installerIds: expect.arrayContaining([ROGELIO]) })]);
  });
});
