import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { CLOCK, ISP, testConnector, workOrder } from "../connector/testing";
import { sha256Hex } from "../lib/crypto";
import { MAX_PHOTO_BYTES, acceptanceRangeFor, decideVerdict, duplicateEvidence, needsNetworkReading, normalizeSerial, precheckPhoto } from "./checks";
import type { RecordVerdict } from "./record-verdict";
import { demoZones, setPhoto } from "./testing";

const B_PLUS = { minDbm: -25, maxDbm: -8 };
const ORDER = { onuSerial: "DEMO3F2C19A0" };
const meter = (overrides: Partial<RecordVerdict> = {}): RecordVerdict => ({
  subject: "POWER_METER",
  quality: { focus: "SHARP", glare: "NONE", framing: "COMPLETE", lighting: "GOOD" },
  readingDbm: -21.4,
  wavelengthNm: 1490,
  serial: null,
  modelVerdict: "PASS",
  reasonCode: null,
  confidence: 0.93,
  ...overrides,
});
const label = (serial: string | null, overrides: Partial<RecordVerdict> = {}) => meter({ subject: "ONU_LABEL", readingDbm: null, wavelengthNm: null, serial, ...overrides });
const online = (rxPowerDbm: number) => ({ kind: "OK" as const, rxPowerDbm });
const decideMeter = (record: RecordVerdict, rx = -21.4) => decideVerdict({ item: "POWER_READING_PHOTO", record, order: ORDER, range: B_PLUS, network: online(rx) });

describe("[FL-036] a meter in range at 1490 nm and within 3 dB of the orchestrator passes", () => {
  it("passes ph-meter-01 and keeps what the model read", () => {
    expect(decideMeter(meter())).toEqual({ verdict: "PASS", checks: [], readings: { readingDbm: -21.4, wavelengthNm: 1490 } });
  });

  it("asks for the orchestrator only for a meter photo that reaches the cross-check", () => {
    expect(needsNetworkReading("POWER_READING_PHOTO", meter())).toBe(true);
    expect(needsNetworkReading("POWER_READING_PHOTO", meter({ modelVerdict: "REJECT", reasonCode: "BLURRY" }))).toBe(false);
    expect(needsNetworkReading("POWER_READING_PHOTO", meter({ confidence: 0.4 }))).toBe(false);
    expect(needsNetworkReading("ONU_LABEL_PHOTO", label("DEMO3F2C19A0"))).toBe(false);
    expect(needsNetworkReading("POWER_READING_PHOTO", undefined)).toBe(false);
  });
});

describe("[FL-037] the code decides the range, whatever the model said", () => {
  it("rejects below and above the range of the order's class, with the boundaries inside", () => {
    expect(decideMeter(meter({ readingDbm: -28.9 }), -28.6)).toMatchObject({ verdict: "REJECT", reasonCode: "OUT_OF_RANGE_LOW", checks: ["VAL-RANGE"] });
    expect(decideMeter(meter({ readingDbm: -6.1 }), -6.4)).toMatchObject({ verdict: "REJECT", reasonCode: "OUT_OF_RANGE_HIGH", checks: ["VAL-RANGE"] });
    expect(decideMeter(meter({ readingDbm: -25 }), -25).verdict).toBe("PASS");
    expect(decideMeter(meter({ readingDbm: -8 }), -8).verdict).toBe("PASS");
    expect(decideMeter(meter({ readingDbm: -25.1 }), -25).reasonCode).toBe("OUT_OF_RANGE_LOW");
  });

  it("takes the range of the order's optical class: the order's zone first, else another zone with the class", () => {
    const zones = demoZones(ISP, CLOCK).map((zone) => ({ ...zone, entity: "Zone" as const, createdAt: "", updatedAt: "", version: 1, synthetic: false }));
    expect(acceptanceRangeFor({ zoneId: "zone-norte", opticalClass: "B+" }, zones)).toEqual({ minDbm: -25, maxDbm: -8 });
    expect(acceptanceRangeFor({ zoneId: "zone-norte", opticalClass: "C+" }, zones)).toEqual({ minDbm: -28, maxDbm: -8 });
    expect(acceptanceRangeFor({ zoneId: "zone-norte", opticalClass: "C+" }, zones.slice(0, 1))).toBeUndefined();
    expect(decideVerdict({ item: "POWER_READING_PHOTO", record: meter(), order: ORDER, range: undefined, network: online(-21.4) })).toMatchObject({ verdict: "UNSURE", checks: ["VAL-RANGE"] });
  });

  it("rejects a wavelength other than 1490 nm before the range", () => {
    expect(decideMeter(meter({ wavelengthNm: 1310, readingDbm: -30 }))).toMatchObject({ verdict: "REJECT", reasonCode: "WRONG_WAVELENGTH", checks: ["VAL-WAVELENGTH"] });
  });

  it("never turns a REJECT into a PASS", () => {
    const blurry = meter({ modelVerdict: "REJECT", reasonCode: "BLURRY", readingDbm: -21.4 });
    expect(decideMeter(blurry)).toMatchObject({ verdict: "REJECT", reasonCode: "BLURRY", checks: [] });
    // A model REJECT whose reason needs the order is checked like a PASS: never PASS.
    expect(decideMeter(meter({ modelVerdict: "REJECT", reasonCode: "OUT_OF_RANGE_LOW" }))).toMatchObject({ verdict: "UNSURE" });
    expect(decideMeter(meter({ modelVerdict: "REJECT", reasonCode: null, readingDbm: -30 }), -30)).toMatchObject({ verdict: "REJECT", reasonCode: "OUT_OF_RANGE_LOW" });
  });

  it("sends a passing meter it could not fully read to a person", () => {
    expect(decideMeter(meter({ readingDbm: null }))).toMatchObject({ verdict: "UNSURE", checks: ["VAL-CONFIDENCE"] });
    expect(decideMeter(meter({ wavelengthNm: null }))).toMatchObject({ verdict: "UNSURE", checks: ["VAL-CONFIDENCE"] });
  });
});

