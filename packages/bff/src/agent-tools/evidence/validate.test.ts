import { beforeEach, describe, expect, it } from "vitest";
import { evidencePhotoKey } from "@cuadrilla/shared/media/keys";
import { CLOCK, ISP, QA_CLOCK, QA_ISP, workOrder } from "../../connector/testing";
import { esMX } from "../../copy/es-MX";
import { sha256Hex } from "../../lib/crypto";
import { candidateIdOf } from "../../evidence/candidate";
import { isMetadataMarker, stripJpegMetadata } from "../../evidence/strip-metadata";
import { gradient, setPhoto, writePng } from "../../evidence/testing";
import { TURN_ID } from "../common/testing";
import { type EvidenceKit, demoSettings, evidenceKit } from "./testing";

let kit: EvidenceKit;
const failure = (response: { ok: boolean; error?: { code: string; reason?: string } }) => (response.ok ? undefined : [response.error?.code, response.error?.reason]);

beforeEach(async () => {
  kit = await evidenceKit();
});

async function denials(rule: string) {
  return (await kit.memory.connector.audit.listByDecision(ISP, "DENY")).filter((row) => row.ruleIds.includes(rule));
}

function hasMetadata(jpeg: Uint8Array): boolean {
  let offset = 2;
  while (offset < jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1] ?? 0;
    if (marker === 0xda) return false;
    if (isMetadataMarker(marker)) return true;
    offset += 2 + (((jpeg[offset + 2] ?? 0) << 8) | (jpeg[offset + 3] ?? 0));
  }
  return false;
}

describe("[FL-036] a meter photo in range: PASS, evidence kept without metadata, item marked by update_checklist", () => {
  it("validates the candidate of the turn and leaves the validation, the evidence and the audit", async () => {
    const photo = setPhoto("ph-meter-01");
    const candidateId = await kit.sendPhoto(photo.bytes);
    const response = await kit.gateway("validate_install_photo", { candidateId, item: "POWER_READING_PHOTO" });
    expect(response).toMatchObject({ ok: true, verdict: "PASS", readings: { readingDbm: -21.4, wavelengthNm: 1490 }, attempts: 0 });
    expect(response).not.toHaveProperty("reasonText");
    const { workOrders } = kit.memory.connector;
    const [validation] = await workOrders.listValidations("wo-24817", "POWER_READING_PHOTO");
    expect(validation).toMatchObject({ verdict: "PASS", modelVerdict: "PASS", rubricVersion: "v001", sha256: photo.sha256, stopReason: "tool_use", usage: { inputTokens: 1600, outputTokens: 220 }, source: "SCRIPTED", candidateId, checks: [] });
    const [evidence] = await workOrders.listEvidence("wo-24817");
    expect(evidence).toMatchObject({ evidenceId: validation?.evidenceId, sha256: photo.sha256, mime: "image/jpeg", sourceMessageId: "wamid.SIM.photo-1" });
    const stored = kit.objects.evidence.get(evidencePhotoKey(CLOCK, 1, "wo-24817", "POWER_READING_PHOTO", evidence?.evidenceId ?? ""));
    expect(stored).toBeDefined();
    expect(hasMetadata(stored ?? new Uint8Array())).toBe(false);
    // CHECK# PASSED is only update_checklist's.
    expect((await workOrders.getChecklistItem("wo-24817", "POWER_READING_PHOTO"))?.status).toBe("PENDING");
    const updated = await kit.gateway("update_checklist", { item: "POWER_READING_PHOTO", status: "PASSED", validationId: validation?.validationId });
    expect(updated).toMatchObject({ ok: true, status: "PASSED", complete: false });
    const actions = await kit.memory.connector.audit.listByDecision(ISP, "ACTION");
    expect(actions.find((row) => row.action === "PHOTO_VALIDATED")).toMatchObject({ actor: "AGENT", refs: { workOrderId: "wo-24817", item: "POWER_READING_PHOTO", turnId: TURN_ID }, detail: { verdict: "PASS", modelCalled: true } });
    expect(kit.network.calls).toEqual(["HARNESS:DEMO3F2C19A0"]);
  });

  it("reserves the world's and the stage's validation caps before the model, and stops at the cap without calling it", async () => {
    await kit.sendPhoto(setPhoto("ph-meter-01").bytes);
    const candidateId = candidateIdOf("wamid.SIM.photo-1");
    await kit.gateway("validate_install_photo", { candidateId, item: "POWER_READING_PHOTO" });
    const counters = [...kit.store.items.entries()].filter(([key]) => key.startsWith("SIMCAP#") || key.startsWith("VALCAP#"));
    expect(counters.map(([key, value]) => [key.split("#").slice(0, 2).join("#"), value.used])).toEqual([
      [`SIMCAP#${CLOCK.split("#")[0]}`, 1],
      ["VALCAP#GLOBAL", 1],
    ]);
    await kit.memory.connector.isps.putSettings(demoSettings(ISP, CLOCK, { simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 1, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 20 } }));
    const second = await kit.sendPhoto(setPhoto("ph-meter-02").bytes);
    expect(failure(await kit.gateway("validate_install_photo", { candidateId: second, item: "POWER_READING_PHOTO" }))).toEqual(["CAP_REACHED", "SIMULATOR"]);
    expect(kit.model.calls).toHaveLength(1);
    expect((await kit.memory.connector.audit.listByDecision(ISP, "DENY")).map((row) => [row.action, row.reason])).toContainEqual(["VALIDATE_PHOTO", "CAP_REACHED"]);
  });

  it("converts a live PNG into the JPEG it keeps, and answers with the fixed notice for one it cannot keep", async () => {
    const png = writePng(24, gradient(24, 18, 3), 2);
    const candidateId = await kit.sendPhoto(png, { mime: "image/png" });
    const response = await kit.gateway("validate_install_photo", { candidateId, item: "ROSETTE_PHOTO" });
    expect(response).toMatchObject({ ok: true, verdict: "UNSURE" });
    const [stored] = [...kit.objects.evidence.values()];
    expect([stored?.[0], stored?.[1]]).toEqual([0xff, 0xd8]);
    const broken = await kit.sendPhoto(png.slice(0, 40), { mime: "image/png" });
    expect(failure(await kit.gateway("validate_install_photo", { candidateId: broken, item: "ROSETTE_PHOTO" }))).toEqual(["INVALID", "PNG_NOT_CONVERTIBLE"]);
    expect(kit.notices.map((notice) => notice.notice)).toEqual(["imageUnreadable"]);
    expect(kit.model.calls).toHaveLength(1);
  });
});

