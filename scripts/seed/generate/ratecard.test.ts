// The verified rate card (WP-49): every `RATECARD` row of docs/seed-spec.md §12 with price, official
// source and date (invariant 13), on the committed seed too, and the estimates priced with it.
import { describe, expect, it } from "vitest";
import { RateCard } from "../../../packages/bff/src/domain/reference";
import {
  RATE_CARD_KEYS,
  RateCardRow,
  TokenKind,
  bedrockRateKey,
  hasProvisionalRates,
  whatsappRateKey,
} from "../../../packages/bff/src/services/ratecard/ratecard";
import { DATA_DIR, fromRoot, tableFile } from "../lib/paths";
import type { SeedItem } from "../lib/tables";
import { bundleOf, readDataDir } from "../validate/bundle";
import { runInvariants } from "../validate/index";
import {
  GATE,
  GATE_WORKLOAD,
  HAPPY_PATH_WORKLOAD,
  RATE_CARD_AS_OF,
  VERIFIED_RATES,
  ceilingDayCost,
  costOf,
  priceOf,
  proposedConversationBudgetUsd,
  rateCardDrift,
  rateCardItems,
  rateCardRows,
  report,
  turnsPerHourToAlarm,
} from "./ratecard";

const committed = readDataDir(fromRoot(DATA_DIR));
const REFERENCE = tableFile("Reference");
const referenceItems = (files: ReadonlyMap<string, string>): SeedItem[] => (JSON.parse(files.get(REFERENCE) ?? "{}") as { items: SeedItem[] }).items;

async function invariant13(files: ReadonlyMap<string, string>): Promise<readonly string[]> {
  const result = (await runInvariants(bundleOf(files), { ci: false })).find((candidate) => candidate.id === 13);
  return result?.errors ?? [];
}

describe("verified rate card (WP-49)", () => {
  it("covers exactly the keys of docs/seed-spec.md §12, in their order, none provisional", () => {
    expect(rateCardItems().map((item) => item.key)).toEqual([...RATE_CARD_KEYS]);
    expect(VERIFIED_RATES.map((verified) => verified.key).sort()).toEqual([...RATE_CARD_KEYS].sort());
    expect(hasProvisionalRates(rateCardRows())).toBe(false);
  });

  it("gives every row a price, an official source and the day it was read (invariant 13)", () => {
    for (const item of rateCardItems()) {
      const parsed = RateCard.parse(item);
      expect(parsed).toMatchObject({ provisional: false, asOf: RATE_CARD_AS_OF });
      expect(parsed.price).toBeTypeOf("number");
      expect(new URL(parsed.source ?? "").hostname).toMatch(/(^|\.)(amazonaws\.com|aws\.amazon\.com|facebook\.com)$/);
    }
    for (const row of rateCardRows()) expect(RateCardRow.safeParse(row).success).toBe(true);
    for (const verified of VERIFIED_RATES) {
      expect(verified.lines.length, verified.key).toBeGreaterThan(0);
      for (const priced of verified.lines) expect(priced.publishedAt <= RATE_CARD_AS_OF, `${verified.key} ${priced.item}`).toBe(true);
    }
  });

  it("prices each row as the sum of its lines, with the prices read on the official sources", () => {
    for (const verified of VERIFIED_RATES) expect(priceOf(verified)).toBeCloseTo(verified.lines.reduce((sum, priced) => sum + priced.usd, 0), 6);
    const price = new Map(rateCardRows().map((row) => [row.key, row.price] as const));
    const tokens = Object.fromEntries(TokenKind.options.map((kind) => [kind, price.get(bedrockRateKey(kind))]));
    expect(tokens).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(price.get("bedrock:amazon.titan-embed-text-v2")).toBe(0.02);
    expect(price.get("transcribe:es-MX:perSecond")).toBe(0.006);
    expect(price.get("ses:outbound")).toBe(0.1);
    expect(price.get("agentcore:harness")).toBe(0.3904);
    // Meta charges a message inside the window from 2026-10-01 at the utility rate, plus the AWS fee.
    expect(price.get(whatsappRateKey("utility"))).toBe(0.0117);
    expect(price.get(whatsappRateKey("service"))).toBe(0.0117);
  });

  it("is what the committed seed carries, and invariant 13 holds there", async () => {
    expect(rateCardDrift(referenceItems(committed))).toEqual([]);
    expect(await invariant13(committed)).toEqual([]);
  });

  it("invariant 13 catches a verified row without its source, and the drift check a stale row", async () => {
    const files = new Map(committed);
    const json = JSON.parse(files.get(REFERENCE) ?? "{}") as { items: SeedItem[] };
    json.items = json.items.map((item) => (item.entity === "RateCard" && item.key === "ses:outbound" ? { ...item, source: undefined } : item));
    files.set(REFERENCE, JSON.stringify(json));
    expect(await invariant13(files)).toEqual(["RATECARD ses:outbound: a verified rate needs price, source and asOf"]);
    const stale = rateCardItems().map((item) => (item.key === bedrockRateKey("cacheRead") ? { ...item, price: 0.2 } : item));
    expect(rateCardDrift(stale)).toEqual([`RATECARD ${bedrockRateKey("cacheRead")} price differs from the verified card`]);
    expect(rateCardDrift([...rateCardItems(), { entity: "RateCard", key: "ses:inbound" }])).toContain("RATECARD ses:inbound is not in the verified card");
  });
});

