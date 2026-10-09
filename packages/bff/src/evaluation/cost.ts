// Cost of one item of a measurement run (docs/test-plan.md §5 "Costo por pregunta", §7): its model tokens
// priced with the `RateCard` rows of the seed, through the same function the console prices a
// conversation with. While a rate is provisional (or missing) the cost stays unverified: no number.
import { type ConversationUsage, DEFAULT_MODEL_ID, conversationCost } from "../services/ratecard/ratecard";

export interface ItemCost {
  readonly usd: number | null;
  readonly status: "VERIFIED" | "UNVERIFIED";
}

/** Tokens of the Harness turns or of the isolated photo call (both the app's Sonnet 5.5 profile, ADR-0028). */
export function tokenCost(rateRows: readonly unknown[], tokens: { readonly inputTokens: number; readonly outputTokens: number }, modelId: string = DEFAULT_MODEL_ID): ItemCost {
  const usage: ConversationUsage = {
    models: { [modelId]: { input: tokens.inputTokens, output: tokens.outputTokens, cacheRead: 0, cacheWrite: 0 } },
    embeddingTokens: 0,
    agentCore: { gateway: 0, memoryEvents: 0, memoryRecords: 0, harness: 0 },
    transcribeSeconds: 0,
    emails: 0,
    attachmentBytes: 0,
    whatsapp: { utility: 0, service: 0 },
  };
  const cost = conversationCost(usage, rateRows, { whatsappSimulated: true });
  return cost.status === "VERIFIED" ? { usd: cost.usd, status: "VERIFIED" } : { usd: null, status: "UNVERIFIED" };
}
