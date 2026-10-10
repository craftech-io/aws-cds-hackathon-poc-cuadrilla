// Verified rate card (WP-49, docs/seed-spec.md §12 `RATECARD`, ADR-0019, invariant 13): every row of
// `Reference/RATECARD` (the keys of services/ratecard `RATE_CARD_KEYS`) with its price, the official
// source it was read from and the day it was read. AWS prices come from the AWS Price List, the
// machine-readable feed behind the official pricing pages, for us-east-1; each row keeps the price-list
// lines it adds up (offer, usage type, publication date of the offer file), so a reviewer finds them
// again. Where the feed lags an announced change, the row says which official page it follows:
//
//   - Sonnet 5.5 cache reads: halved from 2026-10-07 (USD 0.10 per million, Standard, Global).
//   - WhatsApp: Meta charges the messages inside the window from 2026-10-01 at the market's utility
//     rate; the feed of 2026-09-16 still lists them at 0. AWS adds its own fee to every outbound message.
//   - AgentCore Memory: short-term ingestion is billed per GB from 2026-10-06; the meter counts events,
//     so the row prices an event at its largest message (100 KB), a ceiling.
//   - The Harness has no fee of its own: its Runtime bills active CPU and peak memory per second. The
//     meter counts the wall-clock seconds of a turn, so the row prices them at the session maximum
//     (2 vCPU, 8 GB) at the higher v2 rates, a ceiling.
//
// The same rows price the estimates below (docs/test-plan.md §4.4 and §7, ADR-0019) through
// `conversationCost`, the function the console prices a conversation with.
//
//   tsx scripts/seed/generate/ratecard.ts    prints the card and the estimates; fails if the committed
//                                            seed does not carry the card (then: npm run seed:generate)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  type ConversationUsage,
  DEFAULT_MODEL_ID,
  EMBEDDING_RATE_KEY,
  MODEL_RATES,
  POLLY_RATE_KEY,
  RATE_CARD_KEYS,
  type RateCardRow,
  type RateUnit,
  SES_ATTACHMENTS_RATE_KEY,
  SES_OUTBOUND_RATE_KEY,
  TRANSCRIBE_RATE_KEY,
  agentCoreRateKey,
  bedrockRateKey,
  conversationCost,
  whatsappRateKey,
} from "../../../packages/bff/src/services/ratecard/ratecard";
import { DATA_DIR, fromRoot, tableFile } from "../lib/paths";
import type { SeedItem } from "../lib/tables";
import { row } from "./context";

/** Day every price below was read. */
export const RATE_CARD_AS_OF = "2026-10-10";

const PRICE_LIST = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";
const offerUrl = (offer: string): string => `${PRICE_LIST}/${offer}/current/us-east-1/index.json`;
const AGENTCORE_PAGE = "https://aws.amazon.com/bedrock/agentcore/pricing/";
const EUM_PAGE = "https://aws.amazon.com/end-user-messaging/pricing/";
const META_SERVICE_PAGE = "https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages";

/** One line a rate adds up, already in the row's unit. */
export interface PriceLine {
  readonly source: string;
  /** Usage type of the AWS Price List line, or what the page states. */
  readonly item: string;
  readonly usd: number;
  /** `publicationDate` of the offer file, or the day the page states the price from. */
  readonly publishedAt: string;
}

export interface VerifiedRate {
  readonly key: string;
  readonly unit: RateUnit;
  readonly source: string;
  readonly note: string;
  readonly lines: readonly PriceLine[];
}

const PUBLISHED = {
  AmazonBedrockFoundationModels: "2026-10-08",
  AmazonBedrock: "2026-10-06",
  AmazonBedrockAgentCore: "2026-10-06",
  transcribe: "2026-09-11",
  AmazonSES: "2026-09-11",
  AmazonPinpoint: "2026-09-15",
  AWSEndUserMessaging3pFees: "2026-09-16",
  AmazonPolly: "2026-09-11",
} as const;
type Offer = keyof typeof PUBLISHED;

/** A Price List line: `usdPerUsageUnit` times how many usage units one priced unit holds. */
function line(offer: Offer, usageType: string, usdPerUsageUnit: number, perUnit = 1): PriceLine {
  return { source: offerUrl(offer), item: usageType, usd: usdPerUsageUnit * perUnit, publishedAt: PUBLISHED[offer] };
}

