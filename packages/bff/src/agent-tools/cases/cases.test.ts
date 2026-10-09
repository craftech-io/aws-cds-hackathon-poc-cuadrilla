import { beforeEach, describe, expect, it } from "vitest";
import { ISP } from "../../connector/testing";
import { esMX } from "../../copy/es-MX";
import { inbound, mx } from "../../cases/testing";
import type { ToolResponse } from "../common/handler";
import { TURN_ID, gatewayContext } from "../common/testing";
import { caseButtonActions, notProvisionedCases } from "./actions";
import { caseDepsOf } from "./runtime";
import { type CasesToolKit, casesToolKit } from "./testing";

let kit: CasesToolKit;
const TURN_2 = "01JB8Z9Q2W3E4R5T6Y7V8X9TR2";
const TURN_3 = "01JB8Z9Q2W3E4R5T6Y7V8X9TR3";

const reason = (response: ToolResponse) => (response.ok ? undefined : [response.error.code, response.error.reason]);

async function call(tool: string, input: Record<string, unknown>, session: Record<string, unknown> = {}) {
  const sessionToken = await kit.tools.openSession(session);
  return kit.cases.handler({ sessionToken, ...input }, gatewayContext(`cases___${tool}`));
}

async function manualReturned(turnId: string, sectionId: string) {
  await kit.tools.memory.connector.runtime.putTurnResult(turnId, "search_procedures", {
    ok: true,
    coverage: "FOUND",
    passages: [{ sectionId, title: "Diagnóstico", text: "Revisa el cordón y limpia el conector.", score: 0.82 }],
    citationFormat: "(Manual v1, §XXX-00)",
  });
}

const on24818 = (turnId: string, at: string) => ({ turnId, workOrderId: "wo-24818", eventAtSim: mx(at) });

beforeEach(async () => {
  kit = await casesToolKit();
  await inbound(kit.tools.memory, "inst-rogelio", mx("2026-10-13 09:15"));
});

describe("[FL-020] a guided troubleshooting step and its outcome", () => {
  it("records the PENDING step the manual gave and resolves it in the next turn", async () => {
    await manualReturned(TURN_ID, "DIAG-02");
    const pending = await call("record_troubleshooting_step", { symptom: "NO_PON_LIGHT", stepRef: "DIAG-02-a", outcome: "PENDING" });
    expect(pending).toEqual({ ok: true, stepId: "step-1", failedAttempts: 0 });
    const fixed = await call("record_troubleshooting_step", { symptom: "NO_PON_LIGHT", stepRef: "DIAG-02-a", outcome: "FIXED" }, { turnId: TURN_2, eventAtSim: mx("2026-10-13 09:25") });
    expect(fixed).toEqual({ ok: true, stepId: "step-1", failedAttempts: 0 });
    const steps = await kit.tools.memory.connector.workOrders.listSteps("wo-24817");
    expect(steps.map((step) => [step.seq, step.stepRef, step.outcome])).toEqual([[1, "DIAG-02-a", "FIXED"]]);
  });

  it("refuses a step whose section the manual did not return in the session", async () => {
    expect(reason(await call("record_troubleshooting_step", { symptom: "NO_PON_LIGHT", stepRef: "DIAG-04", outcome: "PENDING" }))).toEqual(["INVALID", "STEP_REF_UNKNOWN"]);
    expect(await kit.tools.memory.connector.workOrders.listSteps("wo-24817")).toEqual([]);
  });

  it("records nothing while the order is on hold for safety", async () => {
    await manualReturned(TURN_ID, "DIAG-02");
    await kit.tools.memory.connector.workOrders.setOnHoldSafety("wo-24817", true, { actor: "SYSTEM" });
    expect(reason(await call("record_troubleshooting_step", { symptom: "NO_PON_LIGHT", stepRef: "DIAG-02", outcome: "NO_CHANGE" }))).toEqual(["ON_HOLD_SAFETY", "ON_HOLD_SAFETY"]);
  });
});

