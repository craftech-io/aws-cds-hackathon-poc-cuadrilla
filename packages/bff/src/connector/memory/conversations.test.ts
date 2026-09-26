import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP, QA_CLOCK, QA_ISP, testConnector } from "../testing";

const inbound = {
  messageId: "msg-01",
  personId: "inst-rogelio",
  ispId: ISP,
  clockId: CLOCK,
  direction: "IN" as const,
  channel: "WHATSAPP" as const,
  content: "VOICE" as const,
  workOrderId: "wo-24817",
  transcript: { text: "No prende la luz PON de la ONU", confidence: 0.93 },
  status: "RECEIVED" as const,
  author: "PERSON:inst-rogelio",
  simulated: true,
  providerMessageId: "wamid.SIM.01",
  sentAtSim: "2026-10-13T09:20:00-06:00",
};
const reply = {
  ...inbound,
  messageId: "msg-02",
  direction: "OUT" as const,
  content: "TEXT" as const,
  kind: "REPLY" as const,
  text: "Limpia el conector de la roseta (Manual v1, §DIAG-02).",
  transcript: undefined,
  status: "SENT" as const,
  author: "AGENT",
  providerMessageId: "wamid.SIM.02",
  sentAtSim: "2026-10-13T09:20:20-06:00",
};
const mail = {
  mailId: "mail-1",
  ispId: ISP,
  clockId: CLOCK,
  kind: "CERTIFICATE_EMAIL" as const,
  toRole: "CUSTOMER" as const,
  to: "success+c10421@simulator.amazonses.com",
  from: '"Cuadrilla · Actas" <actas@cuadrilla.demo.craftech.io>',
  subject: "Acta de instalación · Orden 24817",
  bodyText: "Adjuntamos el acta de instalación.",
  workOrderId: "wo-24817",
  status: "QUEUED" as const,
  sentAtSim: "2026-10-13T10:58:00-06:00",
  sentAtReal: "2026-10-13T16:58:00.000Z",
};

