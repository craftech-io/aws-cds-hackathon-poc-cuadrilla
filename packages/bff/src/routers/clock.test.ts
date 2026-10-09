import { readFileSync } from "node:fs";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { DEMO, type WorldSpec } from "../services/people/testing";
import { consoleTestWorld } from "./console-testing";
import { TOURS } from "./tour";

/** The rehearsal guest's world: the only guest world the QaDriver's GUEST principal acts on. */
const GUEST_TEST: WorldSpec = { ispId: "isp-guest-test", tag: "-gtest", installerBlock: "0299", supervisorBlock: "0299" };

async function failure(call: Promise<unknown>): Promise<{ code: string; reason: string | undefined }> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TRPCError);
  const cause = (error as TRPCError).cause;
  return { code: (error as TRPCError).code, reason: cause instanceof ToolError ? cause.reason : undefined };
}

describe("clock router [FL-084]", () => {
  it("[FL-084] reads the world's clock with its offset and its next timers, and moves it +10 min and to the next event", async () => {
    const t = await consoleTestWorld(DEMO);
    const order = { kind: "WORK_ORDER" as const, id: t.world.ids.order };
    await t.memory.connector.timers.createTimer({ timerId: "day-start-14", kind: "DEFERRED_SEND", home: order, clockId: t.world.clockId, dueAtSim: "2026-10-13T09:45:00-06:00", status: "SCHEDULED", reason: "CP-QUIET-HOURS" });
    const console = await t.as("OPS", "usr-ops");
    expect(await console.clock.get()).toMatchObject({ mode: "PAUSED", simNow: "2026-10-13T09:20:00-06:00", busy: false, pending: [], next: [{ kind: "DEFERRED_SEND", dueAtSim: "2026-10-13T09:45:00-06:00" }] });
    expect(await console.clock.advance({ minutes: 10 })).toMatchObject({ simNow: "2026-10-13T09:30:00-06:00", fired: [] });
    const moved = await console.clock.advanceToNext();
    expect(moved).toMatchObject({ simNow: "2026-10-13T09:45:00-06:00", fired: [{ kind: "DEFERRED_SEND" }] });
    expect(t.ports.dispatcher.sent.map((due) => due.timer.kind)).toEqual(["DEFERRED_SEND"]);
    expect((await t.world.decisions()).filter((row) => row.action === "CLOCK_ADVANCED")).toHaveLength(2);
  });

  it("[FL-085] a busy world changes nothing: the move and the demo controls answer WORLD_BUSY until the wait is old enough to force", async () => {
    const t = await consoleTestWorld(DEMO);
    await t.memory.connector.worlds.markInFlight(t.world.ids.rogelio, t.world.clockId, "wa-in-0099");
    const console = await t.as();
    expect((await console.clock.get()).pending).toEqual([expect.objectContaining({ kind: "TURN", detail: "wa-in-0099" })]);
    expect(await failure(console.clock.advance({ minutes: 10 }))).toEqual({ code: "CONFLICT", reason: "WORLD_BUSY" });
    expect(await failure(console.clock.advance({ minutes: 10, force: true }))).toEqual({ code: "CONFLICT", reason: "WORLD_BUSY" });
    expect(await failure(console.clock.setTemplateStatus({ name: "caso_escalado", status: "PENDING" }))).toEqual({ code: "CONFLICT", reason: "WORLD_BUSY" });
    expect((await console.clock.get()).simNow).toBe("2026-10-13T09:20:00-06:00");
    await t.memory.connector.worlds.clearInFlight(t.world.ids.rogelio, t.world.clockId, "wa-in-0099");
    expect(await console.clock.setTemplateStatus({ name: "caso_escalado", status: "PENDING" })).toMatchObject({ changed: true });
  });

  it("[FL-084] the ONU and the dispatch controls act on an order of the world through the simulated systems", async () => {
    const t = await consoleTestWorld(DEMO);
    const console = await t.as();
    await console.clock.setOnuBehaviour({ workOrderId: t.world.ids.order, fixed: true });
    expect(t.ports.network.calls).toEqual([{ op: "behaviour", serial: "DEMO3F2C19A0" }]);
    expect((await t.world.decisions()).map((row) => row.action)).toContain("DEMO_CONTROL");
  });
});

