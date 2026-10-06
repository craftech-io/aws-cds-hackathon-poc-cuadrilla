import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK } from "../connector/testing";
import type { PhotoValidation } from "../domain/work-orders";
import { type EvidenceKit, evidenceKit } from "../agent-tools/evidence/testing";
import { PHOTO_ATTEMPTS_LIMIT, attemptRefs, isPhotoAttemptsDue } from "./attempts";
import { setPhoto } from "./testing";

const validation = (n: number, overrides: Partial<PhotoValidation> = {}): PhotoValidation => ({
  entity: "PhotoValidation",
  synthetic: false,
  createdAt: "",
  updatedAt: "",
  version: 1,
  validationId: `val-01J9ZQX00000000000000000${String(n).padStart(2, "0")}`,
  workOrderId: "wo-24819",
  clockId: CLOCK,
  item: "ONU_LABEL_PHOTO",
  evidenceId: `ev-01J9ZQX00000000000000000${String(n).padStart(2, "0")}`,
  verdict: "REJECT",
  reasonCode: "GLARE",
  readings: {},
  checks: [],
  source: "SCRIPTED",
  atSim: `2026-10-13T11:0${n}:00-06:00`,
  ...overrides,
});

describe("[FL-042] three rejections of the same item: the case, with the three photos", () => {
  it("is due from the third REJECT on, never for UNSURE or PASS", () => {
    expect(PHOTO_ATTEMPTS_LIMIT).toBe(3);
    expect([1, 2, 3, 4].map((attempts) => isPhotoAttemptsDue("REJECT", attempts))).toEqual([false, false, true, true]);
    expect(isPhotoAttemptsDue("UNSURE", 3)).toBe(false);
    expect(isPhotoAttemptsDue("PASS", 5)).toBe(false);
  });

  it("attaches the last three rejected attempts of the item, newest first", () => {
    const rows = [validation(1), validation(2, { verdict: "UNSURE", reasonCode: undefined }), validation(3), validation(4, { item: "ROSETTE_PHOTO" }), validation(5), validation(6, { evidenceId: undefined, reasonCode: "DUPLICATE_EVIDENCE" }), validation(0)];
    expect(attemptRefs(rows, "ONU_LABEL_PHOTO")).toEqual({
      evidenceIds: ["ev-01J9ZQX0000000000000000005", "ev-01J9ZQX0000000000000000003"],
      validationIds: ["val-01J9ZQX0000000000000000006", "val-01J9ZQX0000000000000000005", "val-01J9ZQX0000000000000000003"],
    });
  });

  describe("through validate_install_photo (Karina, wo-24819)", () => {
    let kit: EvidenceKit;
    const karina = { installerId: "inst-karina", workOrderId: "wo-24819" };
    const reject = async (photoId: string) => {
      const candidateId = await kit.sendPhoto(setPhoto(photoId).bytes, karina);
      return kit.gateway("validate_install_photo", { candidateId, item: "ONU_LABEL_PHOTO" }, karina);
    };

    beforeEach(async () => {
      kit = await evidenceKit();
    });

    it("opens PHOTO_ATTEMPTS once at the third REJECT, with the evidence of the three attempts", async () => {
      expect(await reject("ph-label-04")).toMatchObject({ verdict: "REJECT", attempts: 1 });
      expect(await reject("ph-label-06")).toMatchObject({ verdict: "REJECT", attempts: 2 });
      expect(kit.casesOpened).toEqual([]);
      const third = await reject("ph-label-08");
      expect(third).toMatchObject({ verdict: "REJECT", reasonCode: "CROPPED", attempts: 3, caseOpened: { caseId: "case-01J9ZQX0000000000000000009", reason: "PHOTO_ATTEMPTS" } });
      expect(kit.casesOpened).toHaveLength(1);
      const evidence = await kit.memory.connector.workOrders.listEvidence("wo-24819");
      expect([...(kit.casesOpened[0]?.evidenceIds ?? [])].sort()).toEqual(evidence.map((row) => row.evidenceId).sort());
      expect(kit.casesOpened[0]).toMatchObject({ workOrderId: "wo-24819", installerId: "inst-karina", item: "ONU_LABEL_PHOTO" });
      expect(await kit.memory.connector.workOrders.getChecklistItem("wo-24819", "ONU_LABEL_PHOTO")).toMatchObject({ status: "REJECTED", attempts: 3, lastRejectReason: "CROPPED" });
    });

    it("does not count UNSURE, and opens the case on a later rejection when the ladder failed the first time", async () => {
      await reject("ph-label-04");
      await kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(setPhoto("ph-meter-15").bytes, karina), item: "POWER_READING_PHOTO" }, karina);
      await reject("ph-label-05");
      kit.failing.cases = true;
      const third = await reject("ph-label-06");
      expect(third).toMatchObject({ verdict: "REJECT", attempts: 3 });
      expect(third).not.toHaveProperty("caseOpened");
      expect(kit.logs.some((line) => line.message === "evidence.case_open.failed" && line.level === "error")).toBe(true);
      kit.failing.cases = false;
      expect(await reject("ph-label-10")).toMatchObject({ attempts: 4, caseOpened: { reason: "PHOTO_ATTEMPTS" } });
    });
  });
});
