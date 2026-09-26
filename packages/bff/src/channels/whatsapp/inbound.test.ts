import { describe, expect, it } from "vitest";
import type { Message } from "../../domain/conversations";
import { processInboundEvent } from "./inbound";
import {
  DEMO,
  JPEG,
  JUDGE,
  OGG,
  PEOPLE,
  UNKNOWN_PHONE,
  hashOf,
  inboundHarness,
  liveEvent,
  nonceFor,
  simEvent,
  simUpload,
  waAudio,
  waButton,
  waImage,
  waReply,
  waText,
} from "./testing";

const ROGELIO = PEOPLE.rogelio;
const ROGELIO_J07 = PEOPLE.rogelioJ07;

/** What the channel stored of a message, without what only the transport changes. */
function essence(message: Message | undefined) {
  if (message === undefined) return undefined;
  return { direction: message.direction, content: message.content, text: message.text, buttonAction: message.buttonAction, mediaKind: message.media?.kind, mime: message.media?.mime, status: message.status };
}

async function outcomes(result: Awaited<ReturnType<typeof processInboundEvent>>) {
  return result.records.flatMap((record) => record.messages);
}

describe("inbound message with the real shape of End User Messaging Social", () => {
  it("[FL-091] text, button, interactive reply, voice note and photo end exactly as the same content from the simulator", async () => {
    const live = await inboundHarness();
    const sim = await inboundHarness();
    const liveButton = await nonceFor(live, "rogelio", "CHOOSE_ITEM", { kind: "ITEM", id: "ROSETTE_PHOTO" });
    const simButton = await nonceFor(sim, "rogelioJ07", "CHOOSE_ITEM", { kind: "ITEM", id: "ROSETTE_PHOTO" });
    const liveReply = await nonceFor(live, "rogelio", "NO_THANKS", { kind: "MESSAGE", id: "wamid.OUT1" });
    const simReply = await nonceFor(sim, "rogelioJ07", "NO_THANKS", { kind: "MESSAGE", id: "wamid.OUT1" });
    await simUpload(sim, "up-voice-01", "VOICE", OGG(), "audio/ogg");
    await simUpload(sim, "up-photo-01", "PHOTO", JPEG(), "image/jpeg");

    const liveMessages = [
      waText(ROGELIO.phone, "wamid.L1", "La ONU no prende, llámame al 5512345678"),
      waButton(ROGELIO.phone, "wamid.L2", liveButton, "Roseta instalada"),
      waReply(ROGELIO.phone, "wamid.L3", liveReply, "No, gracias"),
      waAudio(ROGELIO.phone, "wamid.L4"),
      waImage(ROGELIO.phone, "wamid.L5"),
    ];
    const simContents = [
      { type: "text", body: "La ONU no prende, llámame al 5512345678" },
      { type: "button", payload: simButton, text: "Roseta instalada" },
      { type: "button_reply", id: simReply, title: "No, gracias" },
      { type: "voice", uploadId: "up-voice-01", mimeType: "audio/ogg" },
      { type: "photo", uploadId: "up-photo-01", mimeType: "image/jpeg" },
    ] as const;

    for (const [index, message] of liveMessages.entries()) {
      const liveResult = await processInboundEvent(liveEvent({ messages: [message] }), live.deps);
      const simResult = await processInboundEvent(simEvent(JUDGE, ROGELIO_J07.phone, `wamid.SIM.S${index}`, simContents[index] ?? { type: "text", body: "" }), sim.deps);
      expect(await outcomes(liveResult)).toEqual(await outcomes(simResult));
      expect(await outcomes(liveResult)).toEqual([index === 1 || index === 2 ? "BUTTON" : "QUEUED"]);
      const [liveStored] = await live.world.connector.conversations.listMessages(ROGELIO.personId, { descending: true, limit: 1 });
      const [simStored] = await sim.world.connector.conversations.listMessages(ROGELIO_J07.personId, { descending: true, limit: 1 });
      expect(essence(liveStored)).toEqual(essence(simStored));
      expect(liveStored).toMatchObject({ transport: "live", simulated: false, clockId: DEMO });
      expect(simStored).toMatchObject({ transport: "simulated", simulated: true, clockId: JUDGE });
    }
    const [first] = await live.world.connector.conversations.listMessages(ROGELIO.personId, { limit: 1 });
    expect(first?.text).toContain("[TELEFONO]");
    expect(first?.text).not.toContain("5512345678");
    expect(live.rec.queued.map((event) => event.type)).toEqual(["INBOUND_MESSAGE", "INBOUND_MESSAGE", "INBOUND_MESSAGE", "INBOUND_MESSAGE", "INBOUND_MESSAGE"]);
    expect(live.rec.queued.every((event) => event.installerId === ROGELIO.personId && event.clockId === DEMO)).toBe(true);
    expect(sim.rec.queued.every((event) => event.installerId === ROGELIO_J07.personId && event.clockId === JUDGE)).toBe(true);
  });

  it("[FL-091] a live phone enters its world by its lease first, otherwise by the live world", async () => {
    const h = await inboundHarness();
    const code = await h.world.connector.worlds.createJoinCode({ code: "J07-4F2K", clockId: JUDGE, personId: ROGELIO_J07.personId, userId: "usr-judge-07" });
    const judgePhone = "+12025550101";
    await h.world.connector.worlds.bindPhoneLease(code.code, hashOf(judgePhone));
    await processInboundEvent(liveEvent({ messages: [waText(judgePhone, "wamid.J1", "Hola, ya llegué")] }), h.deps);
    await processInboundEvent(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.D1", "Hola, ya llegué")] }), h.deps);
    expect(h.rec.queued.map((event) => [event.clockId, event.installerId])).toEqual([
      [JUDGE, ROGELIO_J07.personId],
      [DEMO, ROGELIO.personId],
    ]);
    const lease = await h.world.connector.worlds.getPhoneLease(hashOf(judgePhone));
    expect(lease?.lastInboundAtReal).toBe("2026-10-13T15:20:00.000Z");
  });
});

describe("who gets past the channel", () => {
  it("[FL-003] staff of the allow list without opt-in: the message is kept, a fixed notice, no turn and DENY CP-OPTIN", async () => {
    const h = await inboundHarness();
    const result = await processInboundEvent(liveEvent({ messages: [waText(PEOPLE.julian.phone, "wamid.J1", "Hola, ¿qué órdenes tengo?")] }), h.deps);
    expect(await outcomes(result)).toEqual(["NO_CONSENT"]);
    expect(h.rec.queued).toEqual([]);
    expect(h.rec.notices).toMatchObject([{ notice: "optInRequired", text: "Para activar Cuadrilla envía ALTA.", recipient: { personId: PEOPLE.julian.personId }, replyToWamid: "wamid.J1" }]);
    expect(await h.world.connector.conversations.listMessages(PEOPLE.julian.personId)).toHaveLength(1);
    const denials = await h.world.connector.audit.listByDecision("isp-demo", "DENY");
    expect(denials).toMatchObject([{ action: "AGENT_TURN", ruleIds: ["CP-OPTIN"], trigger: "INSTALLER_MESSAGE" }]);
  });

  it("[FL-003] someone who opted out gets nothing back and no turn (CP-OPTOUT)", async () => {
    const h = await inboundHarness();
    await processInboundEvent(liveEvent({ messages: [waText(PEOPLE.ernesto.phone, "wamid.E1", "¿Tengo órdenes?")] }), h.deps);
    expect(h.rec.notices).toEqual([]);
    expect(h.rec.queued).toEqual([]);
    expect(await h.world.connector.audit.listByDecision("isp-demo", "DENY")).toMatchObject([{ ruleIds: ["CP-OPTOUT"] }]);
  });

  it("[FL-004] simulated unknown number: one fixed reply per number and simulated day, no turn, no body kept", async () => {
    const h = await inboundHarness();
    const unknownJ07 = "+525502079999";
    await processInboundEvent(simEvent(JUDGE, unknownJ07, "wamid.SIM.U1", { type: "text", body: "Mi CURP es de prueba" }), h.deps);
    await processInboundEvent(simEvent(JUDGE, unknownJ07, "wamid.SIM.U2", { type: "text", body: "¿Hola?" }), h.deps);
    expect(h.rec.notices).toMatchObject([{ notice: "unknownNumber", text: "Este número es de uso interno de la operadora.", recipient: { phoneHash: hashOf(unknownJ07) } }]);
    expect(h.rec.notices[0]?.recipient.personId).toBeUndefined();
    expect(h.rec.queued).toEqual([]);
    const denials = await h.world.connector.audit.listByDecision("isp-judge-07", "DENY");
    expect(denials).toHaveLength(2);
    expect(denials[0]).toMatchObject({ action: "UNKNOWN_SENDER", ruleIds: ["CP-ALLOWLIST"], detail: { phoneHash: hashOf(unknownJ07), replied: true } });
    expect(JSON.stringify(denials)).not.toContain("CURP");
    const clock = await h.world.connector.runtime.getClock(JUDGE);
    await h.world.connector.runtime.updateClock(JUDGE, { pausedSimNow: "2026-10-14T08:00:00-06:00" }, clock?.version ?? 0);
    await processInboundEvent(simEvent(JUDGE, unknownJ07, "wamid.SIM.U3", { type: "text", body: "Hola de nuevo" }), h.deps);
    expect(h.rec.notices).toHaveLength(2);
  });

  it("[FL-004] live unknown numbers: at most one reply per number and 20 a day for the stage, with UnknownSenderReplies; no media fetched", async () => {
    const h = await inboundHarness();
    for (let n = 0; n < 22; n += 1) {
      const phone = `+120255501${String(n).padStart(2, "0")}`;
      await processInboundEvent(liveEvent({ messages: [waText(phone, `wamid.U${n}`, "hola")] }), h.deps);
    }
    await processInboundEvent(liveEvent({ messages: [waText("+12025550100", "wamid.U-again", "hola otra vez")] }), h.deps);
    await processInboundEvent(liveEvent({ messages: [waAudio(UNKNOWN_PHONE, "wamid.U-voice")] }), h.deps);
    expect(h.rec.notices).toHaveLength(20);
    expect(h.rec.notices.every((notice) => notice.recipient.transport === "live" && notice.clockId === DEMO)).toBe(true);
    expect(h.rec.metrics.filter((point) => point.metric === "UnknownSenderReplies")).toHaveLength(20);
    expect(h.rec.media).toEqual([]);
    expect(h.rec.queued).toEqual([]);
  });

  it("[FL-004] an inactive person is outside the allow list", async () => {
    const h = await inboundHarness();
    await h.world.connector.people.setActive(ROGELIO.personId, false, { actor: "SYSTEM" });
    const result = await processInboundEvent(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.X1", "hola")] }), h.deps);
    expect(await outcomes(result)).toEqual(["UNKNOWN_SENDER"]);
    expect(await h.world.connector.conversations.listMessages(ROGELIO.personId)).toEqual([]);
  });

  it("[FL-093] the same wamid twice (SNS redelivery or a simulator retry): one message, one queued event", async () => {
    const h = await inboundHarness();
    const event = liveEvent({ messages: [waText(ROGELIO.phone, "wamid.DUP", "Ya limpié el conector")] });
    expect(await outcomes(await processInboundEvent(event, h.deps))).toEqual(["QUEUED"]);
    expect(await outcomes(await processInboundEvent(event, h.deps))).toEqual(["DUPLICATE"]);
    const sim = simEvent(JUDGE, ROGELIO_J07.phone, "wamid.SIM.DUP", { type: "text", body: "Ya limpié el conector" });
    await processInboundEvent(sim, h.deps);
    expect(await outcomes(await processInboundEvent(sim, h.deps))).toEqual(["DUPLICATE"]);
    expect(await h.world.connector.conversations.listMessages(ROGELIO.personId)).toHaveLength(1);
    expect(h.rec.queued).toHaveLength(2);
    expect(new Set(h.rec.queued.map((event) => event.eventId)).size).toBe(2);
  });

  it("[FL-093] a failing dependency marks the event for SNS to retry and does not stop the other messages", async () => {
    const h = await inboundHarness();
    let calls = 0;
    const deps = { ...h.deps, queue: { enqueue: async () => ((calls += 1), calls === 1 ? Promise.reject(new Error("SQS unavailable")) : undefined) } };
    const result = await processInboundEvent(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.F1", "uno"), waText(ROGELIO.phone, "wamid.F2", "dos")] }), deps);
    expect(result.records[0]?.messages).toEqual(["FAILED", "QUEUED"]);
    expect(result.retry).toBe(true);
  });

  it("[FL-093] the redelivery of a message whose processing failed after the claim runs it once: one Message IN, one queued event, the read receipt", async () => {
    const h = await inboundHarness();
    const event = liveEvent({ messages: [waText(ROGELIO.phone, "wamid.F1", "uno")] });
    const throttled = { ...h.deps, queue: { enqueue: async () => Promise.reject(new Error("SQS throttled")) } };
    expect(await processInboundEvent(event, throttled)).toMatchObject({ records: [{ messages: ["FAILED"] }], retry: true });
    expect(h.rec.queued).toEqual([]);
    expect(await processInboundEvent(event, h.deps)).toMatchObject({ records: [{ messages: ["QUEUED"] }], retry: false });
    expect(h.rec.queued).toMatchObject([{ type: "INBOUND_MESSAGE", installerId: ROGELIO.personId, message: { messageId: "wamid.F1" } }]);
    const stored = await h.world.connector.conversations.listMessages(ROGELIO.personId);
    expect(stored.map((message) => [message.messageId, message.direction, message.status])).toEqual([["wamid.F1", "IN", "READ"]]);
    expect(await outcomes(await processInboundEvent(event, h.deps))).toEqual(["DUPLICATE"]);
    expect(h.rec.queued).toHaveLength(1);
  });

  it("[FL-093] a failed ALTA is recorded on the redelivery", async () => {
    const h = await inboundHarness();
    const alta = liveEvent({ messages: [waText(PEOPLE.julian.phone, "wamid.A1", "ALTA")] });
    const down = { ...h.deps, actions: { ...h.deps.actions, recordConsent: async () => Promise.reject(new Error("People throttled")) } };
    expect(await outcomes(await processInboundEvent(alta, down))).toEqual(["FAILED"]);
    expect(await outcomes(await processInboundEvent(alta, h.deps))).toEqual(["KEYWORD"]);
    expect(h.rec.actions).toMatchObject([{ name: "recordConsent", input: { personId: PEOPLE.julian.personId, sourceMessageId: "wamid.A1" } }]);
    expect(await h.world.connector.conversations.listMessages(PEOPLE.julian.personId)).toHaveLength(1);
  });

  it("[FL-098] over the world's messages per hour: DENY RATE_LIMIT, nothing kept and no turn; BAJA still works", async () => {
    const h = await inboundHarness();
    await h.world.connector.isps.updateSettings("isp-demo", { rateLimitPerHour: 2 });
    for (const n of [1, 2, 3]) await processInboundEvent(liveEvent({ messages: [waText(ROGELIO.phone, `wamid.RL${n}`, "¿Sigues ahí?")] }), h.deps);
    expect(h.rec.queued).toHaveLength(2);
    expect(await h.world.connector.conversations.listMessages(ROGELIO.personId)).toHaveLength(2);
    expect(await h.world.connector.audit.listByDecision("isp-demo", "DENY")).toMatchObject([{ action: "INBOUND_MESSAGE", reason: "RATE_LIMIT", messageId: "wamid.RL3", detail: { limit: 2 } }]);
    expect(await outcomes(await processInboundEvent(liveEvent({ messages: [waText(ROGELIO.phone, "wamid.RL4", "BAJA")] }), h.deps))).toEqual(["KEYWORD"]);
  });

  it("[FL-091] a status of what we sent never becomes an inbound message", async () => {
    const h = await inboundHarness();
    const result = await processInboundEvent(liveEvent({ statuses: [{ id: "wamid.unknown", status: "delivered", timestamp: "1792077600" }] }), h.deps);
    expect(result.records).toEqual([{ verdict: "ACCEPT", messages: [], statuses: ["UNKNOWN_MESSAGE"] }]);
    expect(h.rec.queued).toEqual([]);
  });
});
