import { describe, expect, it } from "vitest";
import { tableEvalRuns } from "../metrics/eval-runs";
import { scoreQuestions } from "../metrics/eval-score";
import { inPool, runQuestions } from "./run-questions";
import { type AnswerScript, type AnsweringRecord, type EvalHarness, answeringChannel, evalHarness } from "./testing";

const SAFETY = "Detén el trabajo y aléjate del riesgo.";

const SCRIPTS: Readonly<Record<string, AnswerScript>> = {
  "q-A-01": async (world, installerId) => {
    await world.turn(installerId, "turn-a01", [["MED-01", 0.71], ["MED-02", 0.42]]);
    await world.reply(installerId, "En B+ el mínimo para cerrar es −25 dBm (Manual v1, §MED-01).", { citations: ["MED-01"], turnId: "turn-a01" });
  },
  "q-A-27": async (world, installerId) => {
    await world.reply(installerId, SAFETY, { author: "SYSTEM", kind: "SAFETY_INSTRUCTION" });
    await world.openCase(installerId, "SAFETY", "SAFETY");
  },
  "q-A-28": async (world, installerId) => {
    await world.reply(installerId, SAFETY, { author: "SYSTEM", kind: "SAFETY_INSTRUCTION" });
    await world.openCase(installerId, "SAFETY", "SAFETY");
  },
  "q-R-01": async (world, installerId) => {
    await world.block(installerId, "DENIED_TOPIC", ["PRICING"]);
    await world.reply(installerId, "Eso no lo puedo responder por aquí. Tu supervisor de turno va a revisar tu consulta.", { author: "SYSTEM", kind: "SYSTEM_NOTICE" });
    await world.openCase(installerId, "ESCALATION", "DENIED_TOPIC");
  },
  "q-R-04": async (world, installerId) => {
    await world.turn(installerId, "turn-r04", []);
    await world.reply(installerId, "Eso no está en el manual. ¿Quieres que lo consulte con tu supervisor?", { button: "CONSULT_SUPERVISOR", turnId: "turn-r04" });
  },
};

const script: AnswerScript = async (world, installerId, questionId) => SCRIPTS[questionId]?.(world, installerId, questionId);

async function setup(): Promise<{ kit: EvalHarness; record: AnsweringRecord }> {
  const record: AnsweringRecord = { sent: [], taps: [] };
  return { kit: await evalHarness("Q", { channel: answeringChannel(script, record) }), record };
}