describe("conversations over the memory connector", () => {
  let world: ReturnType<typeof testConnector>;

  beforeEach(async () => {
    world = testConnector();
    await world.connector.conversations.appendMessage(inbound);
    await world.connector.conversations.appendMessage(reply);
  });

  it("keeps a person's thread in simulated order and finds messages by id and by provider id", async () => {
    expect((await world.connector.conversations.listMessages("inst-rogelio")).map((message) => message.messageId)).toEqual(["msg-01", "msg-02"]);
    expect((await world.connector.conversations.listMessages("inst-rogelio", { fromSim: "2026-10-13T09:20:10-06:00" })).map((message) => message.messageId)).toEqual(["msg-02"]);
    expect((await world.connector.conversations.listMessages("inst-rogelio", { toSim: "2026-10-13T09:20:00-06:00" })).map((message) => message.messageId)).toEqual(["msg-01"]);
    expect((await world.connector.conversations.findMessage("inst-rogelio", "msg-02"))?.kind).toBe("REPLY");
    expect((await world.connector.conversations.findMessageByProviderId("wamid.SIM.01"))?.transcript?.confidence).toBe(0.93);
    expect(await world.connector.conversations.findMessageByProviderId("wamid.SIM.99")).toBeUndefined();
    expect((await world.connector.conversations.getMessage({ personId: "inst-rogelio", sentAtSim: reply.sentAtSim, messageId: "msg-02" }))?.sentAtSim).toBe("2026-10-13T15:20:20.000Z");
    await expect(world.connector.conversations.appendMessage(inbound)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("updates a message in place with its WhatsApp status and records status events", async () => {
    const delivered = await world.connector.conversations.updateMessage({ personId: "inst-rogelio", sentAtSim: reply.sentAtSim, messageId: "msg-02" }, { status: "DELIVERED" });
    expect(delivered).toMatchObject({ status: "DELIVERED", version: 2 });
    await world.connector.conversations.appendMessageEvent({ eventId: "evt-1", personId: "inst-rogelio", clockId: CLOCK, messageId: "msg-02", status: "DELIVERED", atReal: "2026-10-13T15:20:21.000Z", pricing: { model: "PMP", category: "service" } });
    expect(await world.connector.conversations.listMessageEvents("inst-rogelio", "msg-02")).toHaveLength(1);
    expect(await world.connector.conversations.listMessageEvents("inst-rogelio", "msg-01")).toEqual([]);
    await expect(world.connector.conversations.updateMessage({ personId: "inst-rogelio", sentAtSim: reply.sentAtSim, messageId: "msg-99" }, { status: "READ" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("draws an order's timeline from messages, emails and turn notes", async () => {
    await world.connector.conversations.appendTurnNote({ turnId: "turn-1", personId: "inst-rogelio", clockId: CLOCK, workOrderId: "wo-24817", trigger: "INSTALLER_MESSAGE", note: "Paso §DIAG-02 indicado.", stopReason: "end_turn", atSim: "2026-10-13T09:20:30-06:00" });
    await world.connector.conversations.appendMail(mail);
    const timeline = await world.connector.conversations.listTimeline("wo-24817");
    expect(timeline.map((entry) => entry.entity)).toEqual(["Message", "Message", "TurnNote", "OutboundEmail"]);
    expect((await world.connector.conversations.listTurnNotes("inst-rogelio")).map((note) => note.turnId)).toEqual(["turn-1"]);
  });

  it("keeps the outbox of each operator with its SES events", async () => {
    await world.connector.conversations.appendMail(mail);
    await world.connector.conversations.appendMail({ ...mail, mailId: "mail-qa", ispId: QA_ISP, clockId: QA_CLOCK });
    const ref = { ispId: ISP, sentAtSim: mail.sentAtSim, mailId: "mail-1" };
    await world.connector.conversations.updateMail(ref, { status: "SENT", providerMessageId: "ses-0001" });
    const delivered = await world.connector.conversations.updateMail(ref, { status: "DELIVERED", event: { type: "DELIVERY", atReal: "2026-10-13T16:58:04.000Z" } });
    expect(delivered).toMatchObject({ status: "DELIVERED", providerMessageId: "ses-0001", events: [{ type: "DELIVERY" }] });
    expect((await world.connector.conversations.findMailByProviderId("ses-0001"))?.mailId).toBe("mail-1");
    expect((await world.connector.conversations.findMail(ISP, "mail-1"))?.status).toBe("DELIVERED");
    expect((await world.connector.conversations.listOutbox(ISP)).map((listed) => listed.mailId)).toEqual(["mail-1"]);
    expect((await world.connector.conversations.getMail({ ispId: QA_ISP, sentAtSim: mail.sentAtSim, mailId: "mail-qa" }))?.world).toBe("qa");
  });
});

describe("audit log over the memory connector", () => {
  it("appends decisions by operator and month, indexed by order and by decision", async () => {
    const world = testConnector();
    const allow = await world.connector.audit.append({ ispId: ISP, clockId: CLOCK, atSim: "2026-10-13T09:20:20-06:00", decision: "ALLOW", action: "SEND_WHATSAPP", ruleIds: ["CP-WA-24H"], evaluated: [{ ruleId: "CP-WA-24H", result: "PASS", clock: "WORLD" }], messageId: "msg-02", actor: "AGENT", refs: { workOrderId: "wo-24817", turnId: "turn-1" } });
    expect(allow).toMatchObject({ decisionId: "id-0001", ts: "2026-10-13T15:20:20.000Z", atReal: world.now().toISOString() });
    await world.connector.audit.append({ ispId: ISP, decision: "ACTION", action: "SEED_LOADED", actor: "OPERATOR" });
    await world.connector.audit.append({ ispId: ISP, clockId: CLOCK, atSim: "2026-10-13T12:00:00-06:00", decision: "DENY", action: "SEND_WHATSAPP", ruleIds: ["CP-QUIET-HOURS"], actor: "SYSTEM", refs: { workOrderId: "wo-24818" } });
    expect((await world.connector.audit.listByMonth(ISP, "2026-10")).map((decision) => `${decision.action}@${decision.ts}`)).toEqual([
      "SEED_LOADED@2026-10-13T13:00:00.000Z",
      "SEND_WHATSAPP@2026-10-13T15:20:20.000Z",
      "SEND_WHATSAPP@2026-10-13T18:00:00.000Z",
    ]);
    expect((await world.connector.audit.listByWorkOrder("wo-24817")).map((decision) => decision.decision)).toEqual(["ALLOW"]);
    expect(await world.connector.audit.listByDecision(ISP, "DENY")).toHaveLength(1);
    expect(await world.connector.audit.listByDecision(ISP, "ALLOW", { fromTs: "2026-10-13T16:00:00Z" })).toEqual([]);
    expect(await world.connector.audit.listByDecision(ISP, "ALLOW", { fromTs: "2026-10-13T15:00:00Z", toTs: "2026-10-13T16:00:00Z" })).toHaveLength(1);
    expect(world.client.dump("AuditLog").every((row) => typeof row.expiresAt === "number")).toBe(true);
    await expect(world.connector.audit.append({ ispId: ISP, decision: "ACTION", action: "not-upper", actor: "SYSTEM" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