describe("LAM-CANDIDATE: only a photo the installer of the session sent on the order", () => {
  it("refuses an unknown id, another installer's photo and a photo of another order, with the audit", async () => {
    const bytes = setPhoto("ph-label-01").bytes;
    const karina = await kit.sendPhoto(bytes, { installerId: "inst-karina", workOrderId: "wo-24819" });
    const otherOrder = await kit.sendPhoto(bytes, { workOrderId: "wo-24818" });
    for (const candidateId of ["ec_000000000000000000000000", "wamid.SIM.photo-1", karina, otherOrder]) {
      expect(failure(await kit.gateway("validate_install_photo", { candidateId, item: "ONU_LABEL_PHOTO" }))).toEqual(["FORBIDDEN", "LAM-CANDIDATE"]);
    }
    expect(await denials("LAM-CANDIDATE")).toHaveLength(4);
    expect(kit.model.calls).toEqual([]);
  });

  it("refuses an id the model added and an item that is not a photo, before anything is read", async () => {
    const candidateId = await kit.sendPhoto(setPhoto("ph-label-01").bytes);
    expect(failure(await kit.gateway("validate_install_photo", { candidateId, item: "ONU_LABEL_PHOTO", installerId: "inst-karina" }))).toEqual(["INVALID", "LAM-STRICT"]);
    expect(await denials("LAM-STRICT")).toHaveLength(1);
    expect(failure(await kit.gateway("validate_install_photo", { candidateId, item: "CUSTOMER_OK" }))?.[0]).toBe("INVALID");
    expect(kit.model.calls).toEqual([]);
  });

  it("lets the same candidate be validated for another item of the same order (FL-039)", async () => {
    const candidateId = await kit.sendPhoto(setPhoto("ph-meter-21").bytes);
    expect(await kit.gateway("validate_install_photo", { candidateId, item: "POWER_READING_PHOTO" })).toMatchObject({ verdict: "REJECT", reasonCode: "WRONG_SUBJECT", reasonText: esMX.rejectReason("WRONG_SUBJECT", "POWER_READING_PHOTO") });
    const asRosette = await kit.gateway("validate_install_photo", { candidateId, item: "ROSETTE_PHOTO" });
    expect(asRosette.ok).toBe(true);
    expect(await kit.memory.connector.workOrders.listValidations("wo-24817")).toHaveLength(2);
  });
});