function rate(key: string, unit: RateUnit, note: string, lines: readonly PriceLine[], source = lines[0]?.source ?? ""): VerifiedRate {
  return { key, unit, source, note, lines };
}

const SONNET = (usageType: string, usd: number): PriceLine => line("AmazonBedrockFoundationModels", `USE1-MP:USE1_${usageType}_tokens_global_standard-Units`, usd);
const GB_PER_100KB = 100_000 / 1_073_741_824;
const META_UTILITY_MX = line("AWSEndUserMessaging3pFees", "USE1-WhatsApp-MX-ConversationFee-Utility", 0.0067);
const AWS_WHATSAPP_FEE_MX = line("AmazonPinpoint", "USE1-WhatsApp-MX-MessageFee-Standard", 0.005);

export const VERIFIED_RATES: readonly VerifiedRate[] = [
  rate(bedrockRateKey("input"), "PER_1M_TOKENS", "Claude Sonnet 5.5, Standard, Global: input tokens of Harness turns and photo validations", [SONNET("input", MODEL_RATES.prices.input)]),
  rate(bedrockRateKey("output"), "PER_1M_TOKENS", "Claude Sonnet 5.5, Standard, Global: output tokens, thinking included", [SONNET("output", MODEL_RATES.prices.output)]),
  rate(bedrockRateKey("cacheRead"), "PER_1M_TOKENS", "Claude Sonnet 5.5, Standard, Global: prompt cache reads (halved from 2026-10-07)", [SONNET("cache_read", MODEL_RATES.prices.cacheRead)]),
  rate(bedrockRateKey("cacheWrite"), "PER_1M_TOKENS", "Claude Sonnet 5.5, Standard, Global: prompt cache writes with the 5-minute TTL", [SONNET("cache_write", MODEL_RATES.prices.cacheWrite)]),
  rate(EMBEDDING_RATE_KEY, "PER_1M_TOKENS", "Titan Text Embeddings v2: the query embedding of each Knowledge Base search", [line("AmazonBedrock", "USE1-TitanEmbeddingV2-Text-input-tokens", 0.00002, 1_000)]),
  rate(agentCoreRateKey("gateway"), "PER_1K_REQUESTS", "Gateway API invocations (InvokeTool, ListTools)", [line("AmazonBedrockAgentCore", "USE1-Gateway:Consumption-based:API-Invocations", 0.000005, 1_000)]),
  rate(
    agentCoreRateKey("memoryEvents"),
    "PER_1K_REQUESTS",
    "Memory short-term events: no fee per event; ingestion at USD 1.00 per GB from 2026-10-06, priced at the 100 KB largest message (ceiling)",
    [
      line("AmazonBedrockAgentCore", "USE1-Memory:Consumption-based:Short-Term-Memory", 0, 1_000),
      { source: AGENTCORE_PAGE, item: "Memory short-term ingestion, USD 1.00 per GB, at 100 KB per event", usd: 1 * GB_PER_100KB * 1_000, publishedAt: "2026-10-06" },
    ],
    AGENTCORE_PAGE,
  ),
  rate(agentCoreRateKey("memoryRecords"), "PER_1K_REQUESTS", "Memory long-term records retrieved (storage per record-month is not part of a conversation)", [line("AmazonBedrockAgentCore", "USE1-Memory:Consumption-based:Long-Term-Memory-Retrieval", 0.0005, 1_000)]),
  rate(agentCoreRateKey("harness"), "PER_HOUR", "Harness Runtime per wall-clock hour of its turns, at the 2 vCPU / 8 GB session maximum and the v2 rates (ceiling; no Harness fee)", [
    line("AmazonBedrockAgentCore", "USE1-Runtime:Consumption-based:vCPU-v2", 0.1276, 2),
    line("AmazonBedrockAgentCore", "USE1-Runtime:Consumption-based:Memory-v2", 0.0169, 8),
  ]),
  rate(TRANSCRIBE_RATE_KEY, "PER_MINUTE", "Batch transcription, billed per second without minimum; the custom vocabulary is included", [line("transcribe", "USE1-TranscribeAudio", 0.0001, 60)]),
  rate(SES_OUTBOUND_RATE_KEY, "PER_1K_MESSAGES", "Outbound email per recipient (the mailbox simulator is billed alike)", [line("AmazonSES", "Recipients", 0.0001, 1_000)]),
  rate(SES_ATTACHMENTS_RATE_KEY, "PER_GB", "Attachment data (certificates)", [line("AmazonSES", "AttachmentsSize-Bytes", 0.12)]),
  rate(whatsappRateKey("utility"), "PER_MESSAGE", "Utility template to Mexico: AWS fee per outbound message plus Meta's utility fee", [AWS_WHATSAPP_FEE_MX, META_UTILITY_MX], EUM_PAGE),
  rate(
    whatsappRateKey("service"),
    "PER_MESSAGE",
    "Message inside the window to Mexico: AWS fee plus Meta's fee, charged from 2026-10-01 at the market's utility rate (ADR-0019)",
    [AWS_WHATSAPP_FEE_MX, { ...META_UTILITY_MX, source: META_SERVICE_PAGE, item: "Meta service message, Mexico: same rate as utility from 2026-10-01", publishedAt: "2026-10-01" }],
    META_SERVICE_PAGE,
  ),
  rate(POLLY_RATE_KEY, "PER_1M_CHARACTERS", "Neural voices: only to generate the synthetic voice notes, never part of a conversation", [line("AmazonPolly", "USE1-SynthesizeSpeechNeural-Characters", 0.000016, 1_000_000)]),
];

