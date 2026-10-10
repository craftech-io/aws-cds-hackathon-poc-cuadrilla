import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ConversationUsage,
  DEFAULT_MODEL_ID,
  MODEL_RATES,
  RATE_CARD_KEYS,
  TokenKind,
  RateCardRow,
  type RateUnit,
  conversationCost,
  exceedsBudget,
  hasProvisionalRates,
} from "./ratecard";

const SEED_SPEC = readFileSync(new URL("../../../../../docs/seed-spec.md", import.meta.url), "utf8");

function verified(key: string, price: number, unit: RateUnit) {
  return { key, price, unit, source: "https://aws.amazon.com/pricing/", asOf: "2026-10-01", provisional: false };
}

const RATES = [
  ...TokenKind.options.map((kind) => verified(`bedrock:${DEFAULT_MODEL_ID}:${kind}`, MODEL_RATES.prices[kind], "PER_1M_TOKENS")),
  verified("bedrock:amazon.titan-embed-text-v2", 0.02, "PER_1M_TOKENS"),
  verified("agentcore:gateway", 0.005, "PER_1K_REQUESTS"),
  verified("agentcore:memoryEvents", 0.25, "PER_1K_REQUESTS"),
  verified("agentcore:memoryRecords", 0.5, "PER_1K_REQUESTS"),
  verified("agentcore:harness", 0.09, "PER_HOUR"),
  verified("transcribe:es-MX:perSecond", 0.024, "PER_MINUTE"),
  verified("ses:outbound", 0.1, "PER_1K_MESSAGES"),
  verified("ses:attachmentsGb", 0.12, "PER_GB"),
  verified("whatsapp:MX:utility", 0.008, "PER_MESSAGE"),
  verified("whatsapp:MX:service", 0.004, "PER_MESSAGE"),
  verified("polly:neural", 16, "PER_1M_CHARACTERS"),
];

const NO_USAGE: ConversationUsage = {
  models: {},
  embeddingTokens: 0,
  agentCore: { gateway: 0, memoryEvents: 0, memoryRecords: 0, harness: 0 },
  transcribeSeconds: 0,
  emails: 0,
  attachmentBytes: 0,
  whatsapp: { utility: 0, service: 0 },
};

// The main story of wo-24817: turns and validations, a voice note of 12 s, two emails with the
// PDF, one template and several messages inside the window.
const STORY: ConversationUsage = {
  models: { [DEFAULT_MODEL_ID]: { input: 400_000, output: 20_000, cacheRead: 1_000_000, cacheWrite: 80_000 } },
  embeddingTokens: 2_000,
  agentCore: { gateway: 30, memoryEvents: 20, memoryRecords: 10, harness: 360 },
  transcribeSeconds: 12,
  emails: 2,
  attachmentBytes: 536_870_912,
  whatsapp: { utility: 1, service: 12 },
};

describe("rate card rows", () => {
  it("cover exactly the keys of docs/seed-spec.md §12", () => {
    const row = SEED_SPEC.split("\n").find((line) => line.startsWith("| `RATECARD` |")) ?? "";
    const keys = [...row.matchAll(/`([a-z]+:[^`\s]+)`/g)].flatMap((match) => {
      const text = match[1] ?? "";
      const braces = /^(.*)\{([^}]+)\}$/.exec(text);
      return braces === null ? [text] : (braces[2] ?? "").split(",").map((part) => `${braces[1] ?? ""}${part}`);
    });
    expect(RATE_CARD_KEYS).toEqual(keys);
    for (const key of RATE_CARD_KEYS) expect(RateCardRow.parse(verified(key, 1, "PER_MESSAGE")).key).toBe(key);
  });

  it("[FL-087] a verified row needs price, source and date; a provisional one may lack them (seed invariant 13)", () => {
    expect(RateCardRow.safeParse({ key: "ses:outbound", price: null, unit: "PER_1K_MESSAGES", source: null, asOf: null, provisional: true }).success).toBe(true);
    // As the seed writes a provisional row: no source and no date at all.
    expect(RateCardRow.parse({ key: "ses:outbound", price: null, unit: "PER_1K_MESSAGES", provisional: true })).toMatchObject({ source: null, asOf: null });
    expect(RateCardRow.safeParse({ key: "ses:outbound", price: 0.1, unit: "PER_1K_MESSAGES", asOf: "2026-10-01", provisional: false }).success).toBe(false);
    const missing = RateCardRow.safeParse({ key: "ses:outbound", price: 0.1, unit: "PER_1K_MESSAGES", source: null, asOf: "2026-10-01", provisional: false });
    expect(missing.success).toBe(false);
    expect(RateCardRow.safeParse({ ...verified("ses:outbound", 0.1, "PER_1K_MESSAGES"), key: "SES outbound" }).success).toBe(false);
    expect(hasProvisionalRates(RATES)).toBe(false);
    expect(hasProvisionalRates([...RATES, { key: "ses:outbound", price: null, unit: "PER_1K_MESSAGES", source: null, asOf: null, provisional: true }])).toBe(true);
  });
});

describe("rates of the default model (ADR-0028)", () => {
  it("[FL-087] are Sonnet 5.5 at USD 2 / 10 / 0.1 / 2.5 per million tokens, verified with source and date", () => {
    expect(DEFAULT_MODEL_ID).toBe("global.anthropic.claude-sonnet-5-5");
    expect(MODEL_RATES).toMatchObject({ modelId: DEFAULT_MODEL_ID, prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } });
    expect(SEED_SPEC).toContain(`\`bedrock:${DEFAULT_MODEL_ID}:{input,output,cacheRead,cacheWrite}\` (USD 2 / 10 / 0,1 / 2,5 por millón`);
    expect(MODEL_RATES.source).toMatch(/^https:\/\/pricing\.us-east-1\.amazonaws\.com\/offers\/v1\.0\/aws\/AmazonBedrockFoundationModels\//);
    for (const kind of TokenKind.options) {
      const row = RateCardRow.parse({ key: `bedrock:${DEFAULT_MODEL_ID}:${kind}`, price: MODEL_RATES.prices[kind], unit: "PER_1M_TOKENS", source: MODEL_RATES.source, asOf: MODEL_RATES.asOf, provisional: false });
      expect(row.provisional).toBe(false);
    }
    expect(RATE_CARD_KEYS.filter((key) => key.includes("claude-opus"))).toEqual([]);
  });
});

