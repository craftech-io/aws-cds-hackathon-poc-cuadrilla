import { beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { CASE_1, CLOCK, ISP, QA_CLOCK, QA_ISP, VAL_1 } from "../../connector/testing";
import { CASES_TOOLS } from "../cases/schema";
import { EVIDENCE_TOOLS } from "../evidence/schema";
import { casesTools } from "../cases/index";
import { evidenceTools } from "../evidence/index";
import { knowledgeTools } from "../knowledge/index";
import { messagingTools } from "../messaging/index";
import { ordersTools } from "../orders/index";
import { TOOL_CATALOG } from "./catalog";
import type { ToolContext, ToolRuntime } from "./context";
import { notYetAvailable } from "./context";
import type { ToolDefinition, ToolTarget } from "./definition";
import { type ToolResponse, createToolHandler } from "./handler";
import { TURN_ID, TURN_AT_SIM, type ToolTestKit, gatewayContext, seedDay, toolTestKit } from "./testing";

interface Call {
  readonly tool: string;
  readonly args: unknown;
  readonly ctx: ToolContext;
}

const OUTPUTS: Record<string, unknown> = {
  get_checklist: { ok: true, items: [], complete: false },
  validate_install_photo: { ok: true, validationId: VAL_1, verdict: "PASS", readings: { readingDbm: -19.8 }, attempts: 0 },
  update_checklist: { ok: true, item: "ONU_LABEL_PHOTO", status: "PASSED", complete: false },
  record_troubleshooting_step: { ok: true, stepId: "step-001", failedAttempts: 1 },
  escalate_case: { ok: true, caseId: CASE_1, existing: false, rung: "PRIMARY" },
  report_safety_hazard: { ok: true, caseId: CASE_1, instructionSent: true },
  close_installation: { ok: true, status: "CLOSED", deliveries: [] },
};

let kit: ToolTestKit;
let calls: Call[];
let answers: Record<string, (ctx: ToolContext) => Promise<unknown>>;

function fakeTarget(target: ToolTarget, definitions: readonly ToolDefinition[], runtime: () => ToolRuntime = () => kit.runtime) {
  return createToolHandler({
    target,
    deps: runtime,
    tools: definitions.map((definition) => ({
      definition,
      run: async (args: unknown, ctx: ToolContext) => {
        calls.push({ tool: definition.name, args, ctx });
        return answers[definition.name]?.(ctx) ?? OUTPUTS[definition.name];
      },
    })),
  });
}

const evidence = () => fakeTarget("evidence", EVIDENCE_TOOLS);
const cases = () => fakeTarget("cases", CASES_TOOLS);
const worker = { kind: "WORKER", ispId: ISP, clockId: CLOCK, eventId: "evt-0001" };
const consoleUser = { kind: "CONSOLE", ispId: ISP, clockId: CLOCK, userId: "usr-adriana", role: "SUPERVISOR" };
const reason = (response: ToolResponse) => (response.ok ? undefined : [response.error.code, response.error.reason]);

async function denials(): Promise<Array<{ ruleIds: string[]; action: string; actor: string; refs: Record<string, unknown> }>> {
  return (await kit.memory.connector.audit.listByDecision(ISP, "DENY")).map((row) => ({ ruleIds: row.ruleIds, action: row.action, actor: row.actor, refs: row.refs }));
}

beforeEach(async () => {
  kit = toolTestKit();
  calls = [];
  answers = {};
  await seedDay(kit);
});

describe("[FL-096] LAM-CALLER: sessionToken XOR caller, and only the session through the Gateway", () => {
  it("refuses a caller when the context carries the Gateway keys, even with no Cedar forbid on it", async () => {
    const token = await kit.openSession();
    const context = gatewayContext("evidence___get_checklist");
    expect(reason(await evidence().handler({ caller: worker }, context))).toEqual(["FORBIDDEN", "CALLER_THROUGH_GATEWAY"]);
    expect(reason(await evidence().handler({ sessionToken: token, caller: worker }, context))).toEqual(["FORBIDDEN", "CALLER_THROUGH_GATEWAY"]);
    expect(calls).toEqual([]);
  });

  it("accepts a caller in process and scopes it to its world and verified subject", async () => {
    const response = await evidence().invoke("get_checklist", { caller: consoleUser }, { subject: { workOrderId: "wo-24817" } });
    expect(response).toEqual({ ok: true, items: [], complete: false });
    expect(calls[0]?.ctx.identity.kind).toBe("CONSOLE");
    expect(calls[0]?.ctx.scope).toEqual({ ispId: ISP, clockId: CLOCK, installerId: "inst-rogelio", workOrderId: "wo-24817" });
    expect(calls[0]?.ctx.actor).toBe("USER:usr-adriana");
  });

  it("derives installer, order, operator and world from the stored session, never from the input", async () => {
    const token = await kit.openSession();
    const response = await evidence().handler({ sessionToken: token }, gatewayContext("evidence___get_checklist"));
    expect(response.ok).toBe(true);
    const ctx = calls[0]?.ctx;
    expect(ctx?.scope).toEqual({ ispId: ISP, clockId: CLOCK, installerId: "inst-rogelio", workOrderId: "wo-24817", turnId: TURN_ID, eventAtSim: TURN_AT_SIM, sourceMessageId: "wamid.SIM.01" });
    expect(ctx?.actor).toBe("AGENT");
    expect(ctx?.correlationId).toBe(TURN_ID);
    expect(calls[0]?.args).toEqual({});
  });

  it("needs the sessionToken of an open turn through the Gateway", async () => {
    const context = gatewayContext("evidence___get_checklist");
    const token = await kit.openSession();
    expect(reason(await evidence().handler({}, context))).toEqual(["FORBIDDEN", "SESSION_INVALID"]);
    expect(reason(await evidence().handler({ sessionToken: `${token.slice(0, -2)}AA` }, context))).toEqual(["FORBIDDEN", "SESSION_INVALID"]);
    await kit.memory.connector.runtime.closeTurn(TURN_ID);
    expect(reason(await evidence().handler({ sessionToken: token }, context))).toEqual(["FORBIDDEN", "SESSION_EXPIRED"]);
    const fresh = toolTestKit();
    kit = fresh;
    const later = await kit.openSession();
    kit.memory.advance(16 * 60_000);
    expect(reason(await evidence().handler({ sessionToken: later }, context))).toEqual(["FORBIDDEN", "SESSION_EXPIRED"]);
    expect(calls).toEqual([]);
  });

  it("refuses a CHANNEL, CONSOLE, WORKER or SCHEDULER caller on a direct invocation of the Lambda: only the QaDriver invokes it", async () => {
    const liveChannel = { kind: "CHANNEL", ispId: ISP, clockId: CLOCK, eventId: "evt-0003" };
    const close = await cases().handler({ tool: "close_installation", input: { caller: liveChannel, outcome: "INSTALLED" }, subject: { workOrderId: "wo-24817" } });
    expect(reason(close)).toEqual(["FORBIDDEN", "CALLER_NOT_IN_PROCESS"]);
    const scheduler = { kind: "SCHEDULER", ispId: ISP, clockId: CLOCK, eventId: "evt-0004" };
    for (const caller of [consoleUser, worker, scheduler]) {
      expect(reason(await evidence().handler({ tool: "get_checklist", input: { caller }, subject: { workOrderId: "wo-24817" } }))).toEqual(["FORBIDDEN", "CALLER_NOT_IN_PROCESS"]);
    }
    expect(calls).toEqual([]);
    const qa = await evidence().handler({ tool: "validate_install_photo", input: { caller: { kind: "QA", ispId: QA_ISP, clockId: QA_CLOCK }, candidateId: "ec_01", item: "ONU_LABEL_PHOTO" } });
    expect(qa.ok).toBe(true);
    const token = await kit.openSession();
    expect((await evidence().handler({ tool: "get_checklist", input: { sessionToken: token } })).ok).toBe(true);
    expect(calls.map((call) => call.tool)).toEqual(["validate_install_photo", "get_checklist"]);
  });

  it("refuses both principals, none, a malformed envelope and a tool of another target", async () => {
    const token = await kit.openSession();
    const both = await evidence().handler({ tool: "get_checklist", input: { sessionToken: token, caller: worker } });
    expect(reason(both)).toEqual(["INVALID", "PRINCIPAL_XOR"]);
    expect(reason(await evidence().handler({ tool: "get_checklist", input: {} }))).toEqual(["FORBIDDEN", "SESSION_INVALID"]);
    expect(reason(await evidence().handler({ sessionToken: token }))).toEqual(["INVALID", "MALFORMED_CALL"]);
    expect(reason(await evidence().handler({ sessionToken: token }, gatewayContext("orders___get_work_orders")))).toEqual(["INVALID", "UNKNOWN_TOOL"]);
    expect(reason(await evidence().invoke("send_whatsapp", { caller: worker }))).toEqual(["INVALID", "UNKNOWN_TOOL"]);
    expect(calls).toEqual([]);
  });
});

describe("principals of each tool (docs/tool-catalog.md, invocan)", () => {
  it("refuses a principal the tool does not list, a malformed caller and QA outside qa-*/eval-* worlds", async () => {
    expect(reason(await evidence().invoke("update_checklist", { caller: worker, item: "ONU_ONLINE", status: "PASSED" }))).toEqual(["FORBIDDEN", "PRINCIPAL_NOT_ALLOWED"]);
    expect(reason(await cases().invoke("close_installation", { caller: { kind: "CHANNEL", ispId: ISP }, outcome: "INSTALLED" }))).toEqual(["FORBIDDEN", "CALLER_INVALID"]);
    const qaHere = { kind: "QA", ispId: "isp-judge-test", clockId: "JUDGE#isp-judge-test", role: "JUDGE", userId: "usr-qa-judge" };
    expect(reason(await evidence().invoke("validate_install_photo", { caller: qaHere, candidateId: "ec_01", item: "ONU_LABEL_PHOTO" }))).toEqual(["FORBIDDEN", "PRINCIPAL_NOT_ALLOWED"]);
    const qa = await evidence().invoke("validate_install_photo", { caller: { kind: "QA", ispId: QA_ISP, clockId: QA_CLOCK }, candidateId: "ec_01", item: "ONU_LABEL_PHOTO" });
    expect(qa.ok).toBe(true);
    expect(calls.map((call) => call.tool)).toEqual(["validate_install_photo"]);
  });

  it("refuses a subject of another world with FORBIDDEN and AuditLog DENY LAM-SCOPE", async () => {
    const channel = { kind: "CHANNEL", ispId: QA_ISP, clockId: QA_CLOCK, eventId: "evt-0002" };
    const response = await cases().invoke("close_installation", { caller: channel, outcome: "INSTALLED" }, { subject: { workOrderId: "wo-24817" } });
    expect(reason(response)).toEqual(["FORBIDDEN", "WORK_ORDER_NOT_IN_SESSION"]);
    expect(calls).toEqual([]);
    const rows = await kit.memory.connector.audit.listByDecision(QA_ISP, "DENY");
    expect(rows.map((row) => [row.action, row.ruleIds, row.actor])).toEqual([["TOOL_DENIED", ["LAM-SCOPE"], "CHANNEL"]]);
  });
});

describe("[FL-045] LAM-STRICT: override, decision and force are refused with any value", () => {
  it.each([true, false, "yes", null, 0])("update_checklist with override %j is INVALID, audited and never runs", async (override) => {
    const token = await kit.openSession();
    const response = await evidence().handler({ sessionToken: token, item: "ONU_LABEL_PHOTO", status: "PASSED", validationId: VAL_1, override }, gatewayContext("evidence___update_checklist"));
    expect(reason(response)).toEqual(["INVALID", "LAM-STRICT"]);
    expect(calls).toEqual([]);
    expect(await denials()).toEqual([{ ruleIds: ["LAM-STRICT", "CED-NO-OVERRIDE"], action: "TOOL_DENIED", actor: "AGENT", refs: { tool: "update_checklist", turnId: TURN_ID, workOrderId: "wo-24817" } }]);
  });

  it("refuses decision on escalate_case and force on close_installation the same way", async () => {
    const token = await kit.openSession();
    const escalate = await cases().handler({ sessionToken: token, reason: "OTHER", summary: "La ONU no enciende.", decision: "TAKE" }, gatewayContext("cases___escalate_case"));
    const close = await cases().handler({ sessionToken: token, outcome: "INSTALLED", force: true }, gatewayContext("cases___close_installation"));
    expect([reason(escalate), reason(close)]).toEqual([
      ["INVALID", "LAM-STRICT"],
      ["INVALID", "LAM-STRICT"],
    ]);
    expect((await denials()).map((row) => row.ruleIds)).toEqual(expect.arrayContaining([["LAM-STRICT", "CED-NO-SUPERVISOR-DECISION"], ["LAM-STRICT", "CED-NO-FORCE-CLOSE"]]));
    expect(calls).toEqual([]);
  });

  it("refuses an argument the tool does not declare (an id the model wrote) and audits it; a shape error is not audited", async () => {
    const token = await kit.openSession();
    const context = gatewayContext("evidence___validate_install_photo");
    const foreign = await evidence().handler({ sessionToken: token, candidateId: "ec_01", item: "ONU_LABEL_PHOTO", installerId: "inst-karina" }, context);
    expect(reason(foreign)).toEqual(["INVALID", "LAM-STRICT"]);
    expect((await denials()).map((row) => row.ruleIds)).toEqual([["LAM-STRICT"]]);
    const shape = await evidence().handler({ sessionToken: token, candidateId: "ec_01", item: "CUSTOMER_OK" }, context);
    expect(reason(shape)).toEqual(["INVALID", "VALIDATION"]);
    expect(await denials()).toHaveLength(1);
    expect(calls).toEqual([]);
  });
});

describe("[FL-100] LAM-KILL: UNAVAILABLE without effects while the agent is cut, safety exempt", () => {
  it("blocks every tool with the global switch or the world's, and nothing else", async () => {
    const token = await kit.openSession();
    await kit.killAgent("qa-812-1-sc-09");
    expect((await evidence().handler({ sessionToken: token }, gatewayContext("evidence___get_checklist"))).ok).toBe(true);
    await kit.killAgent(CLOCK);
    expect(reason(await evidence().handler({ sessionToken: token }, gatewayContext("evidence___get_checklist")))).toEqual(["UNAVAILABLE", "KILL_SWITCH_ACTIVE"]);
    expect(reason(await cases().invoke("close_installation", { caller: { kind: "CHANNEL", ispId: ISP, clockId: CLOCK }, outcome: "INSTALLED" }))).toEqual(["UNAVAILABLE", "KILL_SWITCH_ACTIVE"]);
    expect(calls).toHaveLength(1);
    expect(await kit.memory.connector.runtime.listTurnResults(TURN_ID, "get_checklist")).toHaveLength(1);
  });

  it("keeps report_safety_hazard working while cut, and fails closed when the switch cannot be read", async () => {
    const token = await kit.openSession();
    await kit.killAgent();
    const hazard = { sessionToken: token, category: "ELECTRICAL", summary: "Cable de luz caído frente al domicilio." };
    expect((await cases().handler(hazard, gatewayContext("cases___report_safety_hazard"))).ok).toBe(true);
    const unreadable = () => ({ ...kit.runtime, killSwitch: { status: async () => Promise.reject(new Error("Runtime down")), invalidate: () => undefined } });
    const broken = fakeTarget("cases", CASES_TOOLS, unreadable);
    expect(reason(await broken.handler({ sessionToken: token, outcome: "INSTALLED" }, gatewayContext("cases___close_installation")))).toEqual(["UNAVAILABLE", undefined]);
    expect((await broken.handler(hazard, gatewayContext("cases___report_safety_hazard"))).ok).toBe(true);
    expect(calls.map((call) => call.tool)).toEqual(["report_safety_hazard", "report_safety_hazard"]);
  });
});

describe("results: never thrown, checked against the output schema, stored for the turn", () => {
  it("turns a thrown error into a failure the model can read", async () => {
    const token = await kit.openSession();
    const context = gatewayContext("evidence___get_checklist");
    answers.get_checklist = async () => Promise.reject(new Error("socket hang up at 10.0.3.7"));
    expect(await evidence().handler({ sessionToken: token }, context)).toEqual({ ok: false, error: { code: "UNAVAILABLE", message: "temporary failure, try again later" } });
    expect(kit.logs.some((line) => line.message === "tool.failed" && line.metric === "ToolErrors")).toBe(true);
    answers.get_checklist = async () => Promise.reject(new ToolError("NOT_FOUND", "there is no active work order", "NO_ACTIVE_WORK_ORDER"));
    expect(reason(await evidence().handler({ sessionToken: token }, context))).toEqual(["NOT_FOUND", "NO_ACTIVE_WORK_ORDER"]);
  });

  it("never throws, not even when the dependencies cannot be built", async () => {
    const unbuildable = fakeTarget("evidence", EVIDENCE_TOOLS, () => {
      throw new ToolError("UNAVAILABLE", 'resource "Runtime" is not linked to this function');
    });
    expect(reason(await unbuildable.handler({ tool: "get_checklist", input: { caller: consoleUser } }))).toEqual(["UNAVAILABLE", undefined]);
  });

  it("answers UNAVAILABLE instead of leaking a field outside the contract", async () => {
    const token = await kit.openSession();
    answers.get_checklist = async () => ({ ok: true, items: [], complete: false, installerPhone: "+525501010001" });
    const response = await evidence().handler({ sessionToken: token }, gatewayContext("evidence___get_checklist"));
    expect(reason(response)).toEqual(["UNAVAILABLE", "OUTPUT_INVALID"]);
    expect(JSON.stringify(response)).not.toContain("5501010001");
  });

  it("keeps the declared failure fields (missing of NOT_COMPLETE) and drops the rest", async () => {
    const token = await kit.openSession();
    answers.close_installation = async () => ({ ok: false, error: { code: "NOT_COMPLETE", message: "falta la foto de la roseta" }, missing: ["ROSETTE_PHOTO"], note: "x" });
    expect(await cases().handler({ sessionToken: token, outcome: "INSTALLED" }, gatewayContext("cases___close_installation"))).toEqual({
      ok: false,
      error: { code: "NOT_COMPLETE", message: "falta la foto de la roseta" },
      missing: ["ROSETTE_PHOTO"],
    });
  });

  it("stores each Harness result under the turn, masked, and never a caller's", async () => {
    const token = await kit.openSession();
    answers.get_checklist = async () => ({ ok: true, items: [{ item: "ROSETTE_PHOTO", label: "Roseta", status: "PENDING", attempts: 0, rubricHint: "escribe a soporte@example.com" }], complete: false });
    await evidence().handler({ sessionToken: token }, gatewayContext("evidence___get_checklist"));
    await evidence().handler({ sessionToken: token }, gatewayContext("evidence___get_checklist"));
    await evidence().invoke("get_checklist", { caller: consoleUser });
    const stored = await kit.memory.connector.runtime.listTurnResults(TURN_ID, "get_checklist");
    expect(stored.map((row) => row.seq)).toEqual([1, 2]);
    expect(JSON.stringify(stored[0]?.output)).toContain("[EMAIL]");
    expect(JSON.stringify(stored[0]?.output)).not.toContain("example.com");
  });
});

describe("target Lambdas", () => {
  it("serve exactly the tools of their catalog entry", () => {
    const handlers = { orders: ordersTools, knowledge: knowledgeTools, evidence: evidenceTools, messaging: messagingTools, cases: casesTools };
    for (const [target, handler] of Object.entries(handlers)) {
      expect([...handler.toolNames].sort(), target).toEqual(TOOL_CATALOG[target as ToolTarget].map((tool) => tool.name).sort());
    }
    expect(() => fakeTarget("evidence", EVIDENCE_TOOLS.slice(1))).toThrow(/must serve exactly/);
    expect(() => fakeTarget("evidence", [...EVIDENCE_TOOLS, CASES_TOOLS[0]])).toThrow(/must serve exactly/);
  });

  it("answer UNAVAILABLE for a tool not implemented yet, behind every fence", async () => {
    const stub = createToolHandler({ target: "evidence", deps: () => kit.runtime, tools: EVIDENCE_TOOLS.map((definition) => notYetAvailable(definition)) });
    const token = await kit.openSession();
    expect(reason(await stub.handler({ sessionToken: token }, gatewayContext("evidence___get_checklist")))).toEqual(["UNAVAILABLE", "NOT_IMPLEMENTED"]);
    expect(reason(await stub.handler({ sessionToken: token, item: "ONU_ONLINE", status: "PASSED", override: true }, gatewayContext("evidence___update_checklist")))).toEqual(["INVALID", "LAM-STRICT"]);
  });
});
