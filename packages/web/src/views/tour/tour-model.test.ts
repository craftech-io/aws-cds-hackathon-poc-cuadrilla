import { describe, expect, it } from "vitest";
import { tourCopy } from "./copy";
import { TOUR_SCENES, TOUR_STEPS, TOUR_TRACKS, allSteps, lookText, placeholdersOf, sceneOf, tourSim, wallTime } from "./steps";
import { canJump, initialLang, viewOfResult, viewPath, waitLimitMs } from "./tour-model";

describe("guided tour panel [FL-084]", () => {
  it("starts in the browser's language and switches between es and en", () => {
    expect(initialLang("en-US")).toBe("en");
    expect(initialLang("es-MX")).toBe("es");
    expect(initialLang(undefined)).toBe("es");
    expect(tourCopy.en.otherLanguage).toBe("Español");
    expect(tourCopy.es.otherLanguage).toBe("English");
  });

  it("opens the view a button asks for, and the role's home for the portada", () => {
    expect(viewPath("metrics", "GUEST")).toBe("/app/metrics");
    expect(viewPath("outbox", "SUPERVISOR")).toBe("/app/outbox");
    expect(viewPath("home", "GUEST")).toBe("/app/home");
    expect(viewPath("home", "SUPERVISOR")).toBe("/app/orders");
    expect(viewOfResult({ kind: "VIEW", result: { view: "manual" } })).toBe("manual");
    expect(viewOfResult({ kind: "QUICK", result: { messageId: "x" } })).toBeUndefined();
    expect(viewOfResult(null)).toBeUndefined();
  });

  it("waits for a busy world twice the step's wait, at least 30 s; scenes only for supervisors and guests of a guest world", () => {
    expect(waitLimitMs({ waitSec: 5 })).toBe(30_000);
    expect(waitLimitMs({ waitSec: 100 })).toBe(200_000);
    expect(canJump("GUEST", true)).toBe(true);
    expect(canJump("SUPERVISOR", false)).toBe(false);
    expect(canJump("OPS", true)).toBe(false);
  });
});

describe("guided tour steps (views/tour/steps.ts) [FL-084]", () => {
  it("has the express and the full track with their estimate, every step in both languages", () => {
    expect(TOUR_STEPS.EXPRESS.map((step) => step.stepId)).toEqual(["X1", "X2", "X3", "X4"]);
    expect(TOUR_STEPS.FULL).toHaveLength(13);
    expect(TOUR_TRACKS.EXPRESS.minutes).toBe(5);
    expect(TOUR_TRACKS.FULL.minutes).toBe(15);
    for (const { step } of allSteps()) for (const lang of ["es", "en"] as const) expect(step.title[lang] && step.action[lang] && step.look[lang] && step.wait[lang]).toBeTruthy();
  });

  it("gives every step its scene (when it has one) and fills 'Qué mirar' with real hours", () => {
    for (const { step } of allSteps()) if (step.sceneId !== null) expect(sceneOf(step.sceneId)).toBeDefined();
    expect(TOUR_SCENES).toHaveLength(11);
    const first = TOUR_STEPS.FULL[0];
    expect(first && placeholdersOf(first.look.es)).toEqual(["dayStart"]);
    expect(first && lookText(first, "es")).toContain("pendiente a las 07:30");
    expect(first && lookText(first, "es", [{ kind: "DAY_START", dueAtSim: "2026-10-13T07:30:00-06:00" }])).not.toMatch(/\{/);
    expect(wallTime(tourSim("11:50"))).toBe("11:50");
    expect(() => tourSim("25:00")).toThrow(RangeError);
  });

  it("never names the internal ids of the measurement or the words a visible surface must not use", () => {
    const text = JSON.stringify(TOUR_STEPS);
    expect(text).not.toMatch(/EV-0\d/);
    expect(text.toLowerCase()).not.toMatch(/evaluaci|evaluation/);
  });
});