// Prices are rounded to micro-dollars, like the costs `conversationCost` returns.
const micro = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

export function priceOf(verified: VerifiedRate): number {
  return micro(verified.lines.reduce((sum, priced) => sum + priced.usd, 0));
}

/** The `Reference/RATECARD` rows, in the order of `RATE_CARD_KEYS`: all verified (invariant 13). */
export function rateCardItems(): SeedItem[] {
  return RATE_CARD_KEYS.map((key) => {
    const verified = VERIFIED_RATES.find((candidate) => candidate.key === key);
    if (verified === undefined) throw new RangeError(`no verified rate for ${key}`);
    return row("RateCard", { key, price: priceOf(verified), unit: verified.unit, source: verified.source, asOf: RATE_CARD_AS_OF, provisional: false, note: verified.note });
  });
}

/** The same rows as `conversationCost` reads them. */
export function rateCardRows(): RateCardRow[] {
  return VERIFIED_RATES.map((verified) => ({ key: verified.key, price: priceOf(verified), unit: verified.unit, source: verified.source, asOf: RATE_CARD_AS_OF, provisional: false }));
}

// ---- Estimates (docs/test-plan.md §4.4 and §7, ADR-0019) ------------------------------------------

export interface Range {
  readonly min: number;
  readonly max: number;
}

/** One agent turn as docs/test-plan.md §7 sizes it, priced uncached: a ceiling, not a forecast. */
export const TURN = { inputTokens: { min: 30_000, max: 50_000 }, outputTokens: { min: 1_000, max: 3_000 } } as const;
/** One photo validation: about 2,500 input tokens with the image, low-effort thinking. */
export const VALIDATION = { inputTokens: 2_500, outputTokens: 1_500 } as const;
/**
 * The happy path of one work order (docs/test-plan.md §7: at most 12 turns): five evidence photos, one
 * voice note, three Gateway calls, two memory events and one memory read per turn, a turn of up to 30 s,
 * the day start template and one reply per turn plus the certificate, two emails with the PDF.
 */
export const HAPPY_PATH = { turns: 12, validations: 5, voiceSeconds: 15, searches: 4, emails: 2, certificateBytes: 400_000 } as const;
/** The "100 % probada" gate (docs/test-plan.md §7): three full suites and two measurement runs. */
export const GATE = { suites: 3, turnsPerSuite: 400, transcribeSecondsPerSuite: 1_200, questionRuns: 2, turnsPerQuestionRun: 150, photoRuns: 2, validationsPerPhotoRun: 60 } as const;

export interface Workload {
  readonly turns: number;
  readonly validations: number;
  readonly transcribeSeconds: number;
  readonly whatsapp?: { readonly utility: number; readonly service: number };
  readonly emails?: number;
  readonly attachmentBytes?: number;
  readonly searches?: number;
}