describe("[FL-039] the subject is compared with the item asked for", () => {
  it("rejects a rosette sent as the meter, even when the model passed it", () => {
    const rosette = meter({ subject: "ROSETTE", readingDbm: null, wavelengthNm: null });
    expect(decideVerdict({ item: "POWER_READING_PHOTO", record: rosette, order: ORDER, range: B_PLUS })).toMatchObject({ verdict: "REJECT", reasonCode: "WRONG_SUBJECT", checks: ["VAL-SUBJECT"] });
    expect(decideVerdict({ item: "ROSETTE_PHOTO", record: rosette, order: ORDER, range: B_PLUS })).toMatchObject({ verdict: "PASS" });
  });
});

describe("[FL-041] evidence inconsistent with the order", () => {
  it("rejects a label of another ONU and compares serials without spaces or case", () => {
    expect(decideVerdict({ item: "ONU_LABEL_PHOTO", record: label("DEMO3F2C9999"), order: ORDER, range: B_PLUS })).toEqual({
      verdict: "REJECT",
      reasonCode: "SERIAL_MISMATCH",
      checks: ["VAL-SERIAL"],
      readings: { serial: "DEMO3F2C9999", serialMatches: false },
    });
    expect(decideVerdict({ item: "ONU_LABEL_PHOTO", record: label("demo 3f2c 19a0"), order: ORDER, range: B_PLUS })).toMatchObject({ verdict: "PASS", readings: { serialMatches: true } });
    expect(normalizeSerial(" demo3F2C19a0 ")).toBe("DEMO3F2C19A0");
    expect(decideVerdict({ item: "ONU_LABEL_PHOTO", record: label(null), order: ORDER, range: B_PLUS })).toMatchObject({ verdict: "UNSURE", checks: ["VAL-CONFIDENCE"] });
  });

  it("rejects a reading more than 3 dB away from the orchestrator, and goes to a person when it cannot read it", () => {
    expect(decideMeter(meter({ readingDbm: -15 }), -21.4)).toMatchObject({ verdict: "REJECT", reasonCode: "READING_MISMATCH", checks: ["VAL-CROSSCHECK"] });
    expect(decideMeter(meter({ readingDbm: -18.4 }), -21.4).verdict).toBe("PASS");
    expect(decideVerdict({ item: "POWER_READING_PHOTO", record: meter(), order: ORDER, range: B_PLUS, network: { kind: "UNAVAILABLE" } })).toMatchObject({ verdict: "UNSURE", checks: ["VAL-CROSSCHECK"] });
    expect(decideVerdict({ item: "POWER_READING_PHOTO", record: meter(), order: ORDER, range: B_PLUS, network: { kind: "OK" } })).toMatchObject({ verdict: "UNSURE", checks: ["VAL-CROSSCHECK"] });
  });

  it("finds a duplicate only on another order of the same world and epoch: the same bytes in another world are not one", async () => {
    const photo = setPhoto("ph-meter-01");
    const sha = sha256Hex(photo.bytes);
    const world = testConnector();
    const guestClock = "GUEST#isp-guest-07";
    await world.connector.workOrders.createWorkOrder(workOrder());
    await world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24817-g07", ispId: "isp-guest-07", clockId: guestClock, worldEpoch: 1 }));
    const evidence = { item: "POWER_READING_PHOTO" as const, sha256: sha, mime: "image/jpeg" as const, bytes: photo.bytes.length, receivedAtSim: "2026-10-13T10:00:00-06:00" };
    await world.connector.workOrders.createEvidence({ ...evidence, evidenceId: "ev-01J9ZQX0000000000000000000", workOrderId: "wo-24817-g07", clockId: guestClock, worldEpoch: 1, s3Key: "guest/x/photos/a.jpg" });
    // Another world with the same bytes: nothing found in the demo world.
    expect(duplicateEvidence(await world.connector.workOrders.findEvidenceByHash(CLOCK, 1, sha), "wo-24818")).toBeUndefined();
    await world.connector.workOrders.createEvidence({ ...evidence, evidenceId: "ev-01J9ZQX0000000000000000001", workOrderId: "wo-24817", clockId: CLOCK, worldEpoch: 1, s3Key: "photos/a.jpg" });
    const found = await world.connector.workOrders.findEvidenceByHash(CLOCK, 1, sha);
    expect(duplicateEvidence(found, "wo-24818")?.workOrderId).toBe("wo-24817");
    // The same order sends it again: not a duplicate. Another epoch of the world: not either.
    expect(duplicateEvidence(found, "wo-24817")).toBeUndefined();
    expect(await world.connector.workOrders.findEvidenceByHash(CLOCK, 2, sha)).toEqual([]);
  });
});

describe("pre-checks of the bytes", () => {
  it("accepts JPEG and PNG by their magic bytes, nothing else, and nothing over 3.75 MB", () => {
    expect(precheckPhoto(setPhoto("ph-label-01").bytes)).toEqual({ ok: true, type: "image/jpeg" });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...deflateSync(Buffer.from("x"))]);
    expect(precheckPhoto(png)).toEqual({ ok: true, type: "image/png" });
    expect(precheckPhoto(new TextEncoder().encode("GIF89a…"))).toEqual({ ok: false, problem: "UNSUPPORTED_TYPE" });
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(precheckPhoto(big)).toEqual({ ok: false, problem: "TOO_LARGE" });
    expect(MAX_PHOTO_BYTES).toBe(3.75 * 1024 * 1024);
  });
});
