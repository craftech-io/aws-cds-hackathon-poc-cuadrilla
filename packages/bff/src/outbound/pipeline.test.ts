import { describe, expect, it } from "vitest";
import { VERDICT_REACTIONS } from "../copy/buttons";
import { CLOCK, openCase } from "../connector/testing";
import { auditWorld } from "../policy-audit/audit";
import { POLICY_REFS_KEY } from "../policy/as-of";
import { fireDeferredSend, sendOutbound } from "./pipeline";
import { AT_0921, TURN, agentReply, mx, pipelineKit, rogelioWrote } from "./testing";

const ORDER = { workOrderNumber: "24817", plan: "Fibra 300", onuSerial: "DEMO3F2C19A0", windowText: "hoy 09:00 a 11:00" };
const COM_04 = { coverage: "FOUND", passages: [{ sectionId: "COM-04", text: "Hasta 15 m de cable dentro del domicilio no tiene costo; si pasa de 15 m se registra un cargo de extensión en la siguiente factura. El instalador nunca cobra en sitio." }] };

async function auditRows(kit: Awaited<ReturnType<typeof pipelineKit>>) {
  return kit.world.connector.audit.listByMonth("isp-demo", "2026-10");
}

describe("outbound pipeline: an agent reply from policy to transport", () => {
  it("[FL-028] allowed, checked by G2 against the turn and the installer's question, sent and recorded", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit, "La señora quiere la roseta en el otro cuarto, ¿se le cobra?");
    await kit.result("get_work_order", ORDER);
    await kit.result("search_procedures", COM_04);
    const result = await sendOutbound(kit.deps, agentReply("Hasta 15 m de cable no tiene costo; si pasa, se carga en la siguiente factura y tú nunca cobras en sitio (Manual v1, §COM-04).", { citations: ["COM-04"] }), kit.call);
    expect(result).toMatchObject({ status: "SENT", guardrail: { action: "NONE", groundingScore: 0.92 }, window: "OPEN" });
    expect(kit.g2.inputs[0]?.query).toBe("La señora quiere la roseta en el otro cuarto, ¿se le cobra?");
    expect(kit.g2.inputs[0]?.groundingSource).toContain("COM-04");
    const sent = kit.sends[0];
    expect(sent?.payload).toMatchObject({ type: "text", to: "525501010001" });
    const message = (await kit.world.connector.conversations.listMessages("inst-rogelio")).find((item) => item.direction === "OUT");
    expect(message).toMatchObject({ status: "SENT", kind: "REPLY", author: "AGENT", turnId: TURN, policy: { decision: "ALLOW" }, refs: { citations: ["COM-04"] } });
    const allow = (await auditRows(kit)).find((row) => row.decision === "ALLOW");
    expect(allow).toMatchObject({ action: "SEND_WHATSAPP", messageId: result.status === "SENT" ? result.messageId : "", actor: "AGENT" });
    expect(allow?.evaluated).toHaveLength(15);
  });

  it("[FL-077] a cited reply keeps what the policy saw of it, so PolicyAudit allows it again without the turn's results", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit, "La señora quiere la roseta en el otro cuarto, ¿se le cobra?");
    await kit.result("get_work_order", ORDER);
    await kit.result("search_procedures", COM_04);
    await sendOutbound(kit.deps, agentReply("Hasta 15 m de cable no tiene costo; si pasa, se carga en la siguiente factura y tú nunca cobras en sitio (Manual v1, §COM-04).", { citations: ["COM-04"] }), kit.call);
    const message = (await kit.world.connector.conversations.listMessages("inst-rogelio")).find((item) => item.direction === "OUT");
    expect(message?.refs?.[POLICY_REFS_KEY]).toEqual({ form: "TEXT", author: "AGENT", route: "SIMULATED", citations: ["COM-04"], claimsPolicy: true, inResponseToInbound: true, turnSections: ["COM-04"] });
    const report = await auditWorld({ connector: kit.world.connector, readCertificate: async () => undefined }, { clockId: CLOCK });
    expect(report).toMatchObject({ messages: 1, violations: [], errors: 0 });
  });

  it("[FL-025] a greeting is measured against the fixed status question", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit, "hola");
    await kit.result("get_work_order", ORDER);
    await sendOutbound(kit.deps, agentReply("Hola Rogelio, tu orden 24817 sigue en curso."), kit.call);
    expect(kit.g2.inputs[0]?.query).toBe("¿Cómo va mi orden y qué me falta?");
  });

  it("[FL-033] G2 refuses an ungrounded text: nothing leaves, the refusal is logged and audited with its scores, never the text", async () => {
    const kit = await pipelineKit({ g2: [{ action: "BLOCKED", failure: "GROUNDING", groundingScore: 0.31, relevanceScore: 0.77 }] });
    await rogelioWrote(kit, "¿Cuánto cuesta cambiar la roseta?");
    await kit.result("get_work_order", ORDER);
    const invented = "El cambio de roseta cuesta 150 pesos.";
    const result = await sendOutbound(kit.deps, agentReply(invented), kit.call);
    expect(result).toMatchObject({ status: "REFUSED", ruleIds: ["G2"], failure: { ok: false, error: { code: "GROUNDING_FAIL" } } });
    expect(kit.sends).toHaveLength(0);
    const deny = (await auditRows(kit)).find((row) => row.decision === "DENY");
    expect(deny).toMatchObject({ action: "SEND_WHATSAPP", ruleIds: ["G2"], reason: "GROUNDING_FAIL", detail: { g2: { reason: "GROUNDING", groundingScore: 0.31, relevanceScore: 0.77, groundingThreshold: 0.75, relevanceThreshold: 0.5 } } });
    const refusedLine = kit.logs.find((line) => line.message === "outbound.g2_refused");
    expect(refusedLine).toMatchObject({ reason: "GROUNDING", groundingScore: 0.31, groundingThreshold: 0.75 });
    expect(JSON.stringify([deny, refusedLine])).not.toContain("roseta cuesta");
    expect((await kit.world.connector.conversations.listMessages("inst-rogelio")).filter((item) => item.direction === "OUT")).toHaveLength(0);
  });

  it("[FL-033] the fact check refuses a figure no tool returned in the turn, even when G2 passed", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    await kit.result("search_procedures", COM_04);
    const result = await sendOutbound(kit.deps, agentReply("Cambiar la roseta de cuarto cuesta $150 (Manual v1, §COM-04).", { citations: ["COM-04"] }), kit.call);
    expect(result).toMatchObject({ status: "REFUSED", failure: { error: { code: "GROUNDING_FAIL" } } });
    expect(result.status === "REFUSED" ? result.failure.error.message : "").toContain("number 150");
    expect(kit.sends).toHaveLength(0);
  });

  it("[FL-033] a policy statement without a section of the turn is held by CP-CITATION and kept out of the thread", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    await kit.result("search_procedures", COM_04);
    const result = await sendOutbound(kit.deps, agentReply("Hasta 15 m de cable no tiene costo."), kit.call);
    expect(result).toMatchObject({ status: "REFUSED", ruleIds: ["CP-CITATION"], failure: { error: { code: "GROUNDING_FAIL" } } });
    const denied = (await kit.world.connector.conversations.listMessages("inst-rogelio")).find((item) => item.direction === "OUT");
    expect(denied).toMatchObject({ status: "DENIED", policy: { decision: "DENY", ruleIds: ["CP-CITATION"] } });
    expect(denied?.text).toBeUndefined();
    expect(kit.g2.inputs).toHaveLength(0);
  });

  it("outside the 24 h window the agent gets TEMPLATE_REQUIRED and nothing is sent", async () => {
    const kit = await pipelineKit();
    await kit.result("get_work_order", ORDER);
    const result = await sendOutbound(kit.deps, agentReply("Tu orden 24817 sigue en curso."), kit.call);
    expect(result).toMatchObject({ status: "REFUSED", window: "TEMPLATE_REQUIRED", ruleIds: ["CP-WA-24H"], failure: { error: { code: "TEMPLATE_REQUIRED" } } });
    expect(kit.sends).toHaveLength(0);
  });

  it("LAM-BRIDGE: with a case TAKEN on the order the agent does not write", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit);
    await kit.world.connector.cases.createCase(openCase({ workOrderId: "wo-24817", status: "TAKEN", takenBy: "sup-hector", createdAtSim: mx("2026-10-13 09:00") }));
    const result = await sendOutbound(kit.deps, agentReply("Sigue con la foto de la roseta."), kit.call);
    expect(result).toMatchObject({ status: "REFUSED", ruleIds: ["LAM-BRIDGE"], failure: { error: { code: "BRIDGE_ACTIVE" } } });
    expect((await auditRows(kit)).some((row) => row.decision === "DENY" && row.ruleIds.includes("LAM-BRIDGE"))).toBe(true);
    expect(kit.sends).toHaveLength(0);
  });

  it("a transport failure leaves the message FAILED and answers UNAVAILABLE", async () => {
    const kit = await pipelineKit({ failSends: true });
    await rogelioWrote(kit);
    await kit.result("get_work_order", ORDER);
    const result = await sendOutbound(kit.deps, agentReply("Tu orden 24817 sigue en curso."), kit.call);
    expect(result).toMatchObject({ status: "REFUSED", failure: { error: { code: "UNAVAILABLE" } } });
    expect((await kit.world.connector.conversations.listMessages("inst-rogelio")).find((item) => item.direction === "OUT")?.status).toBe("FAILED");
  });
});