describe("[FL-041] a duplicate is rejected before the model, and its bytes stay with the first order", () => {
  it("rejects the same bytes on another order of the world without a model call or an evidence copy", async () => {
    const bytes = setPhoto("ph-meter-01").bytes;
    await kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(bytes), item: "POWER_READING_PHOTO" });
    await kit.memory.connector.runtime.closeTurn(TURN_ID);
    const second = await kit.sendPhoto(bytes, { workOrderId: "wo-24818" });
    const response = await kit.gateway("validate_install_photo", { candidateId: second, item: "POWER_READING_PHOTO" }, { turnId: "01JB8Z9Q2W3E4R5T6Y7V8X9TR2", workOrderId: "wo-24818" });
    expect(response).toMatchObject({ ok: true, verdict: "REJECT", reasonCode: "DUPLICATE_EVIDENCE", attempts: 1, reasonText: esMX.rejectReason("DUPLICATE_EVIDENCE", "POWER_READING_PHOTO") });
    expect(kit.model.calls).toHaveLength(1);
    const [validation] = await kit.memory.connector.workOrders.listValidations("wo-24818");
    expect(validation).toMatchObject({ verdict: "REJECT", checks: ["VAL-DUPLICATE"], sha256: sha256Hex(bytes) });
    expect(validation?.modelVerdict).toBeUndefined();
    expect(validation?.evidenceId).toBeUndefined();
    expect(await kit.memory.connector.workOrders.listEvidence("wo-24818")).toEqual([]);
    expect((await kit.memory.connector.people.getProfile("inst-rogelio"))?.rejects).toEqual({ DUPLICATE_EVIDENCE: 1 });
  });
});

describe("[FL-043] UNSURE goes to the review tray and the validator's outage leaves nothing behind", () => {
  it("marks the item IN_REVIEW with the fixed text and counts no attempt", async () => {
    const response = await kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(setPhoto("ph-meter-15").bytes), item: "POWER_READING_PHOTO" });
    expect(response).toMatchObject({ ok: true, verdict: "UNSURE", reasonText: esMX.photoInReview, attempts: 0 });
    expect(await kit.memory.connector.workOrders.getChecklistItem("wo-24817", "POWER_READING_PHOTO")).toMatchObject({ status: "IN_REVIEW", attempts: 0 });
  });

  it("answers UNAVAILABLE when the model cannot answer, with no validation, evidence nor checklist change", async () => {
    const photo = setPhoto("ph-label-01");
    kit.model.answers.set(sha256Hex(stripJpegMetadata(photo.bytes).jpeg), { kind: "UNAVAILABLE", reason: "ThrottlingException", latencyMs: 40_000 });
    expect(failure(await kit.gateway("validate_install_photo", { candidateId: await kit.sendPhoto(photo.bytes), item: "ONU_LABEL_PHOTO" }))).toEqual(["UNAVAILABLE", "VALIDATOR_UNAVAILABLE"]);
    expect(await kit.memory.connector.workOrders.listValidations("wo-24817")).toEqual([]);
    expect(kit.objects.evidence.size).toBe(0);
    expect(kit.reactions).toEqual([]);
  });
});

