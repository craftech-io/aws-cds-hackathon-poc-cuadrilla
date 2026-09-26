import { describe, expect, it } from "vitest";
import { esMX } from "../../copy/es-MX";
import { openCase, workOrder } from "../../connector/testing";
import { processInboundEvent } from "./inbound";
import { DEMO, JUDGE, PEOPLE, SIM_START, hashOf, inboundHarness, liveEvent, nonceFor, simEvent, waButton, waReply, waText } from "./testing";

const ROGELIO = PEOPLE.rogelio;
const JULIAN = PEOPLE.julian;
const ADRIANA = PEOPLE.adriana;

const say = (phone: string, id: string, body: string) => liveEvent({ messages: [waText(phone, id, body)] });
const outcome = async (result: Awaited<ReturnType<typeof processInboundEvent>>) => result.records.flatMap((record) => record.messages);

describe("ALTA and BAJA", () => {
  it("[FL-002] ALTA as the whole message, whatever the case, accents or spaces: record_consent and the welcome, no turn", async () => {
    for (const [index, word] of ["ALTA", "alta", " Alta ", "¡Alta!"].entries()) {
      const h = await inboundHarness();
      expect(await outcome(await processInboundEvent(say(JULIAN.phone, `wamid.A${index}`, word), h.deps))).toEqual(["KEYWORD"]);
      expect(h.rec.actions).toMatchObject([{ name: "recordConsent", input: { personId: JULIAN.personId, clockId: DEMO, ispId: "isp-demo", textVersion: "v001", sourceMessageId: `wamid.A${index}` } }]);
      expect(h.rec.notices).toMatchObject([{ notice: "welcome", text: esMX.welcome("Julián", "INSTALLER") }]);
      expect(h.rec.queued).toEqual([]);
    }
  });

  it("[FL-002] only the whole message counts: 'dar de alta el módem' is not ALTA", async () => {
    const h = await inboundHarness();
    await processInboundEvent(say(JULIAN.phone, "wamid.A9", "dar de alta el módem"), h.deps);
    expect(h.rec.actions).toEqual([]);
    expect(h.rec.notices).toMatchObject([{ notice: "optInRequired" }]);
  });

  it("[FL-002] a supervisor's ALTA gets the supervisor's welcome", async () => {
    const h = await inboundHarness();
    await processInboundEvent(say(ADRIANA.phone, "wamid.A10", "alta"), h.deps);
    expect(h.rec.notices).toMatchObject([{ notice: "welcome", text: esMX.welcome("Adriana", "SUPERVISOR") }]);
  });

  it("[FL-005] BAJA as the whole message: revoke_consent and the confirmation; 'dar de baja el módem' is an ordinary message", async () => {
    const h = await inboundHarness();
    expect(await outcome(await processInboundEvent(say(ROGELIO.phone, "wamid.B1", "dar de baja el módem"), h.deps))).toEqual(["QUEUED"]);
    expect(h.rec.actions).toEqual([]);
    expect(await outcome(await processInboundEvent(say(ROGELIO.phone, "wamid.B2", "Baja"), h.deps))).toEqual(["KEYWORD"]);
    expect(h.rec.actions).toMatchObject([{ name: "revokeConsent", input: { personId: ROGELIO.personId, sourceMessageId: "wamid.B2" } }]);
    expect(h.rec.notices).toMatchObject([{ notice: "optOutConfirmed", text: esMX.optOutConfirmed }]);
    expect(h.rec.queued).toHaveLength(1);
  });

  it("[FL-005] BAJA from a phone bound by a join code releases the lease and leaves the world's person as it was", async () => {
    const h = await inboundHarness();
    const judgePhone = "+12025550102";
    const code = await h.world.connector.worlds.createJoinCode({ code: "J07-7QRT", clockId: JUDGE, personId: PEOPLE.rogelioJ07.personId, userId: "usr-judge-07" });
    await h.world.connector.worlds.bindPhoneLease(code.code, hashOf(judgePhone));
    await processInboundEvent(say(judgePhone, "wamid.B3", "BAJA"), h.deps);
    expect(await h.world.connector.worlds.getPhoneLease(hashOf(judgePhone))).toBeUndefined();
    expect(await h.world.connector.audit.listByDecision("isp-judge-07", "ACTION")).toMatchObject([{ action: "PHONE_LEASE_EXPIRED", reason: "OPT_OUT" }]);
    expect(h.rec.actions).toEqual([]);
    expect(h.rec.notices).toMatchObject([{ notice: "optOutConfirmed", recipient: { transport: "live" } }]);
  });
});

