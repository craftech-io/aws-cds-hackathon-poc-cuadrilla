import { beforeEach, describe, expect, it } from "vitest";
import { ISP, ROGELIO, WO, type WorkerKit, inboundEvent, inboundMessage, seedWorld, workerKit } from "./testing";

let kit: WorkerKit;

beforeEach(async () => {
  kit = workerKit();
  await seedWorld(kit);
});

const EVENT_ID = "wa-in-0000000000000000000000000000000000000001";
const actionsOf = async () => (await kit.connector.audit.listByMonth(ISP, "2026-10")).map((decision) => decision.action);

describe("worker: double idempotency [FL-093]", () => {
  it("[FL-093] the same event delivered twice runs one turn: one Harness call, one note, one transcription", async () => {
    const message = await inboundMessage(kit, { content: "VOICE", text: undefined, media: { kind: "AUDIO", s3Key: "sim/abc-e3/up-1", mime: "audio/ogg", durationSec: 9 } });
    await kit.run(inboundEvent(message));
    await kit.run(inboundEvent(message), 2);
    expect(kit.rec.harness).toHaveLength(1);
    expect(kit.rec.transcriptions).toHaveLength(1);
    expect(await kit.connector.conversations.listTurnNotes(ROGELIO)).toHaveLength(1);
    expect(await kit.connector.runtime.getIdempotency("INBOUND_MESSAGE", EVENT_ID)).toBeDefined();
  });

  it("[FL-093] a delivery that failed before its effect leaves no mark: the redelivery runs the turn", async () => {
    kit.deps.turn.prefilter.check = async () => Promise.reject(Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
    const message = await inboundMessage(kit);
    await expect(kit.run(inboundEvent(message))).rejects.toThrow("throttled");
    expect(await kit.connector.runtime.getIdempotency("INBOUND_MESSAGE", EVENT_ID)).toBeUndefined();
    kit.deps.turn.prefilter.check = async () => ({ action: "NONE" });
    await kit.run(inboundEvent(message), 2);
    expect(kit.rec.harness).toHaveLength(1);
  });

  it("[FL-093] a failure after the Harness answered never invokes it again on the redelivery", async () => {
    const addToKpi = kit.connector.metrics.addToKpi.bind(kit.connector.metrics);
    let failures = 1;
    kit.connector.metrics.addToKpi = async (ref, delta) => (failures-- > 0 ? Promise.reject(new Error("dynamo down")) : addToKpi(ref, delta));
    const message = await inboundMessage(kit);
    await expect(kit.run(inboundEvent(message))).rejects.toThrow("dynamo down");
    await kit.run(inboundEvent(message), 2);
    expect(kit.rec.harness).toHaveLength(1);
    expect(await kit.connector.runtime.getIdempotency("INBOUND_MESSAGE", EVENT_ID)).toBeDefined();
  });

  it("[FL-093] the safety instruction and a fixed notice go out once per event, whatever the retries", async () => {
    kit.g1Verdicts.push({ action: "BLOCKED", policy: "DENIED_TOPIC", topics: ["ELECTRICAL_WORK"] }, { action: "BLOCKED", policy: "DENIED_TOPIC", topics: ["ELECTRICAL_WORK"] });
    const openCase = kit.deps.ports.cases.openCase;
    let failures = 1;
    Object.assign(kit.deps.ports.cases, { openCase: async (...args: Parameters<typeof openCase>) => (failures-- > 0 ? Promise.reject(new Error("cases down")) : openCase(...args)) });
    const message = await inboundMessage(kit, { text: "El cable pelado está chispeando, ¿lo conecto al tablero?" });
    await expect(kit.run(inboundEvent(message))).rejects.toThrow("cases down");
    await kit.run(inboundEvent(message), 2);
    expect(kit.rec.safety).toHaveLength(1);
    expect(kit.rec.cases).toHaveLength(1);
    expect((await actionsOf()).filter((action) => action === "GUARDRAIL_BLOCK")).toHaveLength(1);
  });

  it("[FL-093] writes each of the worker's decisions once per event", async () => {
    await kit.connector.isps.updateSettings(ISP, { turnCaps: { perHour: 0, perDay: 0 } });
    const message = await inboundMessage(kit);
    await kit.run(inboundEvent(message));
    await kit.connector.runtime.releaseIdempotency("INBOUND_MESSAGE", EVENT_ID);
    await kit.run(inboundEvent(message), 2);
    expect((await kit.connector.audit.listByWorkOrder(WO)).map((decision) => decision.action)).toEqual(["TURN_CAP"]);
    expect(kit.rec.notices).toHaveLength(1);
  });
});
