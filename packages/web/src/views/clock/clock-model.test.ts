import { describe, expect, it } from "vitest";
import { canDrive, extrasOf, isGuestWorld, pendingText, refusalText, resetAvailable } from "./clock-model";

const clock = { mode: "PAUSED" as const, simNow: "2026-10-13T07:00:00-06:00", busy: false, pending: [], next: [] };

describe("demo clock model [FL-084] [FL-085] [FL-086]", () => {
  it("reads the extras of clock.get the bar does not need, and tolerates their absence", () => {
    expect(extrasOf({ ...clock, worldEpoch: 3, nextResetAtReal: null, sceneJumpsPerRealHour: 30, runningUntilReal: null } as never)).toEqual({ worldEpoch: 3, nextResetAtReal: null, sceneJumpsPerRealHour: 30, runningUntilReal: null });
    expect(extrasOf(clock)).toEqual({});
    expect(extrasOf(undefined)).toEqual({});
  });

  it("lets supervisors and guests jump and reset, and only guest worlds have scenes", () => {
    expect(canDrive("GUEST")).toBe(true);
    expect(canDrive("SUPERVISOR")).toBe(true);
    expect(canDrive("OPS")).toBe(false);
    expect(isGuestWorld("isp-guest-07")).toBe(true);
    expect(isGuestWorld("isp-demo")).toBe(false);
    expect(isGuestWorld("not an id")).toBe(false);
    expect(isGuestWorld(undefined)).toBe(false);
  });

  it("opens the reset again once the world's next reset time has passed", () => {
    const now = Date.parse("2026-10-20T15:00:00Z");
    expect(resetAvailable({}, now)).toBe(true);
    expect(resetAvailable({ nextResetAtReal: null }, now)).toBe(true);
    expect(resetAvailable({ nextResetAtReal: "2026-10-20T15:05:00Z" }, now)).toBe(false);
    expect(resetAvailable({ nextResetAtReal: "2026-10-20T14:55:00Z" }, now)).toBe(true);
  });

  it("says what a busy world waits for and since when, and has its own words for the refusals it knows", () => {
    const now = Date.parse("2026-10-20T15:07:00Z");
    expect(pendingText({ kind: "TRANSCRIBE", sinceReal: "2026-10-20T15:00:00Z" }, now)).toBe("Transcribiendo una nota de voz (~15 s), desde hace 7 minutos");
    expect(pendingText({ kind: "TURN", sinceReal: "2026-10-20T15:06:40Z" }, now)).toBe("El agente está escribiendo (~30 s), desde hace menos de un minuto");
    const error = { kind: "conflict" as const, code: "CONFLICT", httpStatus: 409, correlationId: null, message: "" };
    expect(refusalText({ ...error, reason: "RESET_TOO_SOON" })).toContain("hace menos de 10 minutos");
    expect(refusalText({ ...error, reason: "WORLD_BUSY" })).toContain("ocupado");
    expect(refusalText({ ...error, reason: "SOMETHING_ELSE" })).toBeUndefined();
    expect(refusalText({ ...error, reason: null })).toBeUndefined();
  });
});
