// `CostPerConversation` (ADR-0019, FL-100 (a)): the worker logs the order's conversation cost after each
// turn, priced by the verified rows of the rate card, so the metric filter of the cost cut has a value
// to average; QA and evaluation worlds (a budget per run) never log it.
import { describe, expect, it } from "vitest";
import { testConnector } from "../connector/testing";
import { createLogger } from "../lib/log";
import { MODEL_RATES, bedrockRateKey } from "../services/ratecard/ratecard";
import type { TurnRequest } from "./deps";
import { COST_PER_CONVERSATION_METRIC, conversationCostUsd, recordTurnKpi } from "./record";

const USAGE = { inputTokens: 200_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

function request(clockId: string, ispId: string): TurnRequest {
  return { trigger: "INSTALLER_MESSAGE", eventId: "evt-1", clockId, ispId, installerId: "inst-rogelio", workOrderId: "wo-24817", eventAtSim: "2026-10-13T09:15:00-06:00" };
}

async function setup(verified = true) {
  const world = testConnector();
  for (const kind of ["input", "output"] as const) {
    await world.connector.reference.put("RateCard", {
      key: bedrockRateKey(kind),
      price: verified ? MODEL_RATES.prices[kind] : null,
      unit: "PER_1M_TOKENS",
      provisional: !verified,
      ...(verified ? { source: MODEL_RATES.source, asOf: MODEL_RATES.asOf } : {}),
    });
  }
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger({ level: "info", sink: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>) });
  return { deps: { data: world.connector, agentMode: "REAL" as const, log }, lines };
}

const costLines = (lines: ReadonlyArray<Record<string, unknown>>) => lines.filter((line) => line.metric === COST_PER_CONVERSATION_METRIC);

describe("[W3 review flows B1] CostPerConversation", () => {
  it("logs the conversation's running cost after each turn, priced with the verified model rows", async () => {
    const { deps, lines } = await setup();
    await recordTurnKpi(deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_200);
    await recordTurnKpi(deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_400);
    // 0.2 M input at USD 2 and 0.05 M output at USD 10 per million: USD 0.9 per turn.
    expect(costLines(lines).map((line) => [line.value, line.turns])).toEqual([
      [0.9, 1],
      [1.8, 2],
    ]);
    expect(conversationCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, [])).toBeUndefined();
  });

  it("logs nothing for QA and evaluation worlds, and only a warning while the model rows are not verified", async () => {
    const { deps, lines } = await setup();
    await recordTurnKpi(deps, request("qa-812-1-sc-02", "isp-qa-812-1-sc-02"), USAGE, 1_000);
    await recordTurnKpi(deps, request("eval-812", "isp-eval-812"), USAGE, 1_000);
    expect(costLines(lines)).toEqual([]);
    const unverified = await setup(false);
    await recordTurnKpi(unverified.deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_000);
    expect(costLines(unverified.lines)).toEqual([]);
    expect(unverified.lines.some((line) => line.message === "turn.cost_unpriced")).toBe(true);
  });
});