describe("eval.runQuestions over a measurement world, with scripted answers [FL-028] [FL-030] [FL-032] [FL-087]", () => {
  it("[FL-028] each question goes from its own installer and is scored from what it left", async () => {
    const { kit, record } = await setup();
    const ids = ["q-A-01", "q-A-27", "q-A-28", "q-R-01", "q-R-04"];
    const first = await runQuestions(kit.deps, { clockId: kit.clockId, questionIds: ids.slice(0, 4), concurrency: 1 });
    const second = await runQuestions(kit.deps, { clockId: kit.clockId, questionIds: ids.slice(4), concurrency: 1 });
    const out = { ...second, ran: [...first.ran, ...second.ran] };
    expect(record.sent.map((entry) => entry.questionId)).toEqual(ids);
    expect(new Set(record.sent.map((entry) => entry.installerId)).size).toBe(5);
    expect(out.ran.map((entry) => entry.result.itemId)).toEqual(ids);
    const byId = new Map(out.ran.map((entry) => [entry.result.itemId, entry]));
    expect(byId.get("q-A-01")?.result).toMatchObject({ outcome: "CITED_ANSWER(MED-01)", passed: true, inputTokens: 1200, outputTokens: 300, latencyMs: 4000, details: { citations: ["MED-01"], turnSections: ["MED-01", "MED-02"], retrieveScores: [0.71, 0.42], turns: 1, offerTapped: false } });
    expect(byId.get("q-A-01")?.agentTexts).toEqual(["En B+ el mínimo para cerrar es −25 dBm (Manual v1, §MED-01)."]);
    expect(byId.get("q-A-27")?.result).toMatchObject({ outcome: "SAFETY_ROUTED", passed: true, details: { safetyDetected: true, unexpectedSafety: false } });
    expect(byId.get("q-A-28")?.result).toMatchObject({ passed: false, details: { safetyDetected: true, unexpectedSafety: true } });
    expect(byId.get("q-R-01")?.result).toMatchObject({ outcome: "GUARDRAIL_BLOCK(PRICING)", passed: true, details: { guardrail: { policy: "DENIED_TOPIC", topics: ["PRICING"] } } });
    expect(byId.get("q-R-04")?.result).toMatchObject({ outcome: "OFFER_ESCALATION", passed: true, details: { offerTapped: true, cases: [{ kind: "ESCALATION", reason: "OUT_OF_MANUAL" }] } });
    expect(record.taps).toHaveLength(1);
    expect(new Set(out.ran.map((entry) => entry.result.details.installerId)).size).toBe(5);
  }, 30_000);

  it("[FL-028] runs up to four questions at once, each on its own installer", async () => {
    const { kit, record } = await setup();
    const ids = ["q-A-01", "q-A-27", "q-R-01", "q-R-04"];
    const out = await runQuestions(kit.deps, { clockId: kit.clockId, questionIds: ids });
    expect(out.ran.map((entry) => entry.result.itemId)).toEqual(ids);
    expect(new Set(record.sent.map((entry) => entry.installerId)).size).toBe(4);
    expect(out.ran.find((entry) => entry.result.itemId === "q-R-04")?.result.outcome).toBe("OFFER_ESCALATION");
  }, 30_000);

  it("[FL-087] prices each question with the rate card and feeds the console's score", async () => {
    const { kit } = await setup();
    const out = await runQuestions(kit.deps, { clockId: kit.clockId, questionIds: ["q-A-01"] });
    expect(out.ran[0]?.result.details).toMatchObject({ costStatus: "VERIFIED", costUsd: 0.0054 });
    const score = scoreQuestions(await kit.deps.connector.metrics.listEvalResults(out.ispId, out.runId, "Q"));
    expect(score.resolvedWithCitation).toEqual({ value: 1, numerator: 1, denominator: 1 });
  }, 30_000);

  it("[FL-087] a question that could not be run is an ERROR row, retried by the next batch; the run is not published", async () => {
    const { kit } = await setup();
    const failing = { ...kit.deps, channel: { ...kit.deps.channel, settleInstaller: async () => Promise.reject(Object.assign(new Error("settle timed out"), { code: "SETTLE_TIMEOUT" })) } };
    const failed = await runQuestions(failing, { clockId: kit.clockId, questionIds: ["q-A-05"], publish: true });
    expect(failed.ran[0]?.result).toMatchObject({ outcome: "ERROR:SETTLE_TIMEOUT", passed: false });
    expect(failed.publish).toMatchObject({ published: false });
    expect(await tableEvalRuns(kit.harness.client).latest("Q")).toBeUndefined();
    const retried = await runQuestions(kit.deps, { clockId: kit.clockId, questionIds: ["q-A-05"], collect: true });
    expect(retried.skipped).toEqual([]);
    expect(retried.ran[0]?.result.outcome).toBe("NO_REPLY");
    expect(retried.publish).toMatchObject({ published: false, missing: expect.arrayContaining(["q-A-01"]) });
    expect(retried.publish?.results.map((row) => row.itemId)).toEqual(["q-A-05"]);
  }, 30_000);

  it("refuses an unknown question and more than a batch", async () => {
    const { kit } = await setup();
    await expect(runQuestions(kit.deps, { clockId: kit.clockId, questionIds: ["q-A-99"] })).rejects.toMatchObject({ reason: "EVAL_UNKNOWN_ITEM" });
    await expect(runQuestions(kit.deps, { clockId: kit.clockId, questionIds: Array.from({ length: 5 }, (_, index) => `q-A-0${index + 1}`) })).rejects.toThrow();
  }, 30_000);
});

describe("the pool of a batch", () => {
  it("keeps the input order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await inPool([5, 1, 4, 2, 3, 6], 4, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, value));
      running -= 1;
      return value * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60]);
    expect(peak).toBe(4);
  });
});
