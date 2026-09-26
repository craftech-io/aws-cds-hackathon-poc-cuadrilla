import { describe, expect, it } from "vitest";
import { ChannelError } from "@cuadrilla/shared";
import { sendFailure } from "../adapter";
import { createChannelRegistry, whatsAppRouteOf } from "../registry";
import { testConnector } from "../../connector/testing";
import { renderTemplateBody } from "../../copy/templates";
import { SIMULATED_ORIGINATION_ID, phoneNumberArn } from "./config";
import { applyStatuses } from "./events";
import { EumEnvelope, WebhookEntry, parseJson } from "./payloads";
import { displayOf, renderTemplate, renderText } from "./render";
import { buildSimulatedEvent, qaWamid, simulatorWamid, verifySimulatedEnvelope } from "./sim-envelope";
import { createSimulatedTransport } from "./simulated";
import { DEMO, JUDGE, PEOPLE, REAL_NOW, SIM_KEY, fakeFallback, hashOf, quietLogger, recorder, seedWorlds } from "./testing";
import { worldModeReader } from "./ports";
import type { WhatsAppChannelTransport } from "./transport";

async function setup() {
  const w = testConnector(REAL_NOW);
  await seedWorlds(w);
  const rec = recorder();
  let sequence = 0;
  const transport = createSimulatedTransport({
    conversations: w.connector.conversations,
    isps: w.connector.isps,
    applyStatuses: (statuses) => applyStatuses(statuses, { conversations: w.connector.conversations, runtime: w.connector.runtime, audit: w.connector.audit, metrics: { count: () => undefined }, fallback: fakeFallback(rec), logger: quietLogger() }),
    realClock: { now: async () => w.now() },
    newId: () => `01J9ZQX00000000000000000${String((sequence += 1)).padStart(2, "0")}`,
  });
  return { w, transport };
}

async function queued(w: ReturnType<typeof testConnector>, messageId: string) {
  const person = PEOPLE.rogelioJ07;
  const message = await w.connector.conversations.appendMessage({
    messageId,
    personId: person.personId,
    ispId: "isp-judge-07",
    clockId: JUDGE,
    direction: "OUT",
    channel: "WHATSAPP",
    content: "TEXT",
    kind: "REPLY",
    status: "QUEUED",
    author: "AGENT",
    simulated: true,
    transport: "simulated",
    sentAtSim: "2026-10-13T09:21:00-06:00",
  });
  return { personId: message.personId, sentAtSim: message.sentAtSim, messageId };
}

const TO = PEOPLE.rogelioJ07.phone;

describe("simulated transport", () => {
  it("[FL-082] validates the same Cloud API JSON as the live one before anything is recorded", async () => {
    const { w, transport } = await setup();
    const ref = await queued(w, "msg-sim-0001");
    const invalid = { ...renderText(TO, "Hola"), text: { preview_url: true, body: "Hola" } } as unknown as ReturnType<typeof renderText>;
    await expect(transport.send({ message: ref, clockId: JUDGE, ispId: "isp-judge-07", payload: invalid })).resolves.toEqual({ ok: false, code: "INVALID", reason: "PAYLOAD_INVALID", retryable: false });
    expect((await w.connector.conversations.getMessage(ref))?.status).toBe("QUEUED");
  });

  it("[FL-082] records the payload and emits sent at once and delivered one second later, through the status handler", async () => {
    const { w, transport } = await setup();
    const ref = await queued(w, "msg-sim-0002");
    const payload = renderText(TO, "Limpia el conector de la roseta (§DIAG-02).");
    const result = await transport.send({ message: ref, clockId: JUDGE, ispId: "isp-judge-07", payload });
    expect(result).toEqual({ ok: true, providerMessageId: "wamid.SIM.01J9ZQX0000000000000000001", payload });
    const { to: _to, ...withoutRecipient } = payload;
    const stored = await w.connector.conversations.getMessage(ref);
    expect(stored).toMatchObject({ status: "DELIVERED", providerMessageId: "wamid.SIM.01J9ZQX0000000000000000001", refs: { whatsapp: withoutRecipient } });
    expect(stored?.refs?.whatsapp).not.toHaveProperty("to");
    const events = await w.connector.conversations.listMessageEvents(PEOPLE.rogelioJ07.personId, "msg-sim-0002");
    expect(events.map((event) => [event.status, event.atReal, event.pricing?.category])).toEqual([
      ["SENT", REAL_NOW, "service"],
      ["DELIVERED", "2026-10-13T15:20:01.000Z", "service"],
    ]);
  });

  it("[FL-082] marks the thread read when the simulator opens it", async () => {
    const { w, transport } = await setup();
    for (const id of ["msg-sim-0003", "msg-sim-0004"]) await transport.send({ message: await queued(w, id), clockId: JUDGE, ispId: "isp-judge-07", payload: renderText(TO, "Hola") });
    expect(await transport.markThreadRead(PEOPLE.rogelioJ07.personId)).toBe(2);
    const messages = await w.connector.conversations.listMessages(PEOPLE.rogelioJ07.personId);
    expect(messages.map((message) => message.status)).toEqual(["READ", "READ"]);
    expect(await transport.markThreadRead(PEOPLE.rogelioJ07.personId)).toBe(0);
  });

  it("[FL-082] a template leaves only when the world's simulated state approves it (plan B is testable), rendered as WhatsApp draws it", async () => {
    const { w, transport } = await setup();
    const payload = renderTemplate(TO, { name: "ordenes_del_dia", params: ["Rogelio", "3", "09:00 a 11:00"], buttonNonces: ["nonce-view"] });
    await w.connector.isps.setTemplateStatus("isp-judge-07", "ordenes_del_dia", "REJECTED", { actor: "QA" });
    const refused = await transport.send({ message: await queued(w, "msg-sim-0005"), clockId: JUDGE, ispId: "isp-judge-07", payload });
    expect(refused).toEqual({ ok: false, code: "POLICY_DENIED", reason: "TEMPLATE_NOT_APPROVED", retryable: false });
    await w.connector.isps.setTemplateStatus("isp-judge-07", "ordenes_del_dia", "APPROVED", { actor: "QA" });
    await transport.send({ message: await queued(w, "msg-sim-0006"), clockId: JUDGE, ispId: "isp-judge-07", payload });
    expect(displayOf(payload)).toEqual({ text: renderTemplateBody("ordenes_del_dia", ["Rogelio", "3", "09:00 a 11:00"]), buttons: ["Ver órdenes"] });
  });
});