describe("plan B keywords", () => {
  it("[FL-016] ÓRDENES with or without accent, in any case: ORDERS_REQUESTED on the installer's queue, never the Harness in the channel", async () => {
    for (const [index, word] of ["ÓRDENES", "ordenes", "Órdenes."].entries()) {
      const h = await inboundHarness();
      expect(await outcome(await processInboundEvent(say(ROGELIO.phone, `wamid.O${index}`, word), h.deps))).toEqual(["KEYWORD"]);
      expect(h.rec.queued).toMatchObject([{ type: "AGENT_TURN", trigger: "ORDERS_REQUESTED", installerId: ROGELIO.personId, clockId: DEMO }]);
      expect(h.rec.actions).toEqual([]);
      const [stored] = await h.world.connector.conversations.listMessages(ROGELIO.personId);
      expect(stored?.status).toBe("READ");
    }
  });

  it("[FL-016] the 'Ver órdenes' button of the day's template does the same", async () => {
    const h = await inboundHarness();
    const nonce = await nonceFor(h, "rogelio", "VIEW_ORDERS", { kind: "DAY", id: "2026-10-13" });
    await processInboundEvent(liveEvent({ messages: [waButton(ROGELIO.phone, "wamid.O9", nonce, "Ver órdenes")] }), h.deps);
    expect(h.rec.queued).toMatchObject([{ type: "AGENT_TURN", trigger: "ORDERS_REQUESTED", installerId: ROGELIO.personId }]);
  });

  it("[FL-074] TURNO opens a supervisor's shift window; from an installer it is an ordinary message", async () => {
    const h = await inboundHarness();
    await processInboundEvent(say(ADRIANA.phone, "wamid.T1", "turno"), h.deps);
    expect(h.rec.actions).toMatchObject([{ name: "registerShift", input: { personId: ADRIANA.personId, atSim: new Date(SIM_START).toISOString() } }]);
    expect(h.rec.notices).toMatchObject([{ notice: "shiftRegistered", text: esMX.shiftRegistered("07:00") }]);
    await processInboundEvent(say(ROGELIO.phone, "wamid.T2", "TURNO"), h.deps);
    expect(h.rec.queued).toMatchObject([{ type: "INBOUND_MESSAGE", installerId: ROGELIO.personId }]);
  });
});

