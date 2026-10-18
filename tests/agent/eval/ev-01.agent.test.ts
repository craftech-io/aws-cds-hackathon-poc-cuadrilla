// EV-01 on the run's model: the 50 questions of the manual (scripts/seed/data/eval/questions.json, the set
// `seed:load` writes as `REF#EVAL#QUESTIONS`), each asked in a fresh local world on the order the committed
// `eval` template names as its model (scripts/seed/data/worlds/eval.json, what `eval.runQuestions` copies for
// each question), made active for its installer at the template's start: one installer, one active order, no
// shared session, and the same order, ONU and plan the deployed measurement asks on. What the question
// left is read and scored by the measurement's own code (evaluation/observe.ts `readQuestion`,
// `escalationOffer`, evaluation/score.ts `scoreQuestion`), and the offer to escalate is tapped as the runner
// does. Gates (packages/bff/src/metrics/eval-score.ts): an `R` question passes or the case fails; an `A`
// question is never voided (nothing invented, promised or personal); the last case checks ≥ 70 % of the 40 `A`
// resolved with the right citation and 10 of 10 `R` escalated without inventing.
//
// EV-02 (the 60 photos) is not here: it measures the isolated photo validation, a `Converse` with an image
// and `record_verdict`, not the Harness. The kit's model contract carries text and tool calls only (no image
// block), so the local run cannot feed it the photos; EV-02 stays on the scripted photo model of the flows
// (tests/flows/evidence.flow.test.ts) until a capped cloud run is approved.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type QuestionReading, escalationOffer, readQuestion } from "../../../packages/bff/src/evaluation/observe";
import { type QuestionSpec, questionSpecOf } from "../../../packages/bff/src/evaluation/outcomes";
import { scoreQuestion } from "../../../packages/bff/src/evaluation/score";
import { QUESTION_TARGETS } from "../../../packages/bff/src/metrics/eval-score";
import { committedEvalTemplate } from "../../../scripts/evaluation/lib/run";
import { turnsSummary, useAgentWorld } from "../support/agent-world";
import { onOrder } from "../support/oracles";

const QUESTIONS: readonly QuestionSpec[] = (JSON.parse(readFileSync(join(import.meta.dirname, "../../../scripts/seed/data/eval/questions.json"), "utf8")) as { questions: unknown[] }).questions.map((row) => questionSpecOf(row as Record<string, unknown>));
const TEMPLATE = committedEvalTemplate();
/** The measurement world's start (`HH:MM` of the demo day): the simulated time every question is asked at. */
const START = TEMPLATE.startAtSim.slice(11, 16);

/** The model order of a question in the committed template: the order its own installer has active. */
function modelOf(questionId: string): string {
  const model = TEMPLATE.questions.find((entry) => entry.questionId === questionId)?.model;
  if (model === undefined) throw new Error(`${questionId} has no model order in the eval template`);
  return model;
}

interface Scored {
  readonly questionId: string;
  readonly type: "A" | "R";
  readonly passed: boolean;
  readonly outcome: string;
  readonly observed: readonly string[];
  readonly voidedBy: readonly string[];
  readonly tapped: boolean;
}

const scored: Scored[] = [];
const worlds = useAgentWorld();

afterAll(() => {
  const out = process.env.AGENT_TEST_OUT;
  if (out === undefined || scored.length === 0) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "ev-01.json"), `${JSON.stringify({ questions: scored.length, results: scored }, null, 2)}\n`);
});

describe("EV-01 · the manual's measurement (agent)", () => {
  it.each(QUESTIONS.map((question) => [question.questionId, question.type, question] as const))("[EV-01] %s (%s)", async (_id, _type, question) => {
    const { flow, agent } = await worlds.open();
    const order = modelOf(question.questionId);
    const installerId = (await flow.data.workOrders.requireWorkOrder(order)).installerId;
    await onOrder(flow, installerId, order, START);
    // Real time past the seed's rows, so the window holds only what this question leaves.
    flow.advanceReal(60_000);
    const sinceReal = new Date(flow.realNow().getTime() - 1_000).toISOString();

    const sent = await flow.text(installerId, question.text);

    const window = { installerId, workOrderId: order, sinceReal, inboundMessageId: sent.wamid };
    let reading: QuestionReading = await readQuestion(flow.data, window);
    const tapped = escalationOffer(reading.observation) !== undefined;
    if (tapped) {
      flow.advanceReal(1_000);
      const tapAtReal = flow.realNow().toISOString();
      await flow.tap(installerId, "CONSULT_SUPERVISOR");
      reading = await readQuestion(flow.data, { ...window, tapAtReal });
    }
    const score = scoreQuestion(question, reading.observation);
    scored.push({ questionId: question.questionId, type: question.type, passed: score.passed, outcome: score.outcome, observed: score.observed, voidedBy: score.voidedBy, tapped });

    const why = `${score.outcome} (observed ${score.observed.join(", ")}) · ${turnsSummary(agent.turns)}`;
    expect(score.voidedBy, why).toEqual([]);
    expect(reading.usage.maxTokensTurns, "a turn cut by max_tokens").toBe(0);
    if (question.type === "R") expect(score.passed, why).toBe(true);
  });

  it("[EV-01] thresholds: A resolved with the right citation ≥ 70 % of 40, R escalated without inventing 10 of 10", (context) => {
    if (scored.length < QUESTIONS.length) context.skip(`only ${scored.length} of ${QUESTIONS.length} questions ran`);
    const answerable = scored.filter((entry) => entry.type === "A");
    const risky = scored.filter((entry) => entry.type === "R");
    const resolved = answerable.filter((entry) => entry.passed).length;
    const escalated = risky.filter((entry) => entry.passed).length;
    const missed = answerable.filter((entry) => !entry.passed).map((entry) => `${entry.questionId}:${entry.outcome}`);
    expect(resolved / answerable.length, `A resolved ${resolved}/${answerable.length}; not resolved: ${missed.join(" ")}`).toBeGreaterThanOrEqual(QUESTION_TARGETS.resolvedWithCitation);
    expect(escalated / risky.length, `R ${escalated}/${risky.length}`).toBeGreaterThanOrEqual(QUESTION_TARGETS.escalatedWithoutInventing);
  });
});
