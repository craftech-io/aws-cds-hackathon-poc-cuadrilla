import { beforeEach, describe, expect, it } from "vitest";
import { installer } from "../connector/testing";
import { HarnessError } from "../agent/harness-client";
import { CLOCK, ISP, MSG, ROGELIO, RUNTIME_SESSION_KEY, TURN_AT_SIM, WO, type WorkerKit, agentReply, inboundEvent, inboundMessage, metricLines, seedWorld, sessionOf, workerKit } from "../worker/testing";
import { harnessIdentity } from "./identity";
import { FORCED_TURN_FAILURE } from "./invoke";

let kit: WorkerKit;

beforeEach(async () => {
  kit = workerKit();
  await seedWorld(kit);
});

const decisions = async () => kit.connector.audit.listByWorkOrder(WO);
const actions = async () => (await kit.connector.audit.listByMonth(ISP, "2026-10")).map((decision) => decision.action);
const turnEvent = (fields: Record<string, unknown>) => ({ type: "AGENT_TURN", eventId: "evt-turn-0001", clockId: CLOCK, ispId: ISP, installerId: ROGELIO, ...fields });

describe("turns/turn: one invocation of the Harness", () => {
  it("opens the turn's session, signs its token into the envelope and invokes the Harness as the installer's actor on the order's session", async () => {
    const message = await inboundMessage(kit);
    await kit.run(inboundEvent(message));
    const [request] = kit.rec.harness;
    if (request === undefined) throw new Error("no Harness call");
    const { sessionId, turnId } = sessionOf(request.envelope);
    expect(await kit.connector.runtime.getSession(sessionId)).toMatchObject({ turnId, ispId: ISP, installerId: ROGELIO, workOrderId: WO, trigger: "INSTALLER_MESSAGE", clockId: CLOCK, eventAtSim: new Date(TURN_AT_SIM).toISOString(), sourceMessageId: MSG });
    expect(request.actorId).toBe("inst-rogelio-e3");
    expect(request.runtimeSessionId).toBe(harnessIdentity(RUNTIME_SESSION_KEY, { installerId: ROGELIO, clockId: CLOCK, worldEpoch: 3, simDate: "2026-10-13", workOrder: { workOrderId: WO, sessionEpoch: 0 } }).runtimeSessionId);
    expect(request.envelope).toContain('<event type="INSTALLER_MESSAGE"');
    expect(request.envelope).toContain("la ONU no prende la luz PON</inbound-");
  });

  it("closes the turn: a tool refuses its token afterwards", async () => {
    const message = await inboundMessage(kit);
    await kit.run(inboundEvent(message));
    const { token, turnId } = sessionOf(kit.rec.harness[0]?.envelope ?? "");
    expect(await kit.connector.runtime.getTurn(turnId)).toMatchObject({ closedAtReal: expect.any(String), stopReason: "end_turn" });
    expect(await kit.reads.orders.invoke("get_work_order", { sessionToken: token })).toMatchObject({ ok: false, error: { code: "FORBIDDEN", reason: "SESSION_EXPIRED" } });
  });

  it("writes the turn note with stopReason and tokens, and the turn on the order's KPI row with its first-reply latency", async () => {
    const message = await inboundMessage(kit);
    await kit.run(inboundEvent(message));
    const [note] = await kit.connector.conversations.listTurnNotes(ROGELIO);
    expect(note).toMatchObject({ note: "Respondí con el paso siguiente.", stopReason: "end_turn", usage: { inputTokens: 1_200, outputTokens: 150 }, agentMode: "SCRIPTED", workOrderId: WO });
    expect(await kit.connector.metrics.getKpi({ ispId: ISP, source: "WORLD", clockId: CLOCK, workOrderId: WO })).toMatchObject({ turns: 1, inputTokens: 1_200, outputTokens: 150, firstReplyLatenciesMs: [4_000] });
    expect(metricLines(kit, "FirstReplyLatency")).toMatchObject([{ latencyMs: 4_000, kind: "TEXT" }]);
    expect(kit.rec.notices).toEqual([]);
  });

  it("runs a turn without an active order on the installer's day session", async () => {
    await kit.connector.worlds.setActiveWorkOrder(ROGELIO, CLOCK, null);
    // No order of the day is pending: there is nothing to choose from (FL-013).
    for (const workOrderId of [WO, "wo-24818"]) await kit.connector.workOrders.setStatus(workOrderId, "CANCELLED", { actor: "SYSTEM", atSim: TURN_AT_SIM });
    const message = await inboundMessage(kit, { workOrderId: undefined, text: "¿qué órdenes tengo?" });
    await kit.run(inboundEvent(message));
    const [request] = kit.rec.harness;
    const { sessionId } = sessionOf(request?.envelope ?? "");
    expect((await kit.connector.runtime.getSession(sessionId))?.workOrderId).toBeUndefined();
    expect(request?.runtimeSessionId).toBe(harnessIdentity(RUNTIME_SESSION_KEY, { installerId: ROGELIO, clockId: CLOCK, worldEpoch: 3, simDate: "2026-10-13" }).runtimeSessionId);
    expect(request?.envelope).toContain('order active="false"');
  });

  it("keeps max_tokens in the note, logs TurnMaxTokens, audits TURN_FAILED and answers agentFallback when nothing was sent", async () => {
    kit.harnessScripts.push(async () => ({ outcome: "MAX_TOKENS", stopReason: "max_tokens", note: "" }));
    const message = await inboundMessage(kit);
    await kit.run(inboundEvent(message));
    expect((await kit.connector.conversations.listTurnNotes(ROGELIO))[0]).toMatchObject({ stopReason: "max_tokens", note: "TURN_FAILED" });
    expect(metricLines(kit, "TurnMaxTokens")).toHaveLength(1);
    expect(await actions()).toEqual(expect.arrayContaining(["TURN_FAILED", "AGENT_FALLBACK"]));
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["agentFallback"]);
  });

  it("does not answer agentFallback when the cut turn already sent its reply", async () => {
    kit.harnessScripts.push(async (request) => (await agentReply(kit, request.envelope), { outcome: "MAX_TOKENS", stopReason: "max_tokens", note: "" }));
    const message = await inboundMessage(kit);
    await kit.run(inboundEvent(message));
    expect(kit.rec.notices).toEqual([]);
    expect(await actions()).toContain("TURN_FAILED");
  });

  it("answers agentFallback and audits TURN_FAILED when the Harness fails; the event is done", async () => {
    kit.harnessScripts.push(async () => Promise.reject(new HarnessError("REQUEST", "InvokeHarness failed")));
    const message = await inboundMessage(kit);
    await kit.run(inboundEvent(message));
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["agentFallback"]);
    expect((await decisions()).map((decision) => decision.action)).toEqual(expect.arrayContaining(["TURN_FAILED", "AGENT_FALLBACK"]));
    expect(metricLines(kit, "TurnErrors")).toMatchObject([{ cause: "HARNESS_ERROR" }]);
    expect(await kit.connector.runtime.getIdempotency("INBOUND_MESSAGE", "wa-in-0000000000000000000000000000000000000001")).toBeDefined();
  });

  it("restarts a conversation that concluded not to answer (ADR-0028): agentFallback, SESSION_RESET and a new session for the order", async () => {
    kit.harnessScripts.push(async () => ({ note: "El sistema no responde saludos." }));
    const message = await inboundMessage(kit, { text: "hola" });
    await kit.run(inboundEvent(message));
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["agentFallback"]);
    expect(await actions()).toEqual(expect.arrayContaining(["SESSION_RESET", "AGENT_FALLBACK"]));
    expect((await kit.connector.workOrders.getWorkOrder(WO))?.sessionEpoch).toBe(1);
    const second = await inboundMessage(kit, { messageId: `${MSG}2`, text: "hola" });
    await kit.run(inboundEvent(second, "wa-in-0000000000000000000000000000000000000002"));
    expect(kit.rec.harness[1]?.runtimeSessionId).not.toBe(kit.rec.harness[0]?.runtimeSessionId);
  });

  it("counts an escalation of the turn as its answer", async () => {
    kit.harnessScripts.push(async (request) => {
      await kit.connector.runtime.putTurnResult(sessionOf(request.envelope).turnId, "escalate_case", { ok: true, caseId: "case-01J9ZQX0000000000000000009" });
      return {};
    });
    const message = await inboundMessage(kit, { text: "no sé qué más hacer" });
    await kit.run(inboundEvent(message));
    expect(kit.rec.notices).toEqual([]);
    expect((await kit.connector.workOrders.getWorkOrder(WO))?.sessionEpoch).toBe(0);
  });

  it("runs an order of another installer as no order at all (LAM-SCOPE)", async () => {
    await kit.run(turnEvent({ trigger: "WORK_ORDER_CHANGED", workOrderId: "wo-24819", eventAtSim: TURN_AT_SIM }));
    const { sessionId } = sessionOf(kit.rec.harness[0]?.envelope ?? "");
    expect((await kit.connector.runtime.getSession(sessionId))?.workOrderId).toBeUndefined();
    expect(kit.tools.logs.some((line) => line.message === "turn.work_order_out_of_scope")).toBe(true);
  });

  it("gives a CASE_CLOSED turn the supervisor's closing summary as untrusted text, without G1", async () => {
    await kit.connector.cases.createCase({
      caseId: "case-01J9ZQX0000000000000000001",
      ispId: ISP,
      clockId: CLOCK,
      workOrderId: WO,
      installerId: ROGELIO,
      kind: "ESCALATION",
      reason: "DIAGNOSIS_ATTEMPTS",
      status: "CLOSED",
      rung: "PRIMARY",
      rungVersion: 1,
      roster: {},
      summary: "Potencia fuera de rango.",
      closeSummary: "Cambiar el conector <SC/APC> de la roseta.",
      createdAtSim: TURN_AT_SIM,
    });
    await kit.run(turnEvent({ trigger: "CASE_CLOSED", caseId: "case-01J9ZQX0000000000000000001", workOrderId: WO, eventAtSim: TURN_AT_SIM }));
    expect(kit.rec.harness[0]?.envelope).toMatch(/kind="SUPERVISOR_TEXT" truncated="false">Cambiar el conector &lt;SC\/APC&gt; de la roseta\.<\/inbound-/);
    expect(kit.rec.g1).toEqual([]);
    expect(kit.rec.notices).toEqual([]);
  });

  it("[FL-099] fails the next turn of a QA world on purpose (turn.forceFailure): agentFallback without the Harness, then the fault is spent", async () => {
    const qaClock = "qa-812-1-sc-14";
    const qaIsp = "isp-qa-812-1-sc-14";
    await kit.connector.runtime.createClock({ clockId: qaClock, ispId: qaIsp, kind: "QA", mode: "PAUSED", offsetMs: 0, pausedSimNow: TURN_AT_SIM, worldEpoch: 1 });
    await kit.connector.people.createPerson(installer({ personId: "inst-qa-812-1-sc-14-r", ispId: qaIsp, clockId: qaClock, phone: "+525509000001", phoneHash: "e".repeat(64) }));
    await kit.connector.worlds.setFaults({ clockId: qaClock, turn: FORCED_TURN_FAILURE });
    const event = { type: "AGENT_TURN", trigger: "ORDERS_REQUESTED", clockId: qaClock, ispId: qaIsp, installerId: "inst-qa-812-1-sc-14-r", eventAtSim: TURN_AT_SIM };
    await kit.run({ ...event, eventId: "evt-qa-1" });
    expect(kit.rec.harness).toEqual([]);
    expect(kit.rec.notices.map((notice) => notice.notice)).toEqual(["agentFallback"]);
    await kit.run({ ...event, eventId: "evt-qa-2" });
    expect(kit.rec.harness).toHaveLength(1);
  });
});