describe("estimates priced with the verified card", () => {
  it("prices one turn as docs/test-plan.md §7 sizes it, uncached", () => {
    const turn = costOf({ turns: 1, validations: 0, transcribeSeconds: 0 });
    // 30,000-50,000 input and 1,000-3,000 output tokens, plus the Gateway, Memory and Runtime ceilings of a turn.
    expect(turn.min).toBeCloseTo(0.06 + 0.01 + 0.003955, 5);
    expect(turn.max).toBeCloseTo(0.1 + 0.03 + 0.003955, 5);
  });

  it("prices the happy path and proposes a threshold above it for the CTO", () => {
    const happy = costOf(HAPPY_PATH_WORKLOAD);
    expect(happy.min).toBeGreaterThan(1);
    expect(happy.max).toBeLessThan(2);
    expect(proposedConversationBudgetUsd()).toBeGreaterThan(happy.max);
    expect(proposedConversationBudgetUsd()).toBe(2.9);
  });

  it("prices the gate of docs/test-plan.md §7 inside its order of magnitude", () => {
    expect(GATE_WORKLOAD).toMatchObject({ turns: 1_500, validations: 120, transcribeSeconds: 3 * GATE.transcribeSecondsPerSuite });
    const gate = costOf(GATE_WORKLOAD);
    expect(gate.min).toBeGreaterThan(100);
    expect(gate.max).toBeLessThan(240);
  });

  it("prices a day of the global ceiling and the turns an hour that reach the hourly alarm", () => {
    const day = ceilingDayCost({ turnsPerDay: 1_500, validationsPerDay: 400, transcribeSecondsPerDay: 5_400 });
    expect(day.max - day.min).toBeCloseTo(1_500 * 0.06, 5);
    const alarm = turnsPerHourToAlarm(20);
    expect(alarm.min).toBeLessThan(alarm.max);
    expect(alarm.min).toBeGreaterThan(100);
  });

  it("reports every row and every estimate", () => {
    const lines = report({ ceiling: { turnsPerDay: 1_500, validationsPerDay: 400, transcribeSecondsPerDay: 5_400 }, alarmUsdPerHour: 20, projectBudgetUsdPerMonth: 300 });
    for (const key of RATE_CARD_KEYS) expect(lines.some((text) => text.includes(key)), key).toBe(true);
    expect(lines.join("\n")).toMatch(/proposed costBudgetUsdPerConversation \(for the CTO\): USD 2\.90/);
  });
});
