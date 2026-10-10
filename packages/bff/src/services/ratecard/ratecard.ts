// Cost per conversation (docs/design-brief.md §8, CONTEXT.md "Costo por conversación"): Bedrock
// (Harness turns and photo validations), the query embeddings of the manual, AgentCore, Transcribe,
// WhatsApp and SES of one work order, priced with the `RATECARD` rows of `Reference`
// (docs/seed-spec.md §12). A row carries its price, unit, official source and date; every row ships
// verified (WP-49, invariant 13), and a row that is still `provisional` makes the metric say it has no
// verified rate instead of showing a number. WhatsApp in `simulated` mode is priced as if
// it were live (Meta charges templates, and from 2026-10-01 also messages inside the window,
// ADR-0019), and the result says so. The same rows price a QA run's budget (docs/test-plan.md §4.4).
import { z } from "zod";
import { CalendarDate } from "@cuadrilla/shared";

/** Model of the Harness and of the photo validator (docs/architecture.md §1); token rows are keyed by it. */
export const DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-5-5";
/**
 * Verified prices of DEFAULT_MODEL_ID in USD per million tokens (ADR-0028): the "Standard, Global" lines
 * of the AWS Price List for us-east-1 (offer AmazonBedrockFoundationModels, 5-minute cache writes; cache
 * reads halved from 2026-10-07). The seed's `RATECARD` rows take them from here.
 */
export const MODEL_RATES = {
  modelId: DEFAULT_MODEL_ID,
  prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  source: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json",
  asOf: "2026-10-10",
} as const;
/** Embeddings of the Knowledge Base; `Retrieve` embeds each query. */
export const EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2";

export const TokenKind = z.enum(["input", "output", "cacheRead", "cacheWrite"]);
export type TokenKind = z.infer<typeof TokenKind>;

export const WhatsAppPricing = z.enum(["utility", "service"]);
export type WhatsAppPricing = z.infer<typeof WhatsAppPricing>;

export const AgentCoreMeter = z.enum(["gateway", "memoryEvents", "memoryRecords", "harness"]);
export type AgentCoreMeter = z.infer<typeof AgentCoreMeter>;

export function bedrockRateKey(kind: TokenKind, modelId: string = DEFAULT_MODEL_ID): string {
  return `bedrock:${modelId}:${kind}`;
}
export const EMBEDDING_RATE_KEY = `bedrock:${EMBEDDING_MODEL_ID}`;
export const agentCoreRateKey = (meter: AgentCoreMeter): string => `agentcore:${meter}`;
export const TRANSCRIBE_RATE_KEY = "transcribe:es-MX:perSecond";
export const SES_OUTBOUND_RATE_KEY = "ses:outbound";
export const SES_ATTACHMENTS_RATE_KEY = "ses:attachmentsGb";
export const whatsappRateKey = (pricing: WhatsAppPricing, country = "MX"): string => `whatsapp:${country}:${pricing}`;
/** Only for generating the synthetic voice notes (`seed:voices`), never part of a conversation. */
export const POLLY_RATE_KEY = "polly:neural";

// What a quantity measures, and how many base units one priced unit holds: a price "per 1M tokens"
// divides a token count by a million, a price "per minute" divides seconds by 60.
const UNITS = {
  PER_1K_TOKENS: { measure: "tokens", size: 1_000 },
  PER_1M_TOKENS: { measure: "tokens", size: 1_000_000 },
  PER_REQUEST: { measure: "requests", size: 1 },
  PER_1K_REQUESTS: { measure: "requests", size: 1_000 },
  PER_MESSAGE: { measure: "messages", size: 1 },
  PER_1K_MESSAGES: { measure: "messages", size: 1_000 },
  PER_SECOND: { measure: "seconds", size: 1 },
  PER_MINUTE: { measure: "seconds", size: 60 },
  PER_HOUR: { measure: "seconds", size: 3_600 },
  PER_GB: { measure: "bytes", size: 1_073_741_824 },
  PER_1M_CHARACTERS: { measure: "characters", size: 1_000_000 },
} as const;

/** Price per unit, always in USD. */
export const RateUnit = z.enum(Object.keys(UNITS) as [keyof typeof UNITS, ...Array<keyof typeof UNITS>]);
export type RateUnit = z.infer<typeof RateUnit>;
export type Measure = (typeof UNITS)[RateUnit]["measure"];

export const RateCardRow = z
  .object({
    key: z.string().regex(/^[a-z]+:[A-Za-z0-9._-]+(?::[A-Za-z]+)?$/, "expected <service>:<scope>[:<kind>]"),
    price: z.number().nonnegative().nullable(),
    unit: RateUnit,
    /** Official pricing page the price was read from. A seeded provisional row has none (absent reads as null). */
    source: z.string().min(1).nullish().transform((value) => value ?? null),
    asOf: CalendarDate.nullish().transform((value) => value ?? null),
    provisional: z.boolean(),
  })
  .superRefine((row, ctx) => {
    // Seed invariant 13: a row that is not provisional has price, source and date.
    if (row.provisional) return;
    for (const field of ["price", "source", "asOf"] as const) {
      if (row[field] === null) ctx.addIssue({ code: "custom", path: [field], message: `a verified rate needs ${field}` });
    }
  });
export type RateCardRow = z.infer<typeof RateCardRow>;

const Count = z.number().int().nonnegative();
const TokenCounts = z.object({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count }).strict();
export type TokenCounts = z.infer<typeof TokenCounts>;