describe("transport per recipient, through channels/registry.ts", () => {
  const TEAM_PHONE = "+12025550143";
  const EMAIL = { channel: "EMAIL" as const, transport: "live" as const, send: async () => ({ ok: true }) };

  it("[FL-082] a synthetic identity gets the simulated transport, also in the live world with live in the stage; a real phone only in its own world", async () => {
    const { w, transport } = await setup();
    const live: WhatsAppChannelTransport = { channel: "WHATSAPP", transport: "live", send: async () => sendFailure("UNAVAILABLE", "NOT_USED") };
    const registry = createChannelRegistry({ modes: { email: "live", whatsapp: { transports: ["simulated", "live"] } }, factories: { whatsapp: { simulated: () => transport, live: () => live }, email: () => EMAIL } });
    const mode = worldModeReader(w.connector);
    const routeFor = async (clockId: string, phone: string) =>
      whatsAppRouteOf({ clockId, phone, worldMode: (await mode(clockId)) ?? "simulated", lease: await w.connector.worlds.getPhoneLease(hashOf(phone)), registeredRealPhones: new Set([TEAM_PHONE]) });
    expect(registry.whatsapp(await routeFor(DEMO, PEOPLE.rogelio.phone))).toBe(transport);
    expect(registry.whatsapp(await routeFor(JUDGE, PEOPLE.rogelioJ07.phone))).toBe(transport);
    expect(registry.whatsapp(await routeFor(DEMO, TEAM_PHONE))).toBe(live);
    const judgePhone = "+12025550111";
    const code = await w.connector.worlds.createJoinCode({ code: "J07-2ABC", clockId: JUDGE, personId: PEOPLE.rogelioJ07.personId, userId: "usr-judge-07" });
    await w.connector.worlds.bindPhoneLease(code.code, hashOf(judgePhone));
    expect(registry.whatsapp(await routeFor(JUDGE, judgePhone))).toBe(live);
    expect(registry.whatsapp(await routeFor(DEMO, judgePhone))).toBe(transport);
  });

  it("[FL-082] before P-01 the stage builds only the simulated transport and refuses a live route", async () => {
    const { transport } = await setup();
    let builtLive = false;
    const registry = createChannelRegistry({
      modes: { email: "live", whatsapp: { transports: ["simulated"] } },
      factories: { whatsapp: { simulated: () => transport, live: () => ((builtLive = true), transport) }, email: () => EMAIL },
    });
    expect(registry.whatsapp({ transport: "simulated", source: "SYNTHETIC_PHONE" })).toBe(transport);
    expect(() => registry.whatsapp({ transport: "live", source: "PHONE_LEASE" })).toThrow(ChannelError);
    expect(builtLive).toBe(false);
  });
});

describe("the simulator's envelope", () => {
  it("[FL-082] is the live envelope with sim-<clockId>, the fictitious AWS id and the world's HMAC", () => {
    const event = buildSimulatedEvent({ clockId: JUDGE, from: TO, wamid: simulatorWamid("01J9ZQX0000000000000000042"), content: { type: "text", body: "hola" }, sentAtReal: new Date(REAL_NOW) }, SIM_KEY);
    const record = event.Records[0];
    if (record === undefined) throw new Error("no record");
    const envelope = EumEnvelope.parse(parseJson(record.Sns.Message));
    expect(envelope.context.MetaPhoneNumberIds).toEqual([{ metaPhoneNumberId: `sim-${JUDGE}`, arn: phoneNumberArn(SIMULATED_ORIGINATION_ID) }]);
    const entry = WebhookEntry.parse(parseJson(envelope.whatsAppWebhookEntry));
    expect(entry.changes[0]?.value.messages?.[0]).toMatchObject({ from: "525502070001", id: "wamid.SIM.01J9ZQX0000000000000000042", type: "text" });
    expect(verifySimulatedEnvelope(record.Sns, SIM_KEY)).toBe(JUDGE);
    expect(qaWamid("812-1/sc-02/3")).toBe(qaWamid("812-1/sc-02/3"));
    expect(qaWamid("812-1/sc-02/3")).toMatch(/^wamid\.SIM\.[0-9a-f]{64}$/);
  });
});
