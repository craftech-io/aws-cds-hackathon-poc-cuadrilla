// Smoke of the agent on the run's model: the shortest installer turns, on the real prompt, tools and Cedar
// statements. A greeting gets one status reply from the reads the worker preloaded (ALWAYS_ANSWER,
// ADR-0028), a voice note runs a full turn (SC-00/5), an arrival is acknowledged and answered (FL-102),
// and the ONU's state is read, never invented (FL-019). Oracles: tools, stored state, negatives.
import { describe, expect, it } from "vitest";
import { STATUS_QUESTION } from "../../packages/bff/src/agent/grounding";
import { toolsOf, turnsSummary, useAgentWorld } from "./support/agent-world";
import { cutTurns, dirtyOutbound, failedTurns, onOrder, repliesTo } from "./support/oracles";

const worlds = useAgentWorld();
const PRELOADED = ["get_work_order", "get_checklist", "get_work_orders"];

describe("smoke (agent)", () => {
  it("[FL-025] \"hola\" gets exactly one status reply, without reading again what the envelope brought (ALWAYS_ANSWER)", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-rogelio", "wo-24817", "09:20");

    await flow.text("inst-rogelio", "hola");

    const replies = await repliesTo(flow, "inst-rogelio");
    expect(replies, turnsSummary(agent.turns)).toHaveLength(1);
    expect(toolsOf(agent.turns.at(-1)).filter((tool) => PRELOADED.includes(tool)), "the reads come in the envelope").toEqual([]);
    expect(flow.guardrails.g2Inputs.at(-1)?.query, "G2 measures a greeting against the status question").toBe(STATUS_QUESTION.es);
    expect(await flow.data.cases.listCasesOfWorkOrder("wo-24817")).toEqual([]);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });

  it("[SC-00/5] [FL-017] a voice note is transcribed and its turn ends with a REPLY, not cut by max_tokens", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-rogelio", "wo-24817", "09:20");

    await flow.voice("inst-rogelio", "vn-01");

    const voice = (await flow.thread("inst-rogelio")).find((message) => message.direction === "IN" && message.content === "VOICE");
    expect(voice?.transcript?.text ?? "").not.toBe("");
    expect(await repliesTo(flow, "inst-rogelio"), turnsSummary(agent.turns)).not.toHaveLength(0);
    expect(await cutTurns(flow, "inst-rogelio")).toBe(0);
    expect(failedTurns(flow)).toEqual([]);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });

  it("[FL-102] an arrival is marked read and answered in its turn", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-rogelio", "wo-24817", "09:20");

    await flow.text("inst-rogelio", "Ya llegué con la clienta");

    const inbound = (await flow.thread("inst-rogelio")).find((message) => message.direction === "IN" && message.text === "Ya llegué con la clienta");
    expect(inbound?.status).toBe("READ");
    expect(await repliesTo(flow, "inst-rogelio"), turnsSummary(agent.turns)).not.toHaveLength(0);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });

  it("[FL-019] \"¿Cómo está la ONU?\" reads the orchestrator for the order's serial and states no reading it did not get", async () => {
    const { flow, agent } = await worlds.open();
    await onOrder(flow, "inst-rogelio", "wo-24817", "09:20");

    await flow.text("inst-rogelio", "¿Cómo está la ONU?");

    expect(toolsOf(agent.turns.at(-1)), turnsSummary(agent.turns)).toContain("get_onu_status");
    expect(flow.network.requests.filter((request) => request.startsWith("GET")).every((request) => request === "GET /v1/onus/DEMO3F2C19A0")).toBe(true);
    const replies = await repliesTo(flow, "inst-rogelio");
    expect(replies, turnsSummary(agent.turns)).not.toHaveLength(0);
    // The ONU is in LOS: no received power exists to quote.
    expect(replies.map((reply) => reply.text ?? "").join("\n")).not.toMatch(/−?-?\d+[.,]\d+\s*dBm/i);
    expect(await dirtyOutbound(flow, "inst-rogelio")).toEqual([]);
  });
});
