// `CuadrillaMetrics` of a world (docs/seed-spec.md §7): one KPI row per order closed on 12/10, so the
// "Este mundo" tab has history before the first turn of the demo. They are labelled `SCRIPTED`: they
// were not measured with the real agent, and the console never mixes them with measured ones
// (docs/design-brief.md §8). No cost: a scripted row has no measured tokens to price.
import type { SeedItem } from "../lib/tables";
import { rngFor, row } from "./context";
import { isClosedHistory } from "./orders";
import type { WorldSpec } from "./world";

export interface KpiShape {
  readonly turns: number;
  readonly firstReplyLatenciesMs: number[];
  readonly turnLatenciesMs: number[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly validations: number;
  readonly transcribeSec: number;
  readonly emails: number;
  readonly whatsappMessages: number;
}

/** A plausible scripted conversation of one order: six to nine turns, a few validations, two emails. */
export function scriptedKpi(label: string, validations: number): KpiShape {
  const rng = rngFor("kpi", label);
  const turns = rng.int(6, 9);
  const latencies = Array.from({ length: turns }, () => rng.int(6_500, 24_000));
  return {
    turns,
    firstReplyLatenciesMs: latencies.slice(0, 3).map((latency) => latency - rng.int(1_500, 4_000)),
    turnLatenciesMs: latencies,
    inputTokens: turns * rng.int(9_000, 14_000),
    outputTokens: turns * rng.int(350, 700),
    validations,
    transcribeSec: rng.int(0, 2) * rng.int(6, 14),
    emails: 2,
    whatsappMessages: turns * 2 + validations + 2,
  };
}

export function kpiItems(world: WorldSpec, validations: ReadonlyMap<string, number>): SeedItem[] {
  return world.orders.filter(isClosedHistory).map((order) => {
    const workOrderId = world.workOrderId(order.number);
    return row("ConversationKpi", {
      ispId: world.ispId,
      clockId: world.clockId,
      workOrderId,
      source: "WORLD",
      agentMode: "SCRIPTED",
      ...scriptedKpi(order.number, validations.get(workOrderId) ?? 3),
    });
  });
}
