import { describe, expect, it } from "vitest";
import { FOREIGN_META_ID, GUEST, PEOPLE, UNKNOWN_PHONE, inboundHarness, liveEvent, simEvent, waText } from "../channels/whatsapp/testing";
import { inboundEventId } from "../channels/whatsapp/ports";
import { foreignProbeId } from "../connector/keys";
import { captureLogger, queuedBodies, recordingSender, recordingSink } from "../feeds/testing";
import { killSwitchKey } from "../ops/kill-switch";
import { InboundRetryError, createInboundWhatsAppHandler } from "./inbound-whatsapp";

const DEMO = "GLOBAL#isp-demo";
const ROGELIO = PEOPLE.rogelio;

/** The entry over the adapter's harness, with the real producer of the installer queue over a recording sender. */
async function entry(options: Parameters<typeof inboundHarness>[0] = {}) {
  const h = await inboundHarness(options);
  const sender = recordingSender();
  const { logger, lines } = captureLogger();
  const queue = recordingSink(h.world.connector, sender);
  const deps = { ...h.deps, queue, logger };
  const handler = createInboundWhatsAppHandler(() => deps, () => logger);
  return { h, sender, lines, deps, handler };
}

describe("InboundWhatsApp entry: the number first [FL-095]", () => {
  it("[FL-095] an event of another number succeeds without effects and leaves only the probe and the metric", async () => {
    const e = await entry();
    const result = await e.handler(liveEvent({ contextMetaId: FOREIGN_META_ID, messageId: "b1b2c3d4-0000-4000-8000-000000000095", messages: [waText(ROGELIO.phone, "wamid.F1", "hola")] }));
    expect(result.records).toEqual([{ verdict: "FOREIGN", reason: "ENVELOPE_NUMBER", messages: [], statuses: [] }]);
    expect(await e.h.world.connector.worlds.getProbe(foreignProbeId("b1b2c3d4-0000-4000-8000-000000000095"))).toBeDefined();
    expect(e.h.rec.metrics).toEqual([{ metric: "ForeignPhoneNumberEvents", dimensions: { metaPhoneNumberId: "9876" } }]);
    expect(await e.h.world.connector.conversations.findMessageByProviderId("wamid.F1")).toBeUndefined();
    expect(e.sender.messages).toEqual([]);
    expect(e.lines.join("\n")).not.toContain("hola");
  });

  it("[FL-095] a QaDriver event marked qa-foreign=1 is foreign even with our number", async () => {
    const e = await entry();
    const result = await e.handler(liveEvent({ attributes: { "qa-foreign": "1" }, messageId: "b1b2c3d4-0000-4000-8000-000000000096", messages: [waText(ROGELIO.phone, "wamid.F2", "hola")] }));
    expect(result.records[0]).toMatchObject({ verdict: "FOREIGN", reason: "QA_FOREIGN" });
    expect(await e.h.world.connector.worlds.getProbe(foreignProbeId("b1b2c3d4-0000-4000-8000-000000000096"))).toBeDefined();
    expect(e.sender.messages).toEqual([]);
  });

  it("acknowledges what is not an SNS event, and a record with a bad signature, without throwing", async () => {
    const e = await entry();
    expect(await e.handler({ hello: "world" })).toEqual({ records: [] });
    const tampered = liveEvent({ messages: [waText(ROGELIO.phone, "wamid.T1", "hola")] });
    const record = tampered.Records[0];
    if (record === undefined) throw new Error("fixture without a record");
    tampered.Records[0] = { ...record, Sns: { ...record.Sns, Message: record.Sns.Message.replace("hola", "adiós") } };
    expect(await e.handler(tampered)).toEqual({ records: [{ verdict: "REJECT", reason: "BAD_SIGNATURE", messages: [], statuses: [] }] });
  });
});

