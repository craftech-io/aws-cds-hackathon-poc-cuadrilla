import { describe, expect, it } from "vitest";
import { defaultWorldPolicy } from "../connector/world";
import { assertOwnRow, cloneWorld, rowCounts } from "./clone";
import { buildWorld } from "./factory";
import { TemplateError, fillTemplate, markersFor } from "./template";
import { SIGNUP_ISP, SIGNUP_USER, TEMPLATE_TEXT, allRows, phoneHashOf, worldHarness } from "./testing";

const NOW = new Date("2026-10-01T15:00:00.000Z");

function clone(ispId: string, text: string = TEMPLATE_TEXT) {
  const markers = markersFor(ispId);
  return cloneWorld({
    template: fillTemplate(text, markers),
    markers,
    origin: markers.capsProfile as "INVITED" | "TEST" | "SIGNUP",
    worldEpoch: 1,
    displayName: "Operadora de prueba",
    ownerUserId: markers.capsProfile === "SIGNUP" ? SIGNUP_USER : undefined,
    phoneHash: phoneHashOf,
    policy: defaultWorldPolicy,
    now: NOW,
  });
}

const keysOf = (rows: ReturnType<typeof clone>) => [...rows.domain, ...rows.mocks].flatMap(([table, items]) => items.map((item) => `${table}|${item.PK}|${item.SK}`));

describe("[FL-107] cloning the template into one world", () => {
  it("[FL-107] two generations, and a generation and an invited world, share no item", () => {
    const first = new Set(keysOf(clone(SIGNUP_ISP)));
    for (const other of ["isp-guest-s261001abcdf", "isp-guest-s261002abcde", "isp-guest-07", "isp-guest-test"]) {
      const shared = keysOf(clone(other)).filter((key) => first.has(key));
      expect(shared, other).toEqual([]);
    }
  });

  it("[FL-107] the rehearsal world alone gets the QaDriver's guest; every origin gets its own caps profile", () => {
    const users = (ispId: string) => (clone(ispId).domain.get("Isps") ?? []).filter((row) => row.entity === "ConsoleUser").map((row) => row.userId);
    expect(users("isp-guest-test")).toContain("usr-qa-guest");
    expect(users("isp-guest-07")).not.toContain("usr-qa-guest");
    expect(users(SIGNUP_ISP)).not.toContain("usr-qa-guest");
    const settingsOf = (ispId: string) => (clone(ispId).domain.get("Isps") ?? []).find((row) => row.entity === "IspSettings");
    expect(settingsOf("isp-guest-test")).toMatchObject({ capsProfile: "TEST" });
    expect(settingsOf(SIGNUP_ISP)).toMatchObject({ capsProfile: "SIGNUP", ownerUserId: SIGNUP_USER });
    expect(settingsOf("isp-guest-07")).not.toHaveProperty("ownerUserId");
  });

  it("counts every table of the template once", () => {
    const counts = rowCounts(clone(SIGNUP_ISP));
    expect(counts.WorkOrders).toBeGreaterThan(100);
    expect(counts.Network).toBe(counts.Dispatch);
    expect(counts.Cases).toBeUndefined();
  });

  it("[FL-107] a row that names another operator or lives outside the world's keys is refused", () => {
    const markers = markersFor(SIGNUP_ISP);
    expect(() => assertOwnRow({ PK: `WO#wo-24817-${markers.clockTag}`, SK: "META", ispId: "isp-demo" }, "WorkOrders", markers)).toThrow(TemplateError);
    expect(() => assertOwnRow({ PK: `WO#wo-24817-${markers.clockTag}`, SK: "META", clockId: "GLOBAL#isp-demo" }, "WorkOrders", markers)).toThrow(TemplateError);
    expect(() => assertOwnRow({ PK: "WO#wo-24817", SK: "META", ispId: SIGNUP_ISP }, "WorkOrders", markers)).toThrow(TemplateError);
    expect(() => assertOwnRow({ PK: `WO#wo-24817-${markers.clockTag}`, SK: "META", ispId: SIGNUP_ISP }, "WorkOrders", markers)).not.toThrow();
  });

  it("[FL-107] nothing outside the guest's operator: a template with a foreign row writes nothing at all", async () => {
    const world = worldHarness();
    const tables = TEMPLATE_TEXT.indexOf('"tables"');
    const tampered = TEMPLATE_TEXT.slice(0, tables) + TEMPLATE_TEXT.slice(tables).replace('"clockId": "GUEST#{{ispId}}"', '"clockId": "GLOBAL#isp-demo"');
    expect(tampered).not.toBe(TEMPLATE_TEXT);
    await expect(buildWorld({ ...world.factoryDeps(), template: async () => tampered }, { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER })).rejects.toThrow();
    // Only the clock and its epoch counter may exist: the world's rows were never written.
    expect(allRows(world).filter(({ table }) => table !== "Runtime")).toEqual([]);
  });
});