describe("deterministic buttons", () => {
  it("[FL-031] 'Consultar a mi supervisor' opens the OUT_OF_MANUAL case directly, with the last question and the offer's sections, and no turn", async () => {
    const h = await inboundHarness();
    const conversations = h.world.connector.conversations;
    const question = await processInboundEvent(say(ROGELIO.phone, "wamid.Q1", "¿Se cobra la roseta en otro cuarto? mi tel 5512345678"), h.deps);
    expect(await outcome(question)).toEqual(["QUEUED"]);
    await conversations.appendMessage({
      messageId: "msg-offer-0001",
      personId: ROGELIO.personId,
      ispId: "isp-demo",
      clockId: DEMO,
      direction: "OUT",
      channel: "WHATSAPP",
      content: "INTERACTIVE",
      kind: "REPLY",
      status: "SENT",
      author: "AGENT",
      simulated: false,
      sentAtSim: "2026-10-13T07:05:00-06:00",
      refs: { citations: ["COM-04"] },
    });
    const nonce = await nonceFor(h, "rogelio", "CONSULT_SUPERVISOR", { kind: "WORK_ORDER", id: "wo-24817" }, "msg-offer-0001");
    h.rec.queued.length = 0;
    const tap = await processInboundEvent(liveEvent({ messages: [waReply(ROGELIO.phone, "wamid.Q2", nonce, "Consultar supervisor")] }), h.deps);
    expect(await outcome(tap)).toEqual(["BUTTON"]);
    expect(h.rec.actions).toMatchObject([
      { name: "openConsultCase", input: { workOrderId: "wo-24817", personId: ROGELIO.personId, citations: ["COM-04"], question: "¿Se cobra la roseta en otro cuarto? mi tel [TELEFONO]" } },
    ]);
    expect(h.rec.queued).toEqual([]);
    const tapped = (await conversations.listMessages(ROGELIO.personId)).find((message) => message.messageId === "wamid.Q2");
    expect(tapped).toMatchObject({ buttonAction: "CONSULT_SUPERVISOR", workOrderId: "wo-24817", content: "INTERACTIVE" });
  });

  it("[FL-047] [FL-050] 'Cerrar instalación' calls close_installation; NOT_COMPLETE answers the fixed closeNotComplete with the missing items, no turn", async () => {
    const h = await inboundHarness({ actions: { closeInstallation: async () => ({ ok: false, code: "NOT_COMPLETE", missing: ["ROSETTE_PHOTO", "CUSTOMER_OK"] }) } });
    const nonce = await nonceFor(h, "rogelio", "CLOSE_INSTALLATION", { kind: "WORK_ORDER", id: "wo-24817" });
    await processInboundEvent(liveEvent({ messages: [waReply(ROGELIO.phone, "wamid.C1", nonce, "Cerrar instalación")] }), h.deps);
    expect(h.rec.notices).toMatchObject([{ notice: "closeNotComplete", text: esMX.closeNotComplete(["ROSETTE_PHOTO", "CUSTOMER_OK"]), refs: { items: ["ROSETTE_PHOTO", "CUSTOMER_OK"] } }]);
    expect(h.rec.queued).toEqual([]);
    const person = await h.world.connector.people.getPerson(ROGELIO.personId);
    expect(person?.lastInboundAtSim).toBe(new Date(SIM_START).toISOString());
  });

  it("[FL-047] 'Cliente conforme' records the customer's OK, no turn", async () => {
    const h = await inboundHarness();
    const nonce = await nonceFor(h, "rogelio", "CUSTOMER_OK", { kind: "WORK_ORDER", id: "wo-24817" });
    await processInboundEvent(liveEvent({ messages: [waReply(ROGELIO.phone, "wamid.K1", nonce, "Cliente conforme")] }), h.deps);
    expect(h.rec.actions).toMatchObject([{ name: "recordCustomerOk", input: { workOrderId: "wo-24817" } }]);
    expect(h.rec.queued).toEqual([]);
  });

  it("[FL-055] a supervisor's 'Tomar caso' goes to the queue of the installer of the case (ADR-0017)", async () => {
    const h = await inboundHarness();
    await h.world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24818", workOrderNumber: "24818" }));
    const taken = await h.world.connector.cases.createCase(openCase());
    const nonce = await nonceFor(h, "adriana", "TAKE_CASE", { kind: "CASE", id: taken.caseId });
    await processInboundEvent(liveEvent({ messages: [waButton(ADRIANA.phone, "wamid.S1", nonce, "Tomar caso")] }), h.deps);
    expect(h.rec.queued).toMatchObject([{ type: "SUPERVISOR_ACTION", action: "TAKE_CASE", caseId: taken.caseId, supervisorId: ADRIANA.personId, installerId: ROGELIO.personId }]);
  });

  it("[FL-056] a supervisor's text goes over the bridge of the case they took; with none, a fixed reply", async () => {
    const h = await inboundHarness();
    await processInboundEvent(say(ADRIANA.phone, "wamid.S2", "¿Cómo vas?"), h.deps);
    expect(h.rec.notices).toMatchObject([{ notice: "supervisorNoCase" }]);
    const created = await h.world.connector.cases.createCase(openCase());
    await h.world.connector.cases.takeCase(created.caseId, ADRIANA.personId, { actor: `PERSON:${ADRIANA.personId}`, atSim: "2026-10-13T11:52:00-06:00" });
    await processInboundEvent(say(ADRIANA.phone, "wamid.S3", "Revisa el conector de la roseta"), h.deps);
    expect(h.rec.queued).toMatchObject([{ type: "SUPERVISOR_ACTION", action: "RELAY", caseId: created.caseId, installerId: ROGELIO.personId }]);
  });

  it("[FL-064] with two cases taken, the supervisor picks one from a list and the message goes to that case", async () => {
    const h = await inboundHarness();
    const cases = h.world.connector.cases;
    const first = await cases.createCase(openCase());
    const second = await cases.createCase(openCase({ caseId: "case-01J9ZQX0000000000000000001", workOrderId: "wo-24819" }));
    for (const item of [first, second]) await cases.takeCase(item.caseId, ADRIANA.personId, { actor: `PERSON:${ADRIANA.personId}`, atSim: "2026-10-13T11:52:00-06:00" });
    await processInboundEvent(say(ADRIANA.phone, "wamid.S4", "Ya voy para allá"), h.deps);
    const [choice] = h.rec.notices;
    expect(choice).toMatchObject({ notice: "caseChoice", text: esMX.caseChoicePrompt, list: { button: "Elegir caso" } });
    expect(choice?.list?.rows).toHaveLength(2);
    expect(h.rec.queued).toEqual([]);
    const row = choice?.list?.rows.find((item) => item.title === `Caso C-${second.caseId.slice(-4)}`);
    await processInboundEvent(liveEvent({ messages: [waReply(ADRIANA.phone, "wamid.S5", row?.id ?? "", row?.title ?? "")] }), h.deps);
    expect(h.rec.queued).toMatchObject([{ type: "SUPERVISOR_ACTION", action: "RELAY", caseId: second.caseId, message: { messageId: "wamid.S4" } }]);
  });

  it("[FL-082] a join code from a simulated identity is an ordinary message of the world", async () => {
    const h = await inboundHarness();
    await processInboundEvent(simEvent(JUDGE, PEOPLE.rogelioJ07.phone, "wamid.SIM.K1", { type: "text", body: "ALTA J07-4F2K" }), h.deps);
    expect(h.rec.queued).toMatchObject([{ type: "INBOUND_MESSAGE", installerId: PEOPLE.rogelioJ07.personId }]);
  });
});
