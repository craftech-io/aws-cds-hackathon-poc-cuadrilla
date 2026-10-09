// The single live world (ADR-0002, docs/seed-spec.md §3, invariant 20): templates run simulated; only the
// operator's demo world named by `SeedOverrides.liveWorldClockId` runs live, marked by `Runtime/LIVEWORLD`.
import { describe, expect, it } from "vitest";
import { DEMO_CLOCK_ID, DEMO_ISP_ID, GUEST_TEST_CLOCK_ID, GUEST_TEST_ISP_ID, ToolError } from "@cuadrilla/shared";
import { factoryDepsOf } from "./deps";
import { buildWorld } from "./factory";
import { assertLiveWorldAllowed, syncLiveWorld, whatsappModeOf } from "./live-world";
import { resetWorld } from "./rebuild";
import { TEMPLATE_TEXTS, worldsHarness } from "./testing";
import { createWorld } from "./worlds";

describe("live world", () => {
  it("every committed template runs simulated", () => {
    for (const [name, text] of Object.entries(TEMPLATE_TEXTS)) expect((JSON.parse(text) as { whatsappMode: string }).whatsappMode, name).toBe("simulated");
  });

  it("is live only for the configured world, and only when it is an operator's demo world", () => {
    expect(whatsappModeOf(DEMO_CLOCK_ID, DEMO_CLOCK_ID)).toBe("live");
    expect(whatsappModeOf(DEMO_CLOCK_ID, undefined)).toBe("simulated");
    expect(whatsappModeOf(GUEST_TEST_CLOCK_ID, GUEST_TEST_CLOCK_ID)).toBe("simulated");
    expect(whatsappModeOf("qa-1-sc-17", "qa-1-sc-17")).toBe("simulated");
    expect(() => assertLiveWorldAllowed(GUEST_TEST_CLOCK_ID)).toThrow(ToolError);
    expect(() => assertLiveWorldAllowed("qa-1-sc-17")).toThrow(ToolError);
    expect(() => assertLiveWorldAllowed(DEMO_CLOCK_ID)).not.toThrow();
  });

  it("the demo world named by the overrides is built live and keeps it across a reset; others stay simulated", async () => {
    const harness = worldsHarness({ overrides: { liveWorldClockId: DEMO_CLOCK_ID } });
    await createWorld(harness.deps, { clockId: DEMO_CLOCK_ID });
    await buildWorld(factoryDepsOf(harness.deps), { ispId: GUEST_TEST_ISP_ID, origin: "TEST" });
    await createWorld(harness.deps, { clockId: "qa-1-sc-17", operations: [{ key: "a", model: "wo-24817", installer: "own" }] });
    expect(await syncLiveWorld(harness.connector, DEMO_CLOCK_ID, "OPERATOR")).toEqual({ live: DEMO_CLOCK_ID });
    expect((await harness.connector.worlds.getLiveWorld())?.clockId).toBe(DEMO_CLOCK_ID);
    expect((await harness.connector.isps.getSettings(DEMO_ISP_ID))?.whatsappMode).toBe("live");
    expect((await harness.connector.isps.getSettings(GUEST_TEST_ISP_ID))?.whatsappMode).toBe("simulated");
    expect((await harness.connector.isps.getSettings("isp-qa-1-sc-17"))?.whatsappMode).toBe("simulated");
    await resetWorld(harness.deps, { clockId: DEMO_CLOCK_ID, caller: "SEED", actor: "OPERATOR" });
    expect((await harness.connector.isps.getSettings(DEMO_ISP_ID))?.whatsappMode).toBe("live");
  });

  it("is a singleton: the mark moves only through the overrides, and clearing them takes the world back to simulated", async () => {
    const harness = worldsHarness({ overrides: { liveWorldClockId: DEMO_CLOCK_ID } });
    await createWorld(harness.deps, { clockId: DEMO_CLOCK_ID });
    await syncLiveWorld(harness.connector, DEMO_CLOCK_ID, "OPERATOR");
    await expect(harness.connector.worlds.setLiveWorld("GLOBAL#isp-other", "OPERATOR")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await syncLiveWorld(harness.connector, "GLOBAL#isp-other", "OPERATOR")).toEqual({ live: "GLOBAL#isp-other", cleared: DEMO_CLOCK_ID });
    expect((await harness.connector.isps.getSettings(DEMO_ISP_ID))?.whatsappMode).toBe("simulated");
    expect(await syncLiveWorld(harness.connector, undefined, "OPERATOR")).toEqual({ cleared: "GLOBAL#isp-other" });
    expect(await harness.connector.worlds.getLiveWorld()).toBeUndefined();
    await expect(syncLiveWorld(harness.connector, GUEST_TEST_CLOCK_ID, "OPERATOR")).rejects.toThrow(/only the operator's demo world/);
  });
});
