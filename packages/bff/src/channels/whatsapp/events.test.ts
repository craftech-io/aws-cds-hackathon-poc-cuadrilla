import { describe, expect, it } from "vitest";
import type { MessageKind } from "@cuadrilla/shared";
import { testConnector } from "../../connector/testing";
import { type StatusDeps, applyStatuses, isForward, recordLiveInbound } from "./events";
import { resolveSender } from "./identity";
import { processInboundEvent } from "./inbound";
import { DEMO, GUEST, PEOPLE, PHONE_KEY, REAL_NOW, fakeFallback, hashOf, inboundHarness, liveEvent, quietLogger, recorder, seedWorlds, waIdOf, waText } from "./testing";

const T = (iso: string): string => String(Math.floor(Date.parse(iso) / 1000));

async function setup() {
  const w = testConnector(REAL_NOW);
  await seedWorlds(w);
  const rec = recorder();
  const deps: StatusDeps = {
    conversations: w.connector.conversations,
    runtime: w.connector.runtime,
    audit: w.connector.audit,
    metrics: { count: (metric, dimensions = {}) => void rec.metrics.push({ metric, dimensions }) },
    fallback: fakeFallback(rec),
    logger: quietLogger(),
  };
  return { w, rec, deps };
}

async function sent(w: ReturnType<typeof testConnector>, providerMessageId: string, kind: MessageKind, template = false) {
  return w.connector.conversations.appendMessage({
    messageId: `msg-${providerMessageId.replace(/\W/g, "")}`,
    personId: PEOPLE.rogelio.personId,
    ispId: "isp-demo",
    clockId: DEMO,
    direction: "OUT",
    channel: "WHATSAPP",
    content: template ? "TEMPLATE" : "TEXT",
    kind,
    ...(template ? { templateName: "ordenes_del_dia" as const } : {}),
    status: "SENT",
    author: "SYSTEM",
    simulated: false,
    transport: "live",
    providerMessageId,
    sentAtSim: "2026-10-13T11:30:00-06:00",
  });
}

describe("statuses of what we sent", () => {
  it("[FL-092] accepts both pricing models of Meta, with or without conversation, and only moves forward", async () => {
    const { w, deps } = await setup();
    const message = await sent(w, "wamid.OUT-A", "REPLY");
    const outcomes = await applyStatuses(
      [
        { id: "wamid.OUT-A", status: "delivered", timestamp: T("2026-10-13T15:20:01Z"), conversation: { id: "conv-1", origin: { type: "service" } }, pricing: { billable: false, pricing_model: "CBP", category: "service" } },
        { id: "wamid.OUT-A", status: "read", timestamp: T("2026-10-13T15:21:00Z"), pricing: { billable: true, pricing_model: "PMP", category: "service", type: "regular" } },
        { id: "wamid.OUT-A", status: "delivered", timestamp: T("2026-10-13T15:21:30Z"), pricing: { pricing_model: "PMP", category: "service" } },
      ],
      deps,
    );
    expect(outcomes).toEqual(["APPLIED", "APPLIED", "STALE"]);
    const events = await w.connector.conversations.listMessageEvents(PEOPLE.rogelio.personId, message.messageId);
    expect(events.map((event) => [event.status, event.pricing?.model, event.pricing?.billable])).toEqual([
      ["DELIVERED", "CBP", false],
      ["READ", "PMP", true],
      ["DELIVERED", "PMP", undefined],
    ]);
    expect((await w.connector.conversations.getMessage(message))?.status).toBe("READ");
    expect(isForward("FAILED", "READ")).toBe(false);
  });

  it("[FL-092] raises the category alarm only for a template billed outside utility", async () => {
    const { w, rec, deps } = await setup();
    await sent(w, "wamid.T-1", "DAY_START", true);
    await sent(w, "wamid.T-2", "DAY_START", true);
    await sent(w, "wamid.F-1", "REPLY");
    await applyStatuses(
      [
        { id: "wamid.T-1", status: "sent", timestamp: T(REAL_NOW), pricing: { pricing_model: "PMP", category: "utility", billable: true } },
        { id: "wamid.T-2", status: "sent", timestamp: T(REAL_NOW), pricing: { pricing_model: "PMP", category: "marketing", billable: true } },
        { id: "wamid.F-1", status: "sent", timestamp: T(REAL_NOW), pricing: { pricing_model: "PMP", category: "service", billable: true } },
      ],
      deps,
    );
    expect(rec.metrics).toEqual([{ metric: "WhatsAppTemplateCategory", dimensions: { category: "marketing" } }]);
  });

  it("[FL-072] a live failure 131047 on a RELAY falls back once to respuesta_supervisor, audited as WINDOW_FALLBACK", async () => {
    const { w, rec, deps } = await setup();
    const relay = await sent(w, "wamid.R-1", "RELAY");
    const failure = { id: "wamid.R-1", status: "failed" as const, timestamp: T(REAL_NOW), errors: [{ code: 131047, title: "Re-engagement message" }] };
    await applyStatuses([failure], deps);
    await applyStatuses([{ ...failure, timestamp: T("2026-10-13T15:25:00Z") }], deps);
    expect(rec.fallbacks).toEqual([{ messageId: relay.messageId, template: "respuesta_supervisor" }]);
    expect((await w.connector.conversations.getMessage(relay))?.status).toBe("FAILED");
    const actions = await w.connector.audit.listByDecision("isp-demo", "ACTION");
    expect(actions).toMatchObject([{ action: "WINDOW_FALLBACK", messageId: relay.messageId, ruleIds: ["CP-WA-24H"], detail: { fallback: "respuesta_supervisor" } }]);
  });

  it("[W3 review B3] a fallback whose send throws releases its claim, so the redelivered status sends it once", async () => {
    const { w, rec, deps } = await setup();
    const relay = await sent(w, "wamid.R-2", "RELAY");
    const failure = { id: "wamid.R-2", status: "failed" as const, timestamp: T(REAL_NOW), errors: [{ code: 131047 }] };
    const broken = { ...deps, fallback: { ...deps.fallback, sendTemplate: async () => Promise.reject(new Error("G3 config unavailable")) } };
    await expect(applyStatuses([failure], broken)).rejects.toThrow("G3 config unavailable");
    expect(await applyStatuses([failure], deps)).toEqual(["DUPLICATE"]);
    await applyStatuses([failure], deps);
    expect(rec.fallbacks).toEqual([{ messageId: relay.messageId, template: "respuesta_supervisor" }]);
    expect(await w.connector.audit.listByDecision("isp-demo", "ACTION")).toMatchObject([{ action: "WINDOW_FALLBACK", messageId: relay.messageId }]);
  });

  it("[FL-072] ORDERS_DETAIL falls back to ordenes_del_dia; other kinds wait for the next inbound; a template never falls back", async () => {
    const { w, rec, deps } = await setup();
    const orders = await sent(w, "wamid.O-1", "ORDERS_DETAIL");
    const notice = await sent(w, "wamid.N-1", "CASE_NOTICE");
    await sent(w, "wamid.T-3", "DAY_START", true);
    const fail = (id: string) => ({ id, status: "failed" as const, timestamp: T(REAL_NOW), errors: [{ code: 131047 }] });
    await applyStatuses([fail("wamid.O-1"), fail("wamid.N-1"), fail("wamid.T-3")], deps);
    expect(rec.fallbacks).toEqual([{ messageId: orders.messageId, template: "ordenes_del_dia" }, { messageId: notice.messageId }]);
    expect(rec.metrics.filter((point) => point.metric === "WhatsAppWindowFallback").map((point) => point.dimensions.fallback)).toEqual(["ordenes_del_dia", "HELD"]);
  });

  it("[FL-092] statuses arrive inside the live event and are applied there", async () => {
    const h = await inboundHarness();
    await sent(h.world, "wamid.OUT-B", "REPLY");
    const relay = await sent(h.world, "wamid.OUT-C", "RELAY");
    const statuses = [
      { id: "wamid.OUT-B", status: "delivered", timestamp: T(REAL_NOW), pricing: { pricing_model: "PMP", category: "service", billable: true } },
      { id: "wamid.OUT-C", status: "failed", timestamp: T(REAL_NOW), errors: [{ code: "131047", title: "Re-engagement message" }] },
    ];
    const result = await processInboundEvent(liveEvent({ statuses }), h.deps);
    expect(result.records).toEqual([{ verdict: "ACCEPT", messages: [], statuses: ["APPLIED", "APPLIED"] }]);
    expect(h.rec.fallbacks).toEqual([{ messageId: relay.messageId, template: "respuesta_supervisor" }]);
  });
});

