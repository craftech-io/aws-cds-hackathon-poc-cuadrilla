import { describe, expect, it } from "vitest";
import { CLOCK, testConnector } from "../../connector/testing";
import { esMX } from "../../copy/es-MX";
import type { InstallerProfile } from "../../domain/people";
import { MAX_TIPS, TIP_MIN_REJECTS, measuredTips, recordPhotoReject, rejectsInWindow, tipIdOf, tipsForInstaller } from "./profile";

const TURN_AT = "2026-10-13T09:20:00-06:00";

const profile = (overrides: Partial<InstallerProfile> = {}): InstallerProfile => ({
  entity: "InstallerProfile",
  synthetic: false,
  createdAt: "",
  updatedAt: "",
  version: 1,
  installerId: "inst-karina",
  clockId: CLOCK,
  rejects: {},
  stepsBySymptom: {},
  casesByReason: {},
  events: [],
  ...overrides,
});

/** Karina's measured profile of the seed (docs/seed-spec.md §5): two GLARE and one BLURRY on 12/10. */
const KARINA = profile({
  rejects: { GLARE: 2, BLURRY: 1 },
  events: [
    { kind: "REJECT", code: "GLARE", atSim: "2026-10-12T09:48:00-06:00", workOrderId: "wo-24804" },
    { kind: "REJECT", code: "GLARE", atSim: "2026-10-12T09:52:00-06:00", workOrderId: "wo-24804" },
    { kind: "REJECT", code: "BLURRY", atSim: "2026-10-12T15:37:00-06:00", workOrderId: "wo-24806" },
  ],
});

describe("[FL-027] the tip of a recurring error comes from the measured profile", () => {
  it("turns a reason rejected twice in 30 days into a tip with the actionable text of the item", () => {
    expect(TIP_MIN_REJECTS).toBe(2);
    expect(measuredTips(KARINA, TURN_AT, () => "ONU_LABEL_PHOTO")).toEqual([
      { tipId: "tip-glare", reason: "GLARE", count30d: 2, text: esMX.rejectReason("GLARE", "ONU_LABEL_PHOTO") },
    ]);
    expect(esMX.rejectReason("GLARE", "ONU_LABEL_PHOTO")).toContain("apaga el flash");
  });

  it("finds the item of each tip in the rejected validations of the orders the reason happened on", async () => {
    const world = testConnector();
    await world.connector.people.putProfile({ ...KARINA });
    await world.connector.workOrders.createValidation({
      validationId: "val-01J9ZQX0000000000000000001",
      workOrderId: "wo-24804",
      clockId: CLOCK,
      item: "ONU_LABEL_PHOTO",
      verdict: "REJECT",
      reasonCode: "GLARE",
      source: "SEED",
      atSim: "2026-10-12T09:48:00-06:00",
    });
    const tips = await tipsForInstaller({ people: world.connector.people, workOrders: world.connector.workOrders }, "inst-karina", TURN_AT);
    expect(tips).toEqual([{ tipId: "tip-glare", reason: "GLARE", count30d: 2, text: esMX.rejectReason("GLARE", "ONU_LABEL_PHOTO") }]);
    expect(await tipsForInstaller({ people: world.connector.people, workOrders: world.connector.workOrders }, "inst-tomas", TURN_AT)).toEqual([]);
  });

  it("counts only the 30 simulated days up to the turn, never what comes after it", () => {
    const old = profile({
      rejects: { GLARE: 3 },
      events: [
        { kind: "REJECT", code: "GLARE", atSim: "2026-09-10T10:00:00-06:00" },
        { kind: "REJECT", code: "GLARE", atSim: "2026-10-12T10:00:00-06:00" },
        { kind: "REJECT", code: "GLARE", atSim: "2026-10-14T10:00:00-06:00" },
      ],
    });
    expect(rejectsInWindow(old, TURN_AT).get("GLARE")).toHaveLength(1);
    expect(measuredTips(old, TURN_AT)).toEqual([]);
  });

  it("counts a profile a preset seeded with counters only, and the counters no dated event explains", () => {
    expect(measuredTips(profile({ rejects: { GLARE: 2 } }), TURN_AT)).toMatchObject([{ tipId: "tip-glare", count30d: 2 }]);
    const mixed = profile({ rejects: { GLARE: 2 }, events: [{ kind: "REJECT", code: "GLARE", atSim: "2026-10-13T08:00:00-06:00", workOrderId: "wo-24817" }] });
    expect(measuredTips(mixed, TURN_AT)).toMatchObject([{ tipId: "tip-glare", count30d: 2 }]);
  });

  it("keeps the most frequent reasons first, at most three, with stable ids and the item of reading reasons", () => {
    const busy = profile({ rejects: { GLARE: 2, BLURRY: 4, DARK: 3, CROPPED: 2, OUT_OF_RANGE_LOW: 5 } });
    const tips = measuredTips(busy, TURN_AT);
    expect(tips.map((tip) => tip.tipId)).toEqual(["tip-out-of-range-low", "tip-blurry", "tip-dark"]);
    expect(tips).toHaveLength(MAX_TIPS);
    expect(tips[0]?.text).toBe(esMX.rejectReason("OUT_OF_RANGE_LOW", "POWER_READING_PHOTO"));
    expect(tipIdOf("SERIAL_MISMATCH")).toBe("tip-serial-mismatch");
  });

  it("records each rejected photo with its reason, order and simulated instant", async () => {
    const world = testConnector();
    await recordPhotoReject(world.connector.people, { installerId: "inst-rogelio", clockId: CLOCK, reason: "GLARE", atSim: TURN_AT, workOrderId: "wo-24817" });
    await recordPhotoReject(world.connector.people, { installerId: "inst-rogelio", clockId: CLOCK, reason: "GLARE", atSim: "2026-10-13T09:25:00-06:00", workOrderId: "wo-24817" });
    const stored = await world.connector.people.getProfile("inst-rogelio");
    expect(stored).toMatchObject({ rejects: { GLARE: 2 }, events: [{ kind: "REJECT", code: "GLARE", atSim: TURN_AT, workOrderId: "wo-24817" }, expect.any(Object)] });
    expect(measuredTips(stored ?? profile(), "2026-10-14T09:00:00-06:00")).toMatchObject([{ tipId: "tip-glare", count30d: 2 }]);
  });
});