describe("reset and scene jumps [FL-086]", () => {
  it("[FL-086] the reset limit (1 every 10 minutes per world) holds for the QaDriver's GUEST principal too", async () => {
    const t = await consoleTestWorld(GUEST_TEST);
    const guest = t.qa("GUEST");
    expect(await guest.clock.reset()).toMatchObject({ previousEpoch: 1, simNow: "2026-10-13T07:00:00-06:00" });
    expect(await failure(guest.clock.reset())).toEqual({ code: "CONFLICT", reason: "RESET_TOO_SOON" });
    expect(t.ports.rebuild.reloads).toHaveLength(1);
  });

  it("[FL-084] four scene jumps right after a reset pass (outside the reset limit); the 31st of the real hour → CAP_REACHED", async () => {
    const t = await consoleTestWorld(GUEST_TEST);
    const guest = t.qa("GUEST");
    await guest.clock.reset();
    for (const sceneId of ["en-sitio-0920", "evidencia", "checklist-completo", "tercera-visita-1510"]) await guest.clock.jumpToScene({ sceneId });
    expect(t.ports.rebuild.reloads.map((reload) => reload.sceneId ?? "reset")).toEqual(["reset", "en-sitio-0920", "evidencia", "checklist-completo", "tercera-visita-1510"]);
    for (let jump = 5; jump <= 30; jump += 1) await guest.clock.jumpToScene({ sceneId: "evidencia" });
    expect(await failure(guest.clock.jumpToScene({ sceneId: "evidencia" }))).toEqual({ code: "TOO_MANY_REQUESTS", reason: "SCENE_JUMP_CAP" });
  });

  it("[FL-084] a demo world's staff cannot jump (guest worlds only); OPS can neither reset nor jump", async () => {
    const t = await consoleTestWorld(DEMO);
    expect(await failure((await t.as()).clock.jumpToScene({ sceneId: "evidencia" }))).toEqual({ code: "FORBIDDEN", reason: "SCENE_JUMP_NOT_ALLOWED" });
    expect((await failure((await t.as("OPS", "usr-ops")).clock.reset())).code).toBe("FORBIDDEN");
  });
});

describe("guided tour", () => {
  const guest = JSON.parse(readFileSync(new URL("../../../../scripts/seed/data/worlds/guest.json", import.meta.url), "utf8")) as { scenes: Array<{ sceneId: string; steps: { express: string[]; full: string[] } }> };

  it("every step that jumps names the scene of the guest template that prepares it", () => {
    for (const [track, key] of [["EXPRESS", "express"], ["FULL", "full"]] as const) {
      for (const step of TOURS[track]) {
        if (step.sceneId === null) continue;
        expect(guest.scenes.find((scene) => scene.sceneId === step.sceneId)?.steps[key]).toContain(step.stepId);
      }
    }
  });

  it("steps carry the estimate and the world's pending timers; run presses a step's button through the clock", async () => {
    const t = await consoleTestWorld(GUEST_TEST);
    const guestCaller = t.qa("GUEST");
    const express = await guestCaller.tour.steps({ track: "EXPRESS" });
    expect(express.steps.map((step) => step.stepId)).toEqual(["X1", "X2", "X3", "X4"]);
    expect(express.estimatedSec).toBe(165);
    await t.memory.connector.runtime.updateClock(t.world.clockId, { pausedSimNow: "2026-10-13T07:00:00-06:00" }, (await t.memory.connector.runtime.getClock(t.world.clockId))?.version ?? 0);
    const ran = await guestCaller.tour.run({ track: "FULL", stepId: "2" });
    expect(ran.results).toEqual([expect.objectContaining({ kind: "CLOCK", result: expect.objectContaining({ simNow: "2026-10-13T07:30:00-06:00" }) })]);
    expect((await failure(guestCaller.tour.run({ track: "FULL", stepId: "99" }))).code).toBe("NOT_FOUND");
  });
});
