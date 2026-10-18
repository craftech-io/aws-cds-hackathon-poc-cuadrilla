import { describe, expect, it } from "vitest";
import { CLOCK, ISP, installer, openCase, workOrder } from "../../connector/testing";
import { createLogger } from "../../lib/log";
import { createKillSwitchReader } from "../../ops/kill-switch";
import { createMemoryRuntimeStore } from "../../ops/memory-runtime-store";
import { TURN, mx, pipelineKit, rogelioWrote } from "../../outbound/testing";
import { openSession } from "../../services/session/session";
import { createToolHandler } from "../common/handler";
import { TEST_SESSION_KEY, gatewayContext } from "../common/testing";
import { MESSAGING_IMPLEMENTATIONS, type MessagingRuntime } from "./handler";

const TOOL = "messaging___send_whatsapp";
const ORDER = { workOrderNumber: "24817", windowText: "hoy 09:00 a 11:00" };

async function messagingKit(options: Parameters<typeof pipelineKit>[0] = {}) {
  const kit = await pipelineKit(options);
  const { connector } = kit.world;
  await connector.people.createPerson(installer({ personId: "inst-karina", firstName: "Karina", phone: "+525501010002", phoneHash: "d".repeat(64) }));
  await connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24819", workOrderNumber: "24819", customerId: "cust-10423", installerId: "inst-karina" }));
  const realClock = { now: async () => kit.world.now() };
  const runtime: MessagingRuntime = {
    connector,
    killSwitch: createKillSwitchReader({ store: createMemoryRuntimeStore(), realClock, ttlMs: 0 }),
    sessionKey: () => TEST_SESSION_KEY,
    realClock,
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", sink: (line) => kit.logs.push(JSON.parse(line) as Record<string, unknown>), now: kit.world.now }),
    outbound: () => kit.deps,
  };
  const tools = createToolHandler({ target: "messaging", deps: () => runtime, tools: [...MESSAGING_IMPLEMENTATIONS] });
  const session = async (trigger: "INSTALLER_MESSAGE" | "CASE_CLOSED" = "INSTALLER_MESSAGE") =>
    (
      await openSession(
        { sessionKey: TEST_SESSION_KEY, store: connector.runtime, nowMs: kit.world.now().getTime() },
        { turnId: TURN, ispId: ISP, installerId: "inst-rogelio", workOrderId: "wo-24817", trigger, clockId: CLOCK, eventAtSim: mx("2026-10-13 09:21"), sourceMessageId: "wamid.SIM.01" },
      )
    ).token;
  const send = async (args: Record<string, unknown>, trigger?: "INSTALLER_MESSAGE" | "CASE_CLOSED") => tools.handler({ sessionToken: await session(trigger), recipientRole: "INSTALLER", kind: "REPLY", ...args }, gatewayContext(TOOL));
  return { ...kit, tools, send };
}