describe("outbound pipeline: system messages", () => {
  it("VERDICT_REACTION: ✅ on the photo's message, answering it", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit, "foto");
    const result = await sendOutbound(kit.deps, { channel: "WHATSAPP", personId: "inst-rogelio", kind: "VERDICT_REACTION", author: "SYSTEM", eventAtSim: AT_0921, workOrderId: "wo-24817", inResponseToInbound: true, reaction: { wamid: "wamid.SIM.photo01", emoji: VERDICT_REACTIONS.PASS } }, kit.call);
    expect(result.status).toBe("SENT");
    expect(kit.sends[0]?.payload).toMatchObject({ type: "reaction", reaction: { message_id: "wamid.SIM.photo01", emoji: "✅" } });
    expect((await kit.world.connector.conversations.listMessages("inst-rogelio")).find((item) => item.direction === "OUT")).toMatchObject({ kind: "VERDICT_REACTION", content: "REACTION", author: "SYSTEM" });
  });

  it("[FL-053] template parameters leave masked by G3; a G3 block refuses the message", async () => {
    const kit = await pipelineKit();
    const result = await sendOutbound(
      kit.deps,
      { channel: "WHATSAPP", personId: "inst-rogelio", kind: "SUPERVISOR_REPLY_TEMPLATE", author: "SYSTEM", eventAtSim: mx("2026-10-13 12:10"), workOrderId: "wo-24818", caseId: "case-01J9ZQX0000000000000000000", template: { name: "respuesta_supervisor", params: ["Héctor 5598765432 hector.ibarra@correo-falso.mx", "24818"] } },
      kit.call,
    );
    expect(result.status).toBe("SENT");
    const sentParams = JSON.stringify(kit.sends[0]?.payload);
    expect(sentParams).not.toMatch(/5598765432|@correo-falso/);
    const blocked = await sendOutbound(
      { ...kit.deps, g3: { check: async () => ({ action: "BLOCKED", texts: [] }) } },
      { channel: "WHATSAPP", personId: "inst-rogelio", kind: "SUPERVISOR_REPLY_TEMPLATE", author: "SYSTEM", eventAtSim: mx("2026-10-13 12:20"), workOrderId: "wo-24818", caseId: "case-01J9ZQX0000000000000000000", template: { name: "respuesta_supervisor", params: ["Héctor", "24818"] } },
      kit.call,
    );
    expect(blocked).toMatchObject({ status: "REFUSED", ruleIds: ["G3"], failure: { error: { code: "POLICY_DENIED", reason: "G3_BLOCKED" } } });
    expect(kit.sends).toHaveLength(1);
  });

  it("quiet hours defer a proactive notice to TIMER#DEFERRED_SEND, which sends it when it fires", async () => {
    const kit = await pipelineKit();
    await rogelioWrote(kit, "ya me voy", mx("2026-10-13 21:40"));
    const notice = { channel: "WHATSAPP" as const, personId: "inst-rogelio", kind: "CASE_NOTICE" as const, author: "SYSTEM", eventAtSim: mx("2026-10-13 22:00"), workOrderId: "wo-24818", text: "Tu orden 24818 se reprogramó para mañana." };
    const deferred = await sendOutbound(kit.deps, notice, kit.call);
    expect(deferred).toMatchObject({ status: "DEFERRED", nextAllowedAt: mx("2026-10-14 07:00") });
    expect(kit.armed[0]).toMatchObject({ kind: "DEFERRED_SEND", home: { kind: "WORK_ORDER", id: "wo-24818" }, dueAtSim: mx("2026-10-14 07:00"), reason: "CP-QUIET-HOURS" });
    expect(kit.sends).toHaveLength(0);
    const thread = await kit.world.connector.conversations.listMessages("inst-rogelio");
    expect(thread.find((item) => item.direction === "OUT")).toMatchObject({ status: "DEFERRED", policy: { decision: "DEFER" } });
    const [timer] = await kit.world.connector.timers.listTimers({ kind: "WORK_ORDER", id: "wo-24818" });
    const fired = await fireDeferredSend(kit.deps, timer ?? { kind: "DEFERRED_SEND", payload: {} }, mx("2026-10-14 07:00"), kit.call);
    expect(fired).toMatchObject({ status: "SENT", messageId: `${deferred.messageId}.fired` });
    expect(kit.sends).toHaveLength(1);
  });

  it("an invalid request is refused before anything is written", async () => {
    const kit = await pipelineKit();
    const result = await sendOutbound(kit.deps, { channel: "WHATSAPP", personId: "inst-rogelio", kind: "REPLY", author: "AGENT", eventAtSim: AT_0921 }, kit.call);
    expect(result).toMatchObject({ status: "REFUSED", failure: { error: { code: "INVALID" } } });
    expect(await auditRows(kit)).toHaveLength(0);
  });
});
