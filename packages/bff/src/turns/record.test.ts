// The turn's priced cost (FL-087): the worker leaves each turn's own spend, priced by the verified rows
// of the rate card, on the order's KPI row. No spend alarm reads it (P-07, closed by the CTO on 2026-10-14).
import { describe, expect, it } from "vitest";
import { testConnector } from "../connector/testing";
import { createLogger } from "../lib/log";
import { MODEL_RATES, bedrockRateKey } from "../services/ratecard/ratecard";
import type { TurnRequest } from "./deps";
import { recordTurnKpi, tokensCostUsd } from "./record";

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

describe("the turn's priced cost", () => {
  it("prices the turn's own model tokens with the verified rows only", async () => {
    // 0.2 M input at USD 2 and 0.05 M output at USD 10 per million: USD 0.9 per turn.
    expect(tokensCostUsd(USAGE, await (await setup()).deps.data.reference.listRateCard())).toBe(0.9);
    expect(tokensCostUsd(USAGE, await (await setup(false)).deps.data.reference.listRateCard())).toBeUndefined();
    expect(tokensCostUsd(USAGE, [])).toBeUndefined();
  });

  it("[W6R1 B1] [FL-087] leaves the turn's priced cost on the order's KPI row of every world, summed per conversation", async () => {
    const { deps } = await setup();
    await recordTurnKpi(deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_200);
    await recordTurnKpi(deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_400);
    await recordTurnKpi(deps, request("GUEST#isp-guest-07", "isp-guest-07"), USAGE, 1_000);
    const row = (ispId: string, clockId: string) => deps.data.metrics.getKpi({ ispId, source: "WORLD", clockId, workOrderId: "wo-24817" });
    expect(await row("isp-demo", "GLOBAL#isp-demo")).toMatchObject({ turns: 2, costUsd: 1.8 });
    expect(await row("isp-guest-07", "GUEST#isp-guest-07")).toMatchObject({ turns: 1, costUsd: 0.9 });
    const unverified = await setup(false);
    await recordTurnKpi(unverified.deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_000);
    const unpriced = await unverified.deps.data.metrics.getKpi({ ispId: "isp-demo", source: "WORLD", clockId: "GLOBAL#isp-demo", workOrderId: "wo-24817" });
    expect(unpriced?.turns).toBe(1);
    expect(unpriced?.costUsd).toBeUndefined();
  });

  it("logs no spend line in any world and only a warning while the model rows are not verified", async () => {
    const { deps, lines } = await setup();
    for (const clockId of ["GLOBAL#isp-demo", "qa-812-1-sc-02", "eval-812", "GUEST#isp-guest-07"]) await recordTurnKpi(deps, request(clockId, "isp-demo"), USAGE, 1_000);
    expect(lines.filter((line) => line.metric !== undefined)).toEqual([]);
    const unverified = await setup(false);
    await recordTurnKpi(unverified.deps, request("GLOBAL#isp-demo", "isp-demo"), USAGE, 1_000);
    expect(unverified.lines.some((line) => line.message === "turn.cost_unpriced")).toBe(true);
  });
});
