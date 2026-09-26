import { describe, expect, it } from "vitest";
import { setKillSwitch } from "../../ops/kill-switch";
import { acknowledgeInbound } from "./ack";
import { processInboundEvent } from "./inbound";
import { renderReadAck } from "./render";
import { GUEST, PEOPLE, UNKNOWN_PHONE, inboundHarness, liveEvent, quietLogger, simEvent, waText } from "./testing";

const ROGELIO = PEOPLE.rogelio;

describe("read receipt with the typing indicator", () => {
  it("[FL-102] live: the message is queued, then marked read with typing_indicator through SendWhatsAppMessage", async () => {
    const h = await inboundHarness();
    const order: string[] = [];
    const social = h.deps.social;
    if (social === undefined) throw new Error("the harness has a live client");
    const deps = {
      ...h.deps,
      queue: { enqueue: async () => void order.push("enqueue") },
      social: { ...social, send: async (payload: Parameters<typeof social.send>[0]) => (order.push("receipt"), social.send(payload)) },
    };
    await processInboundEvent(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.R1", "La ONU no prende la luz PON")] }), deps);
    expect(order).toEqual(["enqueue", "receipt"]);
    expect(h.rec.sent).toEqual([{ messaging_product: "whatsapp", status: "read", message_id: "wamid.R1", typing_indicator: { type: "text" } }]);
    const [stored] = await h.world.connector.conversations.listMessages(ROGELIO.personId);
    expect(stored?.status).toBe("READ");
    expect(await h.world.connector.conversations.listMessageEvents(ROGELIO.personId, "wamid.R1")).toMatchObject([{ status: "READ" }]);
  });

  it("[FL-102] simulated: the simulator draws it from the READ status, nothing goes to End User Messaging Social", async () => {
    const h = await inboundHarness();
    await processInboundEvent(simEvent(GUEST, PEOPLE.rogelioG07.phone, "wamid.SIM.R2", { type: "text", body: "Ya llegué" }), h.deps);
    const [stored] = await h.world.connector.conversations.listMessages(PEOPLE.rogelioG07.personId);
    expect(stored?.status).toBe("READ");
    expect(h.rec.sent).toEqual([]);
  });

  it("[FL-102] never to an unknown number, and not while KILL#ALL is on (the message is still queued for the safety check)", async () => {
    const h = await inboundHarness();
    await processInboundEvent(liveEvent({ messages: [waText(UNKNOWN_PHONE, "wamid.R3", "hola")] }), h.deps);
    expect(h.rec.sent).toEqual([]);
    await setKillSwitch({ store: h.kill, realClock: { now: async () => h.world.now() } }, { scope: "ALL", on: true, actor: "OPERATOR" });
    await processInboundEvent(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.R4", "hay un cable pelado")] }), h.deps);
    expect(h.rec.sent).toEqual([]);
    expect(h.rec.queued).toMatchObject([{ type: "INBOUND_MESSAGE", installerId: ROGELIO.personId }]);
    const [stored] = await h.world.connector.conversations.listMessages(ROGELIO.personId);
    expect(stored?.status).toBe("RECEIVED");
  });

  it("[FL-102] is not a message: no content policy (no notice), and a failed receipt never fails the inbound message", async () => {
    const h = await inboundHarness();
    const social = h.deps.social;
    if (social === undefined) throw new Error("the harness has a live client");
    const failing = { ...h.deps, social: { ...social, send: async () => Promise.reject(new Error("throttled")) } };
    const result = await processInboundEvent(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.R5", "¿qué sigue?")] }), failing);
    expect(result.records[0]?.messages).toEqual(["QUEUED"]);
    expect(h.rec.notices).toEqual([]);
    const [stored] = await h.world.connector.conversations.listMessages(ROGELIO.personId);
    expect(stored?.status).toBe("RECEIVED");
    expect(renderReadAck("wamid.R5")).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.R5", typing_indicator: { type: "text" } });
    expect(await acknowledgeInbound({ message: undefined, transport: "live", kill: { all: false, simulator: false, agent: false } }, { conversations: h.world.connector.conversations, logger: quietLogger() })).toBe("SKIPPED_UNKNOWN");
  });
});