/** What a workload consumes with turns at the `min` or `max` end of TURN. */
export function usageOf(workload: Workload, end: "min" | "max"): ConversationUsage {
  const { turns, validations } = workload;
  return {
    models: {
      [DEFAULT_MODEL_ID]: {
        input: turns * TURN.inputTokens[end] + validations * VALIDATION.inputTokens,
        output: turns * TURN.outputTokens[end] + validations * VALIDATION.outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
    embeddingTokens: (workload.searches ?? 0) * 100,
    agentCore: { gateway: turns * 3, memoryEvents: turns * 2, memoryRecords: turns, harness: turns * 30 },
    transcribeSeconds: workload.transcribeSeconds,
    emails: workload.emails ?? 0,
    attachmentBytes: workload.attachmentBytes ?? 0,
    whatsapp: workload.whatsapp ?? { utility: 0, service: 0 },
  };
}

function usdOf(usage: ConversationUsage): number {
  const cost = conversationCost(usage, rateCardRows(), { whatsappSimulated: true });
  if (cost.status !== "VERIFIED") throw new Error(`rate card is missing ${cost.missingRates.join(", ")}`);
  return cost.usd;
}

export function costOf(workload: Workload): Range {
  return { min: usdOf(usageOf(workload, "min")), max: usdOf(usageOf(workload, "max")) };
}

export const HAPPY_PATH_WORKLOAD: Workload = {
  turns: HAPPY_PATH.turns,
  validations: HAPPY_PATH.validations,
  transcribeSeconds: HAPPY_PATH.voiceSeconds,
  whatsapp: { utility: 1, service: HAPPY_PATH.turns + 1 },
  emails: HAPPY_PATH.emails,
  attachmentBytes: HAPPY_PATH.emails * HAPPY_PATH.certificateBytes,
  searches: HAPPY_PATH.searches,
};

export const GATE_WORKLOAD: Workload = {
  turns: GATE.suites * GATE.turnsPerSuite + GATE.questionRuns * GATE.turnsPerQuestionRun,
  validations: GATE.photoRuns * GATE.validationsPerPhotoRun,
  transcribeSeconds: GATE.suites * GATE.transcribeSecondsPerSuite,
};

/**
 * Proposed threshold of the cost per conversation (`IspSettings.costBudgetUsdPerConversation`,
 * docs/test-plan.md §7): the happy path at its ceiling, plus half, rounded up to 10 cents. The CTO fixes it.
 */
export function proposedConversationBudgetUsd(): number {
  return Math.ceil(costOf(HAPPY_PATH_WORKLOAD).max * 1.5 * 10) / 10;
}

export interface DailyCeiling {
  readonly turnsPerDay: number;
  readonly validationsPerDay: number;
  readonly transcribeSecondsPerDay: number;
}

/** The most a real day can spend inside the stage's global ceiling (ADR-0019): every cap used up. */
export function ceilingDayCost(caps: DailyCeiling): Range {
  return costOf({ turns: caps.turnsPerDay, validations: caps.validationsPerDay, transcribeSeconds: caps.transcribeSecondsPerDay });
}

/** How many turns an hour reach the hourly agent-spend alarm, at the cheap and at the expensive end. */
export function turnsPerHourToAlarm(alarmUsdPerHour: number): Range {
  const turn = costOf({ turns: 1, validations: 0, transcribeSeconds: 0 });
  return { min: Math.floor(alarmUsdPerHour / turn.max), max: Math.floor(alarmUsdPerHour / turn.min) };
}

// ---- Drift and CLI ----------------------------------------------------------------------------------

const RATE_FIELDS = ["price", "unit", "source", "asOf", "provisional", "note"] as const;

/** Rows of a committed `Reference.json` that differ from the verified card (empty when in step). */
export function rateCardDrift(referenceItems: readonly SeedItem[]): string[] {
  const committed = new Map(referenceItems.filter((item) => item.entity === "RateCard").map((item) => [String(item.key), item] as const));
  const expected = rateCardItems();
  const problems = expected.flatMap((wanted) => {
    const found = committed.get(String(wanted.key));
    if (found === undefined) return [`RATECARD ${String(wanted.key)} is missing`];
    return RATE_FIELDS.filter((field) => found[field] !== wanted[field]).map((field) => `RATECARD ${String(wanted.key)} ${field} differs from the verified card`);
  });
  const extra = [...committed.keys()].filter((key) => !expected.some((wanted) => wanted.key === key)).map((key) => `RATECARD ${key} is not in the verified card`);
  return [...problems, ...extra];
}

const usd = (value: number): string => `USD ${value.toFixed(2)}`;
const span = (value: Range): string => `${usd(value.min)} - ${usd(value.max)}`;

export function report(options: { readonly ceiling: DailyCeiling; readonly alarmUsdPerHour: number; readonly projectBudgetUsdPerMonth: number }): string[] {
  const turn = costOf({ turns: 1, validations: 0, transcribeSeconds: 0 });
  const validation = costOf({ turns: 0, validations: 1, transcribeSeconds: 0 });
  const alarm = turnsPerHourToAlarm(options.alarmUsdPerHour);
  return [
    `rate card verified on ${RATE_CARD_AS_OF} (AWS Price List for us-east-1 and the pages each row names):`,
    ...VERIFIED_RATES.map((verified) => `  ${verified.key.padEnd(52)} ${String(priceOf(verified)).padStart(10)} USD ${verified.unit}`),
    `turn (${TURN.inputTokens.min}-${TURN.inputTokens.max} input + ${TURN.outputTokens.min}-${TURN.outputTokens.max} output tokens, uncached): USD ${turn.min.toFixed(4)} - ${turn.max.toFixed(4)}`,
    `photo validation: USD ${validation.max.toFixed(4)}`,
    `happy-path conversation (${HAPPY_PATH.turns} turns, ${HAPPY_PATH.validations} photos, WhatsApp priced as live): ${span(costOf(HAPPY_PATH_WORKLOAD))}`,
    `proposed costBudgetUsdPerConversation (for the CTO): ${usd(proposedConversationBudgetUsd())}`,
    `"100 % probada" gate (${GATE_WORKLOAD.turns} turns, ${GATE_WORKLOAD.validations} validations, ${GATE_WORKLOAD.transcribeSeconds / 60} min of audio): ${span(costOf(GATE_WORKLOAD))}`,
    `  one more full suite: ${span(costOf({ turns: GATE.turnsPerSuite, validations: 0, transcribeSeconds: GATE.transcribeSecondsPerSuite }))}`,
    `global ceiling, a day with every cap used up (${options.ceiling.turnsPerDay} turns, ${options.ceiling.validationsPerDay} validations, ${options.ceiling.transcribeSecondsPerDay} s): ${span(ceilingDayCost(options.ceiling))}`,
    `AgentSpendHourly alarm at ${usd(options.alarmUsdPerHour)} per hour: ${alarm.min} - ${alarm.max} turns in an hour`,
    `project budget: ${usd(options.projectBudgetUsdPerMonth)} per month`,
  ];
}

const CostCapsModule = z.object({
  costCaps: z.object({ turnsPerDay: z.number().int().nonnegative(), validationsPerDay: z.number().int().nonnegative(), transcribeSecondsPerDay: z.number().nonnegative() }),
});

async function main(): Promise<void> {
  // infra/cost-caps.ts builds an `sst.Linkable` at import (an SST global the scripts' program does not
  // type): outside SST a stand-in is enough to read its values, imported by URL and parsed.
  const scope = globalThis as { sst?: unknown };
  scope.sst ??= { Linkable: class {} };
  const { costCaps } = CostCapsModule.parse(await import(pathToFileURL(fromRoot("infra/cost-caps.ts")).href));
  const { AGENT_SPEND_ALARM_USD_PER_HOUR, PROJECT_BUDGET } = await import("../../../infra/observability-spec");
  for (const text of report({ ceiling: costCaps, alarmUsdPerHour: AGENT_SPEND_ALARM_USD_PER_HOUR, projectBudgetUsdPerMonth: PROJECT_BUDGET.limitUsdPerMonth })) console.log(text);
  const reference = JSON.parse(readFileSync(fromRoot(DATA_DIR, tableFile("Reference")), "utf8")) as { items: SeedItem[] };
  const drift = rateCardDrift(reference.items);
  if (drift.length > 0) {
    for (const problem of drift) console.error(`  ${problem}`);
    console.error("ratecard: the committed seed does not carry the verified rate card (run npm run seed:generate).");
    process.exit(1);
  }
  console.log("ratecard: the committed seed carries the verified rate card.");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