describe("the real clock of a real phone's window", () => {
  it("[FL-072] a live event of a phone bound to a guest's world updates PHONELEASE#.lastInboundAtReal with Meta's timestamp", async () => {
    const h = await inboundHarness();
    const phone = "+12025550103";
    const code = await h.world.connector.worlds.createJoinCode({ code: "G07-9XYZ", clockId: GUEST, personId: PEOPLE.rogelioG07.personId, userId: "usr-guest-07" });
    await h.world.connector.worlds.bindPhoneLease(code.code, hashOf(phone));
    const message = { ...waText(phone, "wamid.L-1", "Ya llegué"), timestamp: T("2026-10-13T15:19:30Z") };
    await processInboundEvent(liveEvent({ messages: [message] }), h.deps);
    expect((await h.world.connector.worlds.getPhoneLease(hashOf(phone)))?.lastInboundAtReal).toBe("2026-10-13T15:19:30.000Z");
    const person = await h.world.connector.people.getPerson(PEOPLE.rogelioG07.personId);
    expect(person?.lastInboundAtReal).toBeUndefined();
    expect(person?.lastInboundAtSim).toBeDefined();
  });

  it("[FL-072] a live phone of the live world keeps it on the person; a simulated identity never gets one", async () => {
    const w = testConnector(REAL_NOW);
    await seedWorlds(w);
    const deps = { people: w.connector.people, worlds: w.connector.worlds, phoneHashKey: PHONE_KEY };
    const live = await resolveSender({ origin: "LIVE", waId: waIdOf(PEOPLE.rogelio.phone) }, deps);
    await recordLiveInbound(live, T("2026-10-13T15:18:00Z"), w.connector);
    expect((await w.connector.people.getPerson(PEOPLE.rogelio.personId))?.lastInboundAtReal).toBe("2026-10-13T15:18:00.000Z");
    const simulated = await resolveSender({ origin: "SIMULATED", clockId: GUEST, waId: waIdOf(PEOPLE.rogelioG07.phone) }, deps);
    await recordLiveInbound(simulated, T("2026-10-13T15:18:00Z"), w.connector);
    expect((await w.connector.people.getPerson(PEOPLE.rogelioG07.personId))?.lastInboundAtReal).toBeUndefined();
  });
});
