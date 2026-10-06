import { beforeEach, describe, expect, it } from "vitest";
import { ISP, QA_CLOCK, QA_ISP, workOrder } from "../../connector/testing";
import { setPhoto } from "../../evidence/testing";
import { TURN_ID } from "../common/testing";
import { verdictEmoji } from "./reaction";
import { type EvidenceKit, demoSettings, evidenceKit } from "./testing";

let kit: EvidenceKit;

beforeEach(async () => {
  kit = await evidenceKit();
});

const validate = async (photoId: string, item: string) => kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(setPhoto(photoId).bytes), item });

describe("[FL-103] the reaction to the verdict of a photo", () => {
  it("never shows ✅ for anything but a PASS", () => {
    expect(verdictEmoji("PASS")).toBe("✅");
    expect(verdictEmoji("REJECT")).toBe("🔁");
    expect(verdictEmoji("UNSURE")).toBe("🔁");
  });

  it("reacts exactly once per validated photo, on the photo's message, with the final verdict", async () => {
    const pass = await validate("ph-meter-01", "POWER_READING_PHOTO");
    // The model passes ph-meter-07; the code rejects it: the reaction follows the final verdict.
    kit.readings.set("DEMO3F2C19A0", -28.6);
    const reject = await validate("ph-meter-07", "POWER_READING_PHOTO");
    const unsure = await validate("ph-meter-15", "POWER_READING_PHOTO");
    expect(kit.reactions.map((reaction) => [reaction.messageId, reaction.emoji, reaction.verdict, reaction.validationId])).toEqual([
      ["wamid.SIM.photo-1", "✅", "PASS", pass.validationId],
      ["wamid.SIM.photo-2", "🔁", "REJECT", reject.validationId],
      ["wamid.SIM.photo-3", "🔁", "UNSURE", unsure.validationId],
    ]);
    expect(kit.reactions[0]).toMatchObject({ ispId: ISP, installerId: "inst-rogelio", workOrderId: "wo-24817", turnId: TURN_ID, correlationId: TURN_ID });
  });

  it("reacts to a duplicate rejected before the model too", async () => {
    const bytes = setPhoto("ph-meter-01").bytes;
    await kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(bytes), item: "POWER_READING_PHOTO" });
    await kit.memory.connector.runtime.closeTurn(TURN_ID);
    const session = { turnId: "01JB8Z9Q2W3E4R5T6Y7V8X9TR3", workOrderId: "wo-24818" };
    await kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(bytes, { workOrderId: "wo-24818" }), item: "POWER_READING_PHOTO" }, session);
    expect(kit.reactions.map((reaction) => reaction.emoji)).toEqual(["✅", "🔁"]);
  });

  it("does not react to a validation the QaDriver invokes: there is no turn and nobody waiting", async () => {
    const { connector } = kit.memory;
    await connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-70002", workOrderNumber: "70002", ispId: QA_ISP, clockId: QA_CLOCK }));
    await connector.isps.putSettings(demoSettings(QA_ISP, QA_CLOCK));
    await connector.runtime.createClock({ clockId: QA_CLOCK, ispId: QA_ISP, kind: "QA", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-13T12:00:00-06:00", worldEpoch: 1 });
    const candidateId = await kit.sendPhoto(setPhoto("ph-rosette-01").bytes, { workOrderId: "wo-70002", clockId: QA_CLOCK, ispId: QA_ISP });
    const caller = { kind: "QA", ispId: QA_ISP, clockId: QA_CLOCK, eventId: "qa-evt-2" };
    const response = await kit.target.handler({ tool: "validate_install_photo", input: { caller, candidateId, item: "ROSETTE_PHOTO" }, subject: { workOrderId: "wo-70002" } });
    expect(response).toMatchObject({ ok: true, verdict: "PASS" });
    expect(kit.reactions).toEqual([]);
    expect(await connector.workOrders.getChecklistItem("wo-70002", "ROSETTE_PHOTO")).toMatchObject({ status: "PENDING" });
  });

  it("keeps the validation when the pipeline fails, and logs it", async () => {
    kit.failing.outbound = true;
    expect(await validate("ph-label-01", "ONU_LABEL_PHOTO")).toMatchObject({ ok: true, verdict: "PASS" });
    expect(await kit.memory.connector.workOrders.listValidations("wo-24817")).toHaveLength(1);
    expect(kit.logs.some((line) => line.message === "evidence.reaction.failed" && line.level === "error")).toBe(true);
  });
});
