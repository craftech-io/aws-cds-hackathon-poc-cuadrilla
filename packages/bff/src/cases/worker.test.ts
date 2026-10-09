import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP } from "../connector/testing";
import type { Case } from "../domain/cases";
import { createLogger } from "../lib/log";
import type { WorkerContext } from "../worker/ports";
import { openCase } from "./open";
import { type CaseKit, ORDER, caseKit, inbound, mx } from "./testing";
import { workerCasePort, workerSafetyPort } from "./worker";

let kit: CaseKit;
let opened: Case;
const AT = mx("2026-10-13 11:55");
const ctx: WorkerContext = { log: createLogger({ level: "error", sink: () => undefined }), sink: { enqueue: async () => undefined }, now: () => new Date(), receiveCount: 1, lambdaDeadlineMs: Date.now() + 300_000 };
const action = (fields: Record<string, unknown>) => ({ type: "SUPERVISOR_ACTION" as const, eventId: "con-take-0001", clockId: CLOCK, ispId: ISP, installerId: "inst-rogelio", supervisorId: "sup-adriana", caseId: opened.caseId, action: "TAKE_CASE" as const, ...fields });

beforeEach(async () => {
  kit = await caseKit();
  await inbound(kit.world, "inst-rogelio", mx("2026-10-13 11:45"));
  opened = (await openCase(kit.deps, { workOrderId: ORDER, reason: "DIAGNOSIS_ATTEMPTS", summary: "Potencia en −29,8 dBm después de tres pasos.", atSim: mx("2026-10-13 11:50"), actor: "SYSTEM" })).caseItem;
});

describe("the cases module as the worker's ports", () => {
  it("[FL-055] takes a case ordered from the console at the world's now, as the console user", async () => {
    await workerCasePort(kit.deps, async () => AT).supervisorAction(action({ actor: "USER:usr-adriana", rungVersion: opened.rungVersion }), ctx);
    expect(await kit.world.connector.cases.getCase(opened.caseId)).toMatchObject({ status: "TAKEN", takenBy: "sup-adriana" });
    expect((await kit.world.connector.audit.listByWorkOrder(ORDER)).find((row) => row.action === "CASE_TAKEN")).toMatchObject({ actor: "USER:usr-adriana" });
  });

  it("ignores a console action armed with an older rung of the ladder", async () => {
    await workerCasePort(kit.deps, async () => AT).supervisorAction(action({ actor: "USER:usr-adriana", rungVersion: opened.rungVersion + 1 }), ctx);
    expect((await kit.world.connector.cases.getCase(opened.caseId))?.status).toBe("OPEN");
  });

  it("[W4 review B1] runs the factory's case preset (CASE_PRESET) on its epoch, idempotently, and skips it after a later reset", async () => {
    const port = workerCasePort(kit.deps, async () => AT);
    const order = await kit.world.connector.workOrders.requireWorkOrder(ORDER);
    const event = { type: "CASE_PRESET" as const, eventId: "con-case-preset-0001", clockId: CLOCK, ispId: ISP, installerId: "inst-rogelio", workOrderId: ORDER, worldEpoch: order.worldEpoch, reason: "OUT_OF_MANUAL" as const, rung: "SECONDARY" as const, status: "OPEN" as const, atSim: AT };
    const ofReason = async () => (await kit.world.connector.cases.listCasesOfWorkOrder(ORDER)).filter((item) => item.reason === "OUT_OF_MANUAL");
    await port.preset({ ...event, worldEpoch: order.worldEpoch - 1 }, ctx);
    expect(await ofReason()).toEqual([]);
    await port.preset(event, ctx);
    await port.preset(event, ctx);
    const cases = await ofReason();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ rung: "SECONDARY", status: "OPEN" });
  });

  it("opens the case of a G1 block once per order and reason", async () => {
    const port = workerCasePort(kit.deps, async () => AT);
    const request = { clockId: CLOCK, ispId: ISP, installerId: "inst-rogelio", workOrderId: ORDER, reason: "PROMPT_INJECTION" as const, summary: "Mensaje con instrucciones sospechosas · orden 24818.", eventId: "wa-in-0001", atSim: AT };
    const first = await port.openCase(request, ctx);
    expect(await port.openCase(request, ctx)).toEqual(first);
  });

  it("[FL-060] classifies with the lexicon and answers a hazard with the fixed instruction and the safety case", async () => {
    const safety = workerSafetyPort(kit.deps);
    expect(await safety.classify("ya quedó la roseta")).toEqual({ matched: false });
    const hazard = await safety.classify("el cable está chispeando en el poste");
    expect(hazard).toMatchObject({ matched: true });
    if (!hazard.matched) return;
    await safety.handle({ clockId: CLOCK, ispId: ISP, installerId: "inst-rogelio", workOrderId: ORDER, category: hazard.category, lexiconVersion: hazard.lexiconVersion, messageId: "wamid.SIM.HAZARD", eventId: "wa-in-0002", atSim: AT }, ctx);
    expect(kit.outbound.sent.some((record) => record.request.kind === "SAFETY_INSTRUCTION")).toBe(true);
    expect((await kit.world.connector.cases.listCasesOfWorkOrder(ORDER)).some((item) => item.reason === "SAFETY")).toBe(true);
  });
});