/** What one work order consumed (`CuadrillaMetrics` ConversationKpi, docs/architecture.md §5). */
export const ConversationUsage = z
  .object({
    /** Tokens by model id: the Harness turns and the photo validations (both Claude by default). */
    models: z.record(z.string().min(1), TokenCounts),
    embeddingTokens: Count,
    agentCore: z.object({ gateway: Count, memoryEvents: Count, memoryRecords: Count, harness: Count }).strict(),
    transcribeSeconds: z.number().nonnegative(),
    emails: Count,
    attachmentBytes: Count,
    whatsapp: z.object({ utility: Count, service: Count }).strict(),
  })
  .strict();
export type ConversationUsage = z.infer<typeof ConversationUsage>;

interface Quantity {
  readonly key: string;
  readonly measure: Measure;
  readonly quantity: number;
}

function quantities(usage: ConversationUsage): Quantity[] {
  return [
    ...Object.entries(usage.models).flatMap(([modelId, tokens]) => TokenKind.options.map((kind) => ({ key: bedrockRateKey(kind, modelId), measure: "tokens" as const, quantity: tokens[kind] }))),
    { key: EMBEDDING_RATE_KEY, measure: "tokens", quantity: usage.embeddingTokens },
    // The Harness meter counts the seconds its turns ran; the rest count requests (tool calls,
    // memory events written, memory records read).
    ...AgentCoreMeter.options.map((meter) => ({ key: agentCoreRateKey(meter), measure: meter === "harness" ? ("seconds" as const) : ("requests" as const), quantity: usage.agentCore[meter] })),
    { key: TRANSCRIBE_RATE_KEY, measure: "seconds", quantity: usage.transcribeSeconds },
    { key: SES_OUTBOUND_RATE_KEY, measure: "messages", quantity: usage.emails },
    { key: SES_ATTACHMENTS_RATE_KEY, measure: "bytes", quantity: usage.attachmentBytes },
    ...WhatsAppPricing.options.map((pricing) => ({ key: whatsappRateKey(pricing), measure: "messages" as const, quantity: usage.whatsapp[pricing] })),
  ];
}

export interface CostLine {
  readonly key: string;
  readonly quantity: number;
  readonly unit: RateUnit;
  readonly price: number;
  readonly usd: number;
}

export type ConversationCost =
  | { readonly status: "VERIFIED"; readonly usd: number; readonly lines: readonly CostLine[]; readonly whatsappPricedAsLive: boolean }
  /** Some line has no verified rate (or one in a unit of another measure): no total is shown. */
  | { readonly status: "UNVERIFIED"; readonly missingRates: readonly string[]; readonly whatsappPricedAsLive: boolean };

export interface CostOptions {
  /** WhatsApp ran `simulated`: messages are still priced as live ones, and labelled so. */
  readonly whatsappSimulated: boolean;
}

// Money in USD is rounded to micro-dollars: a turn costs cents, a conversation a few dollars.
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Prices a conversation. Only lines with a quantity need a rate; one without a verified rate makes the whole cost unverified. */
export function conversationCost(usage: ConversationUsage, rows: readonly unknown[], options: CostOptions): ConversationCost {
  const parsed = ConversationUsage.parse(usage);
  const rates = new Map(z.array(RateCardRow).parse(rows).map((row) => [row.key, row] as const));
  const whatsappPricedAsLive = options.whatsappSimulated && parsed.whatsapp.utility + parsed.whatsapp.service > 0;
  const lines: CostLine[] = [];
  const missingRates: string[] = [];
  for (const { key, measure, quantity } of quantities(parsed)) {
    if (quantity === 0) continue;
    const rate = rates.get(key);
    if (rate === undefined || rate.provisional || rate.price === null || UNITS[rate.unit].measure !== measure) {
      missingRates.push(key);
      continue;
    }
    lines.push({ key, quantity, unit: rate.unit, price: rate.price, usd: roundUsd((quantity / UNITS[rate.unit].size) * rate.price) });
  }
  if (missingRates.length > 0) return { status: "UNVERIFIED", missingRates, whatsappPricedAsLive };
  return { status: "VERIFIED", usd: roundUsd(lines.reduce((sum, line) => sum + line.usd, 0)), lines, whatsappPricedAsLive };
}

/** Whether a verified cost passes the operator's threshold (`IspSettings.costBudgetUsdPerConversation`). */
export function exceedsBudget(cost: ConversationCost, budgetUsd: number | undefined): boolean {
  return cost.status === "VERIFIED" && budgetUsd !== undefined && cost.usd > budgetUsd;
}

/** True while any row is provisional: the metrics view labels every cost "sin tarifa verificada". */
export function hasProvisionalRates(rows: readonly unknown[]): boolean {
  return z.array(RateCardRow).parse(rows).some((row) => row.provisional);
}

/** Every row `RATECARD` holds (docs/seed-spec.md §12), in that order: the seed writes exactly these keys. */
export const RATE_CARD_KEYS: readonly string[] = [
  ...TokenKind.options.map((kind) => bedrockRateKey(kind)),
  EMBEDDING_RATE_KEY,
  ...AgentCoreMeter.options.map(agentCoreRateKey),
  TRANSCRIBE_RATE_KEY,
  SES_OUTBOUND_RATE_KEY,
  SES_ATTACHMENTS_RATE_KEY,
  ...WhatsAppPricing.options.map((pricing) => whatsappRateKey(pricing)),
  POLLY_RATE_KEY,
];
