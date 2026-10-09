// `AgentSpendUsd` (ADR-0019, FL-100 (a)): the worker logs each turn's own spend, priced by the verified
// rows of the rate card, so the alarm of the cost cut sums the stage's spend per hour; only the demo and
// live worlds log it (guests have their own ceilings, QA and evaluation a budget per run).
import { describe, expect, it } from "vitest";
import { testConnector } from "../connector/testing";
import { createLogger } from "../lib/log";
import { MODEL_RATES, bedrockRateKey } from "../services/ratecard/ratecard";
import type { TurnRequest } from "./deps";
import { AGENT_SPEND_METRIC, recordTurnKpi, tokensCostUsd } from "./record";

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

const costLines = (lines: ReadonlyArray<Record<string, unknown>>) => lines.filter((line) => line.metric === AGENT_SPEND_METRIC);

describe("[W3R1 N1] AgentSpendUsd", () => {
  it("logs each turn's own spend (never the running total), priced with the verified model rows", async () => {
    const { deps, lines } = await setup();
    await recordTurnKpi(deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_200);
    await recordTurnKpi(deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_400);
    const { workOrderId: _order, ...withoutOrder } = request("GLOBAL#isp-demo", "isp-demo");
    await recordTurnKpi(deps, withoutOrder, USAGE, 1_000);
    // 0.2 M input at USD 2 and 0.05 M output at USD 10 per million: USD 0.9 per turn, every turn.
    expect(costLines(lines).map((line) => [line.value, line.workOrderId])).toEqual([
      [0.9, "wo-24817"],
      [0.9, "wo-24817"],
      [0.9, undefined],
    ]);
    expect(tokensCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, [])).toBeUndefined();
  });

  it("logs nothing for guest (sign-up included), QA and evaluation worlds, and only a warning while the model rows are not verified", async () => {
    const { deps, lines } = await setup();
    await recordTurnKpi(deps, request("qa-812-1-sc-02", "isp-qa-812-1-sc-02"), USAGE, 1_000);
    await recordTurnKpi(deps, request("eval-812", "isp-eval-812"), USAGE, 1_000);
    await recordTurnKpi(deps, request("GUEST#isp-guest-07", "isp-guest-07"), USAGE, 1_000);
    await recordTurnKpi(deps, request("GUEST#isp-guest-s261009abcde", "isp-guest-s261009abcde"), USAGE, 1_000);
    expect(costLines(lines)).toEqual([]);
    const unverified = await setup(false);
    await recordTurnKpi(unverified.deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_000);
    expect(costLines(unverified.lines)).toEqual([]);
    expect(unverified.lines.some((line) => line.message === "turn.cost_unpriced")).toBe(true);
  });
});