describe("the order and the principal of a validation", () => {
  it("refuses an order on hold for safety and a closed one", async () => {
    const candidateId = await kit.sendPhoto(setPhoto("ph-rosette-01").bytes);
    await kit.memory.connector.workOrders.setOnHoldSafety("wo-24817", true, { actor: "SYSTEM" });
    expect(failure(await kit.gateway("validate_install_photo", { candidateId, item: "ROSETTE_PHOTO" }))).toEqual(["ON_HOLD_SAFETY", "ON_HOLD_SAFETY"]);
    await kit.memory.connector.workOrders.setOnHoldSafety("wo-24817", false, { actor: "SYSTEM" });
    await kit.memory.connector.workOrders.setStatus("wo-24817", "CANCELLED", { actor: "SYSTEM" });
    expect(failure(await kit.gateway("validate_install_photo", { candidateId, item: "ROSETTE_PHOTO" }))).toEqual(["CONFLICT", "ORDER_NOT_OPEN"]);
  });

  it("serves the QaDriver in a qa-* world at the world's time, reading the orchestrator as QA", async () => {
    const { connector } = kit.memory;
    await connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-70001", workOrderNumber: "70001", ispId: QA_ISP, clockId: QA_CLOCK }));
    await connector.isps.putSettings(demoSettings(QA_ISP, QA_CLOCK));
    await connector.isps.putZone({ ispId: QA_ISP, clockId: QA_CLOCK, zoneId: "zone-norte", name: "Zona Norte", opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8 }, zoneChiefId: "zc-marisol" });
    await connector.runtime.createClock({ clockId: QA_CLOCK, ispId: QA_ISP, kind: "QA", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-13T12:00:00-06:00", worldEpoch: 1 });
    const candidateId = await kit.sendPhoto(setPhoto("ph-meter-07").bytes, { workOrderId: "wo-70001", clockId: QA_CLOCK, ispId: QA_ISP });
    kit.readings.set("DEMO3F2C19A0", -28.6);
    const caller = { kind: "QA", ispId: QA_ISP, clockId: QA_CLOCK, eventId: "qa-evt-1" };
    const response = await kit.target.handler({ tool: "validate_install_photo", input: { caller, candidateId, item: "POWER_READING_PHOTO" }, subject: { workOrderId: "wo-70001" } });
    expect(response).toMatchObject({ ok: true, verdict: "REJECT", reasonCode: "OUT_OF_RANGE_LOW", attempts: 1 });
    expect(kit.network.calls).toEqual(["QA:DEMO3F2C19A0"]);
    const [validation] = await connector.workOrders.listValidations("wo-70001");
    expect(validation?.atSim).toBe("2026-10-13T18:00:00.000Z");
    expect(kit.reactions).toEqual([]);
  });

  it("keeps a guest world's evidence under its own prefix", async () => {
    const guestClock = "GUEST#isp-guest-07";
    const { connector } = kit.memory;
    await connector.people.createPerson({ personId: "inst-rogelio-g07", ispId: "isp-guest-07", clockId: guestClock, role: "INSTALLER", firstName: "Rogelio", lastName: "Méndez", crewId: "crew-n3", zoneId: "zone-norte", phone: "+525502070001", phoneHash: "e".repeat(64), active: true });
    await connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24817-g07", ispId: "isp-guest-07", clockId: guestClock, installerId: "inst-rogelio-g07", worldEpoch: 3 }));
    await connector.isps.putSettings(demoSettings("isp-guest-07", guestClock));
    const candidateId = await kit.sendPhoto(setPhoto("ph-rosette-01").bytes, { installerId: "inst-rogelio-g07", workOrderId: "wo-24817-g07", clockId: guestClock, ispId: "isp-guest-07" });
    const response = await kit.gateway("validate_install_photo", { candidateId, item: "ROSETTE_PHOTO" }, { ispId: "isp-guest-07", clockId: guestClock, installerId: "inst-rogelio-g07", workOrderId: "wo-24817-g07" });
    expect(response).toMatchObject({ ok: true, verdict: "PASS" });
    const [key] = [...kit.objects.evidence.keys()];
    expect(key?.startsWith("guest/")).toBe(true);
    expect(key).toContain("/photos/wo-24817-g07/ROSETTE_PHOTO/ev-");
  });
});