describe("conversationCost", () => {
  it("[FL-087] prices every line of a conversation with its own unit and adds them", () => {
    const cost = conversationCost(STORY, RATES, { whatsappSimulated: false });
    expect(cost.status).toBe("VERIFIED");
    if (cost.status !== "VERIFIED") return;
    const byKey = new Map(cost.lines.map((line) => [line.key, line.usd]));
    expect(byKey.get(`bedrock:${DEFAULT_MODEL_ID}:input`)).toBe(0.8);
    expect(byKey.get(`bedrock:${DEFAULT_MODEL_ID}:cacheRead`)).toBe(0.1);
    expect(byKey.get("transcribe:es-MX:perSecond")).toBe(0.0048);
    expect(byKey.get("agentcore:harness")).toBe(0.009);
    expect(byKey.get("ses:attachmentsGb")).toBe(0.06);
    expect(byKey.get("whatsapp:MX:service")).toBe(0.048);
    expect(cost.usd).toBe(1.44019);
    expect(cost.whatsappPricedAsLive).toBe(false);
    expect(cost.lines.some((line) => line.key === "polly:neural")).toBe(false);
  });

  it("prices WhatsApp in simulated mode as if it were live, and says so", () => {
    const cost = conversationCost(STORY, RATES, { whatsappSimulated: true });
    expect(cost).toMatchObject({ status: "VERIFIED", whatsappPricedAsLive: true });
    expect(conversationCost({ ...STORY, whatsapp: { utility: 0, service: 0 } }, RATES, { whatsappSimulated: true }).whatsappPricedAsLive).toBe(false);
  });

  it("shows no total while a used line has no verified rate or a rate in another measure", () => {
    const provisional = RATES.map((row) => (row.key === "whatsapp:MX:service" ? { ...row, price: null, source: null, asOf: null, provisional: true } : row));
    expect(conversationCost(STORY, provisional, { whatsappSimulated: true })).toEqual({ status: "UNVERIFIED", missingRates: ["whatsapp:MX:service"], whatsappPricedAsLive: true });
    const wrongUnit = RATES.map((row) => (row.key === "transcribe:es-MX:perSecond" ? { ...row, unit: "PER_1M_TOKENS" } : row));
    expect(conversationCost(STORY, wrongUnit, { whatsappSimulated: false })).toMatchObject({ status: "UNVERIFIED", missingRates: ["transcribe:es-MX:perSecond"] });
    // An unused line never needs a rate.
    expect(conversationCost(NO_USAGE, [], { whatsappSimulated: false })).toEqual({ status: "VERIFIED", usd: 0, lines: [], whatsappPricedAsLive: false });
  });

  it("prices another validation model under its own keys", () => {
    const usage = { ...NO_USAGE, models: { "anthropic.other-model": { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 } } };
    expect(conversationCost(usage, RATES, { whatsappSimulated: false })).toMatchObject({ status: "UNVERIFIED", missingRates: ["bedrock:anthropic.other-model:input"] });
  });

  it("compares a verified cost with the operator's threshold", () => {
    const cost = conversationCost(STORY, RATES, { whatsappSimulated: false });
    expect(exceedsBudget(cost, 1.4)).toBe(true);
    expect(exceedsBudget(cost, 2)).toBe(false);
    expect(exceedsBudget(cost, undefined)).toBe(false);
    expect(exceedsBudget(conversationCost(STORY, [], { whatsappSimulated: false }), 0)).toBe(false);
  });

  it("rejects malformed usage", () => {
    expect(() => conversationCost({ ...STORY, emails: -1 }, RATES, { whatsappSimulated: false })).toThrow();
    expect(() => conversationCost({ ...STORY, extra: 1 } as ConversationUsage, RATES, { whatsappSimulated: false })).toThrow();
  });
});
