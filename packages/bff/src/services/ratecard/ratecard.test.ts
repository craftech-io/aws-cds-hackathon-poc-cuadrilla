import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ConversationUsage,
  DEFAULT_MODEL_ID,
  RATE_CARD_KEYS,
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
  verified(`bedrock:${DEFAULT_MODEL_ID}:input`, 5, "PER_1M_TOKENS"),
  verified(`bedrock:${DEFAULT_MODEL_ID}:output`, 25, "PER_1M_TOKENS"),
  verified(`bedrock:${DEFAULT_MODEL_ID}:cacheRead`, 0.5, "PER_1M_TOKENS"),
  verified(`bedrock:${DEFAULT_MODEL_ID}:cacheWrite`, 6.25, "PER_1M_TOKENS"),
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
    const missing = RateCardRow.safeParse({ key: "ses:outbound", price: 0.1, unit: "PER_1K_MESSAGES", source: null, asOf: "2026-10-01", provisional: false });
    expect(missing.success).toBe(false);
    expect(RateCardRow.safeParse({ ...verified("ses:outbound", 0.1, "PER_1K_MESSAGES"), key: "SES outbound" }).success).toBe(false);
    expect(hasProvisionalRates(RATES)).toBe(false);
    expect(hasProvisionalRates([...RATES, { key: "ses:outbound", price: null, unit: "PER_1K_MESSAGES", source: null, asOf: null, provisional: true }])).toBe(true);
  });
});

describe("conversationCost", () => {
  it("[FL-087] prices every line of a conversation with its own unit and adds them", () => {
    const cost = conversationCost(STORY, RATES, { whatsappSimulated: false });
    expect(cost.status).toBe("VERIFIED");
    if (cost.status !== "VERIFIED") return;
    const byKey = new Map(cost.lines.map((line) => [line.key, line.usd]));
    expect(byKey.get(`bedrock:${DEFAULT_MODEL_ID}:input`)).toBe(2);
    expect(byKey.get(`bedrock:${DEFAULT_MODEL_ID}:cacheRead`)).toBe(0.5);
    expect(byKey.get("transcribe:es-MX:perSecond")).toBe(0.0048);
    expect(byKey.get("agentcore:harness")).toBe(0.009);
    expect(byKey.get("ses:attachmentsGb")).toBe(0.06);
    expect(byKey.get("whatsapp:MX:service")).toBe(0.048);
    expect(cost.usd).toBe(3.64019);
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
    expect(exceedsBudget(cost, 3)).toBe(true);
    expect(exceedsBudget(cost, 5)).toBe(false);
    expect(exceedsBudget(cost, undefined)).toBe(false);
    expect(exceedsBudget(conversationCost(STORY, [], { whatsappSimulated: false }), 0)).toBe(false);
  });

  it("rejects malformed usage", () => {
    expect(() => conversationCost({ ...STORY, emails: -1 }, RATES, { whatsappSimulated: false })).toThrow();
    expect(() => conversationCost({ ...STORY, extra: 1 } as ConversationUsage, RATES, { whatsappSimulated: false })).toThrow();
  });
});