describe("InboundWhatsApp entry: the installer queue and the read receipt [FL-102]", () => {
  it("[FL-102] an installer's message goes on the installer's group, with the world busy first, then it is marked read", async () => {
    const e = await entry();
    const result = await e.handler(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.R1", "La ONU no enciende")] }));
    expect(result.records[0]?.messages).toEqual(["QUEUED"]);
    const eventId = inboundEventId(DEMO, "wamid.R1");
    expect(e.sender.messages).toEqual([{ body: expect.any(String), groupId: ROGELIO.personId, deduplicationId: eventId }]);
    expect(queuedBodies(e.sender)[0]).toMatchObject({ type: "INBOUND_MESSAGE", eventId, clockId: DEMO, installerId: ROGELIO.personId, message: { messageId: "wamid.R1" } });
    expect((await e.h.world.connector.worlds.getInstallerState(ROGELIO.personId))?.inFlight).toEqual([eventId]);
    expect(await e.h.world.connector.conversations.findMessageByProviderId("wamid.R1")).toMatchObject({ direction: "IN", status: "READ" });
    expect(e.h.rec.sent).toEqual([expect.objectContaining({ status: "read", message_id: "wamid.R1" })]);
  });

  it("[FL-102] with KILL#ALL the message is still queued but never marked read", async () => {
    const e = await entry();
    await e.h.kill.write(killSwitchKey("ALL"), { scope: "ALL", state: "on", setBy: "OPERATOR", setAtReal: "2026-10-13T15:00:00.000Z" });
    await e.handler(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.R2", "¿sigo?")] }));
    expect(e.sender.messages).toHaveLength(1);
    expect(e.h.rec.sent).toEqual([]);
    expect(await e.h.world.connector.conversations.findMessageByProviderId("wamid.R2")).toMatchObject({ status: "RECEIVED" });
  });

  it("[FL-002] ALTA gets its fixed reply and the consent, without the queue", async () => {
    const e = await entry();
    const result = await e.handler(liveEvent({ messages: [waText(PEOPLE.julian.phone, "wamid.A1", "ALTA")] }));
    expect(result.records[0]?.messages).toEqual(["KEYWORD"]);
    expect(e.h.rec.actions.map((action) => action.name)).toEqual(["recordConsent"]);
    expect(e.h.rec.notices.map((notice) => notice.notice)).toEqual(["welcome"]);
    expect(e.sender.messages).toEqual([]);
  });

  it("[FL-004] a number outside the allow list never reaches the queue; in a simulated world it gets one fixed reply a day", async () => {
    const e = await entry();
    const first = await e.handler(simEvent(GUEST, UNKNOWN_PHONE, "wamid.SIM.U1", { type: "text", body: "hola" }));
    const second = await e.handler(simEvent(GUEST, UNKNOWN_PHONE, "wamid.SIM.U2", { type: "text", body: "¿hola?" }));
    expect([...first.records, ...second.records].flatMap((record) => record.messages)).toEqual(["UNKNOWN_SENDER", "UNKNOWN_SENDER"]);
    expect(e.h.rec.notices.map((notice) => notice.notice)).toEqual(["unknownNumber"]);
    expect(e.sender.messages).toEqual([]);
  });
});

describe("InboundWhatsApp entry: redelivery", () => {
  it("throws when a record that may be ours failed, so SNS delivers it again; the redelivery processes it once", async () => {
    const e = await entry();
    e.sender.failNext();
    const event = liveEvent({ messages: [waText(ROGELIO.phone, "wamid.R3", "ya llegué")] });
    await expect(e.handler(event)).rejects.toBeInstanceOf(InboundRetryError);
    expect((await e.h.world.connector.worlds.getInstallerState(ROGELIO.personId))?.inFlight ?? []).toEqual([]);
    expect((await e.handler(event)).records[0]?.messages).toEqual(["QUEUED"]);
    expect((await e.handler(event)).records[0]?.messages).toEqual(["DUPLICATE"]);
    expect(e.sender.messages).toHaveLength(1);
  });

  it("[FL-002] a fixed reply the pipeline could not send makes the event come back; the redelivery records ALTA once", async () => {
    const e = await entry();
    let failures = 1;
    const notices = { send: async (request: Parameters<typeof e.deps.notices.send>[0]) => (failures-- > 0 ? Promise.reject(new Error("pipeline unavailable")) : e.deps.notices.send(request)) };
    const handler = createInboundWhatsAppHandler(() => ({ ...e.deps, notices }), () => e.deps.logger);
    const alta = liveEvent({ messages: [waText(PEOPLE.julian.phone, "wamid.A2", "ALTA")] });
    await expect(handler(alta)).rejects.toBeInstanceOf(InboundRetryError);
    expect((await handler(alta)).records[0]?.messages).toEqual(["KEYWORD"]);
    expect(e.h.rec.notices.map((notice) => notice.notice)).toEqual(["welcome"]);
  });
});