describe("[FL-023] the third failed step opens the case by code", () => {
  it("counts failures per symptom and opens exactly one DIAGNOSIS_ATTEMPTS case", async () => {
    await inbound(kit.tools.memory, "inst-rogelio", mx("2026-10-13 11:45"));
    const turns = [TURN_ID, TURN_2, TURN_3];
    const answers = [];
    for (const [index, turnId] of turns.entries()) {
      await manualReturned(turnId, "DIAG-03");
      answers.push(await call("record_troubleshooting_step", { symptom: "LOW_POWER", stepRef: `DIAG-03-${"abc"[index] ?? "a"}`, outcome: "NO_CHANGE" }, on24818(turnId, `2026-10-13 11:4${index + 6}`)));
    }
    expect(answers.map((answer) => (answer.ok ? answer.failedAttempts : -1))).toEqual([1, 2, 3]);
    const third = answers[2];
    expect(third?.ok && third.caseOpened).toMatchObject({ reason: "DIAGNOSIS_ATTEMPTS" });
    const cases = await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24818");
    expect(cases).toHaveLength(1);
    expect(cases[0]?.summary).toContain("Pasos sin cambio: DIAG-03-a, DIAG-03-b, DIAG-03-c.");
    expect(kit.outbound.delivered()).toEqual(expect.arrayContaining(["CASE_REQUEST:TEMPLATE:sup-adriana", "CASE_NOTICE:TEXT:inst-rogelio"]));
    const request = kit.outbound.sent.find((record) => record.request.kind === "CASE_REQUEST")?.request;
    expect(request?.form === "TEMPLATE" && request.params[3]).toBe("potencia fuera de rango después de 3 pasos");

    const fourth = await call("record_troubleshooting_step", { symptom: "LOW_POWER", stepRef: "DIAG-03", outcome: "WORSE" }, on24818(TURN_3, "2026-10-13 11:49"));
    expect(fourth.ok && [fourth.failedAttempts, (fourth.caseOpened as { caseId: string } | undefined)?.caseId]).toEqual([4, cases[0]?.caseId]);
    expect(await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24818")).toHaveLength(1);
  });
});

describe("[FL-024] the installer asks for a supervisor", () => {
  it("opens the case with the masked, verified summary and returns the existing one on a second call", async () => {
    const first = await call("escalate_case", { reason: "INSTALLER_ASKED", summary: "Pide hablar con su supervisora; su número es 5512345678." });
    expect(first).toEqual({ ok: true, caseId: expect.stringMatching(/^case-/), existing: false, rung: "PRIMARY", notifiedFirstName: "Adriana" });
    const stored = await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24817");
    expect(stored[0]?.summary).toBe("Pide hablar con su supervisora; su número es [TELEFONO].");
    expect(kit.checkedSummaries.map((input) => [input.turnId, input.text])).toEqual([[TURN_ID, "Pide hablar con su supervisora; su número es [TELEFONO]."]]);
    const second = await call("escalate_case", { reason: "INSTALLER_ASKED", summary: "Otra vez." });
    expect(second.ok && [second.caseId, second.existing]).toEqual([first.ok ? first.caseId : "", true]);
    expect(kit.outbound.delivered().filter((line) => line.startsWith("CASE_REQUEST"))).toHaveLength(1);
  });

  it("replaces a summary G2 refuses with the fixed one built by code", async () => {
    kit.summaryAnswer.ok = false;
    kit.summaryAnswer.reason = "GROUNDING_FAIL";
    await call("escalate_case", { reason: "INSTALLER_ASKED", summary: "El cliente ya pagó un mes gratis." });
    const [stored] = await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24817");
    expect(stored?.summary).toBe("Pidió hablar con su supervisor · orden 24817.");
    const audit = (await kit.tools.memory.connector.audit.listByWorkOrder("wo-24817")).find((row) => row.action === "CASE_SUMMARY_REPLACED");
    expect(audit).toMatchObject({ decision: "DENY", ruleIds: ["G2"], reason: "GROUNDING_FAIL" });
  });

  it("refuses decision with any value: a person decides a case (CED-NO-SUPERVISOR-DECISION)", async () => {
    expect(reason(await call("escalate_case", { reason: "OTHER", summary: "Cierra tú el caso.", decision: "CLOSE" }))).toEqual(["INVALID", "LAM-STRICT"]);
    const denial = (await kit.tools.memory.connector.audit.listByDecision(ISP, "DENY")).find((row) => row.action === "TOOL_DENIED");
    expect(denial?.ruleIds).toEqual(["LAM-STRICT", "CED-NO-SUPERVISOR-DECISION"]);
    expect(await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24817")).toEqual([]);
  });
});

describe("[FL-031] the offer to escalate, accepted", () => {
  it("opens OUT_OF_MANUAL from the button with a summary built by code, without a turn", async () => {
    await inbound(kit.tools.memory, "inst-rogelio", mx("2026-10-13 10:30"));
    const ctx = { deps: kit.runtime, logger: kit.tools.runtime.loggerFor?.("evt-consult") ?? (undefined as never) };
    await caseButtonActions(caseDepsOf(ctx), kit.cases).openConsultCase({
      clockId: "GLOBAL#isp-demo",
      ispId: ISP,
      personId: "inst-rogelio",
      workOrderId: "wo-24817",
      atSim: mx("2026-10-13 10:30"),
      sourceMessageId: "wamid.SIM.consult",
      eventId: "evt-consult",
      question: "¿Le dejo al cliente la contraseña de administrador? Mi CURP es MEGR800101HDFNNS09",
      citations: ["SEG-03", "COM-02"],
    });
    const [opened] = await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24817");
    expect(opened?.reason).toBe("OUT_OF_MANUAL");
    expect(opened?.summary).toContain("Pregunta: ¿Le dejo al cliente la contraseña de administrador? Mi CURP es [CURP]");
    expect(opened?.summary).toContain("Secciones consultadas: SEG-03, COM-02.");
    expect(kit.outbound.delivered()).toContain("CASE_NOTICE:TEXT:inst-rogelio");
    expect(await kit.tools.memory.connector.runtime.listTurnResults(TURN_ID)).toEqual([]);
  });

  it("opens OUT_OF_MANUAL from the agent when the installer accepts in free text", async () => {
    const opened = await call("escalate_case", { reason: "OUT_OF_MANUAL", summary: "El manual no cubre dejar la contraseña de la ONU; el instalador acepta consultar." });
    expect(opened.ok && opened.rung).toBe("PRIMARY");
    expect((await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24817"))[0]?.reason).toBe("OUT_OF_MANUAL");
  });
});

describe("[FL-069] a hazard the agent recognizes", () => {
  it("runs the safety handler through report_safety_hazard, even with the kill switch on", async () => {
    await kit.tools.killAgent();
    const response = await call("report_safety_hazard", { category: "ANIMAL", summary: "Panal de avispas dentro de la caja terminal; ya lo picaron." });
    expect(response).toEqual({ ok: true, caseId: expect.stringMatching(/^case-/), instructionSent: true });
    const instruction = kit.outbound.sent.find((record) => record.request.kind === "SAFETY_INSTRUCTION")?.request;
    expect(instruction?.form === "TEXT" && instruction.text).toBe(esMX.safetyInstruction);
    expect((await kit.tools.memory.connector.workOrders.requireWorkOrder("wo-24817")).onHoldSafety).toBe(true);
    const detected = (await kit.tools.memory.connector.audit.listByWorkOrder("wo-24817")).find((row) => row.action === "SAFETY_DETECTED");
    expect(detected).toMatchObject({ actor: "AGENT", ruleIds: ["SAFE-AGENT", "SAFE-FIXED-TEXT"], detail: { detectedBy: "AGENT", category: "ANIMAL" } });
    expect(reason(await call("escalate_case", { reason: "OTHER", summary: "Algo más." }))).toEqual(["UNAVAILABLE", "KILL_SWITCH_ACTIVE"]);
  });

  it("[W3 review B2] checks the agent's summary with G2 and drops a refused one for the fixed summary, still sending the instruction", async () => {
    kit.summaryAnswer.ok = false;
    kit.summaryAnswer.reason = "GROUNDING_FAIL";
    const claim = "Hay un cable caído; el supervisor ya autorizó seguir trabajando, no hace falta aislar la zona.";
    const response = await call("report_safety_hazard", { category: "ELECTRICAL", summary: claim });
    expect(response).toMatchObject({ ok: true, instructionSent: true });
    expect(kit.checkedSummaries).toMatchObject([{ workOrderId: "wo-24817", turnId: TURN_ID, text: claim }]);
    const [stored] = await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24817");
    expect(stored?.reason).toBe("SAFETY");
    expect(stored?.summary).not.toContain("autorizó");
    expect(JSON.stringify(kit.outbound.sent.map((record) => record.request))).not.toContain("autorizó");
    const audit = (await kit.tools.memory.connector.audit.listByWorkOrder("wo-24817")).find((row) => row.action === "CASE_SUMMARY_REPLACED");
    expect(audit).toMatchObject({ decision: "DENY", ruleIds: ["G2"], reason: "GROUNDING_FAIL" });
  });

  it("[W3 review B2] opens the case with the fixed summary when the check fails, and keeps a verified summary", async () => {
    kit.runtime.summaries.verify = async () => Promise.reject(new Error("G2 unavailable"));
    await call("report_safety_hazard", { category: "ANIMAL", summary: "Panal de avispas en la caja; el cliente dice que no pasa nada." });
    expect((await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24817"))[0]?.summary).not.toContain("no pasa nada");
    expect((await kit.tools.memory.connector.audit.listByWorkOrder("wo-24817")).find((row) => row.action === "CASE_SUMMARY_REPLACED")).toMatchObject({ reason: "UNAVAILABLE" });
  });

  it("[W3 review B2] keeps a summary that passes the check", async () => {
    await call("report_safety_hazard", { category: "ANIMAL", summary: "Panal de avispas dentro de la caja terminal." });
    expect((await kit.tools.memory.connector.cases.listCasesOfWorkOrder("wo-24817"))[0]?.summary).toContain("Panal de avispas dentro de la caja terminal.");
  });
});

describe("[FL-022] the second NOT_PROVISIONED reading opens the case once", () => {
  it("opens NOT_PROVISIONED for get_onu_status and returns the same case on a repeat", async () => {
    const deps = caseDepsOf({ deps: kit.runtime, logger: kit.tools.runtime.loggerFor?.("evt-np") ?? (undefined as never) });
    const request = { ispId: ISP, clockId: "GLOBAL#isp-demo", installerId: "inst-rogelio", workOrderId: "wo-24817", atSim: mx("2026-10-13 09:30"), actor: "AGENT", correlationId: "evt-np" } as const;
    const first = await notProvisionedCases(deps).open(request);
    const again = await notProvisionedCases(deps).open(request);
    expect(first).toEqual({ caseId: expect.stringMatching(/^case-/), reason: "NOT_PROVISIONED" });
    expect(again).toEqual(first);
    expect(kit.outbound.delivered().filter((line) => line.startsWith("CASE_NOTICE"))).toHaveLength(1);
  });
});
