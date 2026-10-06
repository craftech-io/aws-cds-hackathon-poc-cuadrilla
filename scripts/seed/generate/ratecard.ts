// `Reference/RATECARD` (docs/seed-spec.md §12, ADR-0019): one row per priced resource of
// services/ratecard (`RATE_CARD_KEYS`, the one list of keys), with its unit. The four token rows of the
// default model are verified (MODEL_RATES of services/ratecard: price, AWS Price List source and date,
// ADR-0028). The rest are seeded provisional and without price, source or date: WP-49 loads the
// official prices, each with the pricing page it was read from and the date (invariant 13: a row that
// is not provisional has all three). Until then the cost per conversation says it has no verified rate
// instead of showing a number.
//
// WhatsApp follows Meta's per-message pricing in force since 2025-07-01: `utility` is a template
// delivered outside an open window, `service` a message inside it, which Meta charges from
// 2026-10-01 (before that date, zero).
import {
  EMBEDDING_RATE_KEY,
  MODEL_RATES,
  POLLY_RATE_KEY,
  RATE_CARD_KEYS,
  type RateUnit,
  SES_ATTACHMENTS_RATE_KEY,
  SES_OUTBOUND_RATE_KEY,
  TRANSCRIBE_RATE_KEY,
  TokenKind,
  agentCoreRateKey,
  bedrockRateKey,
  whatsappRateKey,
} from "../../../packages/bff/src/services/ratecard/ratecard";
import type { SeedItem } from "../lib/tables";
import { row } from "./context";

interface RateDef {
  readonly unit: RateUnit;
  readonly note: string;
}

const RATES: Readonly<Record<string, RateDef>> = {
  [bedrockRateKey("input")]: { unit: "PER_1M_TOKENS", note: "Harness turns and photo validations: input tokens" },
  [bedrockRateKey("output")]: { unit: "PER_1M_TOKENS", note: "Output tokens, thinking included" },
  [bedrockRateKey("cacheRead")]: { unit: "PER_1M_TOKENS", note: "Prompt cache reads" },
  [bedrockRateKey("cacheWrite")]: { unit: "PER_1M_TOKENS", note: "Prompt cache writes" },
  [EMBEDDING_RATE_KEY]: { unit: "PER_1M_TOKENS", note: "Query embeddings of the Knowledge Base" },
  [agentCoreRateKey("gateway")]: { unit: "PER_1K_REQUESTS", note: "Gateway tool invocations" },
  [agentCoreRateKey("memoryEvents")]: { unit: "PER_1K_REQUESTS", note: "Memory short-term events" },
  [agentCoreRateKey("memoryRecords")]: { unit: "PER_1K_REQUESTS", note: "Memory long-term records" },
  [agentCoreRateKey("harness")]: { unit: "PER_HOUR", note: "Harness runtime" },
  [TRANSCRIBE_RATE_KEY]: { unit: "PER_MINUTE", note: "Batch transcription, billed per second" },
  [SES_OUTBOUND_RATE_KEY]: { unit: "PER_1K_MESSAGES", note: "Outbound email" },
  [SES_ATTACHMENTS_RATE_KEY]: { unit: "PER_GB", note: "Attachment data (certificates)" },
  [whatsappRateKey("utility")]: { unit: "PER_MESSAGE", note: "Meta per-message pricing since 2025-07-01: utility template delivered outside an open window" },
  [whatsappRateKey("service")]: { unit: "PER_MESSAGE", note: "Messages inside the window; charged by Meta from 2026-10-01 (ADR-0019)" },
  [POLLY_RATE_KEY]: { unit: "PER_1M_CHARACTERS", note: "Only to generate the synthetic voice notes, never part of a conversation" },
};

/** Price, source and date of a verified row: the token rows of the default model (ADR-0028). */
const VERIFIED: ReadonlyMap<string, { readonly price: number; readonly source: string; readonly asOf: string }> = new Map(
  TokenKind.options.map((kind) => [bedrockRateKey(kind), { price: MODEL_RATES.prices[kind], source: MODEL_RATES.source, asOf: MODEL_RATES.asOf }] as const),
);

export function rateCardItems(): SeedItem[] {
  return RATE_CARD_KEYS.map((key) => {
    const rate = RATES[key];
    if (rate === undefined) throw new RangeError(`no unit for rate ${key}`);
    const verified = VERIFIED.get(key);
    if (verified !== undefined) return row("RateCard", { key, ...verified, unit: rate.unit, provisional: false, note: rate.note });
    return row("RateCard", { key, price: null, unit: rate.unit, provisional: true, note: rate.note });
  });
}