describe("send_whatsapp", () => {
  it("[FL-028] speaks to the installer of the session through the pipeline and answers SENT with the policy and G2", async () => {
    const kit = await messagingKit();
    await rogelioWrote(kit);
    await kit.result("get_work_order", ORDER);
    const response = await kit.send({ text: "Tu orden 24817 va bien: sigue la foto de la etiqueta.", refs: { workOrderIds: ["24817"], items: ["ONU_LABEL_PHOTO"] }, buttons: [{ action: "CHOOSE_ITEM", item: "ONU_LABEL_PHOTO" }] });
    expect(response).toMatchObject({ ok: true, status: "SENT", windowState: "OPEN", policyResult: { allowed: true }, guardrail: { action: "NONE", groundingScore: 0.92 } });
    expect(kit.sends).toHaveLength(1);
    expect(kit.sends[0]?.payload).toMatchObject({ to: "525501010001", type: "interactive", context: { message_id: "wamid.SIM.01" } });
    const message = (await kit.world.connector.conversations.listMessages("inst-rogelio")).find((item) => item.direction === "OUT");
    expect(message).toMatchObject({ author: "AGENT", kind: "REPLY", workOrderId: "wo-24817", refs: { workOrderIds: ["wo-24817"], items: ["ONU_LABEL_PHOTO"] } });
  });

  it("LAM-STRICT: a recipient other than the installer, or a key the schema does not declare, is refused before anything", async () => {
    const kit = await messagingKit();
    await rogelioWrote(kit);
    expect(await kit.send({ recipientRole: "SUPERVISOR", text: "Hola" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await kit.send({ text: "Hola", to: "+525501020001" })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "LAM-STRICT" } });
    expect(kit.sends).toHaveLength(0);
  });

  it("[FL-025] LAM-SCOPE: an order of another installer is FORBIDDEN, audited, and nothing is sent", async () => {
    const kit = await messagingKit();
    await rogelioWrote(kit);
    const response = await kit.send({ text: "Karina tiene la orden 24819.", refs: { workOrderIds: ["24819"] } });
    expect(response).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const denials = await kit.world.connector.audit.listByDecision(ISP, "DENY");
    expect(denials.some((row) => row.ruleIds.includes("LAM-SCOPE"))).toBe(true);
    expect(kit.sends).toHaveLength(0);
  });

  it("[FL-033] an ungrounded text answers GROUNDING_FAIL so the agent retries with the data or escalates", async () => {
    const kit = await messagingKit({ g2: [{ action: "BLOCKED", failure: "GROUNDING", groundingScore: 0.2, relevanceScore: 0.9 }] });
    await rogelioWrote(kit);
    expect(await kit.send({ text: "El cambio de roseta cuesta 150 pesos." })).toMatchObject({ ok: false, error: { code: "GROUNDING_FAIL", reason: "GROUNDING_FAIL" } });
    expect(kit.sends).toHaveLength(0);
  });

  it("outside the window it answers TEMPLATE_REQUIRED (the agent has no templates)", async () => {
    const kit = await messagingKit();
    await kit.result("get_work_order", ORDER);
    expect(await kit.send({ text: "Tu orden 24817 sigue en curso." }, "CASE_CLOSED")).toMatchObject({ ok: false, error: { code: "TEMPLATE_REQUIRED" } });
  });

  it("with the case of the order taken it answers BRIDGE_ACTIVE (LAM-BRIDGE)", async () => {
    const kit = await messagingKit();
    await rogelioWrote(kit);
    await kit.world.connector.cases.createCase(openCase({ workOrderId: "wo-24817", status: "TAKEN", takenBy: "sup-hector", createdAtSim: mx("2026-10-13 09:00") }));
    expect(await kit.send({ text: "Sigue con la roseta." })).toMatchObject({ ok: false, error: { code: "BRIDGE_ACTIVE", reason: "LAM-BRIDGE" } });
  });

  it("[FL-093] the same text twice in the turn: one message, the second answer names the first", async () => {
    const kit = await messagingKit();
    await rogelioWrote(kit);
    await kit.result("get_work_order", ORDER);
    const first = await kit.send({ text: "Tu orden 24817 va bien." });
    const second = await kit.send({ text: "Tu orden 24817 va bien." });
    expect(first).toMatchObject({ ok: true, status: "SENT" });
    expect(second).toMatchObject({ ok: true, status: "SENT", messageId: first.ok ? first.messageId : "" });
    expect(kit.sends).toHaveLength(1);
  });

  it("[FL-030] keeps as citations only the sections the text names: a refs.citations the installer never reads is no citation", async () => {
    const kit = await messagingKit();
    await rogelioWrote(kit);
    await kit.result("search_procedures", { coverage: "FOUND", passages: [{ sectionId: "GEN-02" }, { sectionId: "COM-04" }] });
    const silent = await kit.send({ text: "El manual no cubre el empalme en el poste; ¿lo consulto con tu supervisora?", refs: { citations: ["GEN-02"] }, buttons: [{ action: "CONSULT_SUPERVISOR" }] });
    const cited = await kit.send({ text: "Tú nunca cobras en sitio (Manual v1, §COM-04).", refs: { citations: ["COM-04", "GEN-02"] } });
    expect([silent, cited]).toMatchObject([{ ok: true }, { ok: true }]);
    const out = (await kit.world.connector.conversations.listMessages("inst-rogelio")).filter((item) => item.direction === "OUT" && item.author === "AGENT");
    expect(out.map((item) => item.refs?.citations ?? [])).toEqual([[], ["COM-04"]]);
  });

  it("[FL-069] after report_safety_hazard in the turn nothing else goes out: the fixed instruction answered (ADR-0016)", async () => {
    const kit = await messagingKit();
    await rogelioWrote(kit);
    await kit.result("report_safety_hazard", { ok: false, error: { code: "INVALID", message: "summary too long" } });
    expect(await kit.send({ text: "Sigue con la roseta." })).toMatchObject({ ok: true, status: "SENT" });
    await kit.result("report_safety_hazard", { ok: true, caseId: "case-01M4TNRFE07K7XZPJFAKGQMAXS", instructionSent: true });
    expect(await kit.send({ text: "No toques la caja y aléjate del área." })).toMatchObject({ ok: false, error: { code: "ON_HOLD_SAFETY", reason: "SAFETY_REPORTED" } });
    expect(kit.sends).toHaveLength(1);
  });
});
