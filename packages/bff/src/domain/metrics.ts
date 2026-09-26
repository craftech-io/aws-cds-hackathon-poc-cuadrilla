// `CuadrillaMetrics` table (docs/architecture.md §5, docs/design-brief.md §8): one KPI row per
// conversation (order) and one result per evaluation item. Every KPI says where it came from
// (`source`, `agentMode`) so the console labels it and never mixes a scripted run with a real one.
import { z } from "zod";
import { ClockId, IspId, WorkOrderId } from "@cuadrilla/shared";
import { JsonObject, defineEntity } from "./common";

export const MetricSource = z.enum(["WORLD", "EVAL"]);
export type MetricSource = z.infer<typeof MetricSource>;

export const AgentMode = z.enum(["REAL", "SCRIPTED"]);
export type AgentMode = z.infer<typeof AgentMode>;

/** Samples kept per conversation (enough for p50/p95 over a demo order). */
export const KPI_SAMPLE_LIMIT = 200;

export const ConversationKpi = defineEntity("ConversationKpi", {
  ispId: IspId,
  clockId: ClockId,
  workOrderId: WorkOrderId,
  source: MetricSource,
  runId: z.string().min(1).max(128).optional(),
  agentMode: AgentMode,
  turns: z.int().min(0).default(0),
  firstReplyLatenciesMs: z.array(z.int().min(0)).default([]),
  turnLatenciesMs: z.array(z.int().min(0)).default([]),
  inputTokens: z.int().min(0).default(0),
  outputTokens: z.int().min(0).default(0),
  validations: z.int().min(0).default(0),
  transcribeSec: z.number().min(0).default(0),
  emails: z.int().min(0).default(0),
  whatsappMessages: z.int().min(0).default(0),
  costUsd: z.number().min(0).optional(),
  costBreakdown: z.record(z.string(), z.number()).optional(),
});
export type ConversationKpi = z.infer<typeof ConversationKpi>;

/** Numeric fields of a KPI row that add up (`addToKpi`). */
export const KPI_COUNTERS = ["turns", "inputTokens", "outputTokens", "validations", "transcribeSec", "emails", "whatsappMessages"] as const;
export type KpiCounter = (typeof KPI_COUNTERS)[number];

/** Result of one question (`Q`) of `EV-01` or one photo (`P`) of `EV-02`. */
export const EvalResult = defineEntity("EvalResult", {
  ispId: IspId,
  runId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/),
  kind: z.enum(["Q", "P"]),
  itemId: z.string().regex(/^(?:q-[AR]-\d{2}|ph-[a-z0-9-]{2,60})$/),
  clockId: ClockId.optional(),
  outcome: z.string().min(1).max(64),
  passed: z.boolean(),
  score: z.number().optional(),
  latencyMs: z.int().min(0).optional(),
  inputTokens: z.int().min(0).optional(),
  outputTokens: z.int().min(0).optional(),
  details: JsonObject.default({}),
});
export type EvalResult = z.infer<typeof EvalResult>;
