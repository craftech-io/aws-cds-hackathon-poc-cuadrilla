// Guardrail G2 on the way out (docs/design-brief.md §5.5, docs/architecture.md §9.4, ADR-0028):
// `ApplyGuardrail` with source OUTPUT over every free text the agent wrote (and a case summary it
// wrote), with
//
//   grounding_source  the redacted tool results of the turn (`Runtime/TURN#`, the passages of
//                     `search_procedures` included), one JSON line each, clipped from the oldest side
//   query             for a `REPLY`, `groundingQuery` of agent/grounding.ts over the installer's text
//                     (the fixed status question when the text asks nothing: "hola", "ok", "gracias");
//                     for any other kind, a fixed question of the kind
//   guard_content     the text, which must fit the content limit whole (never half-checked)
//
// The verdict applies the thresholds of `GuardrailG2` itself: grounding always, relevance only for a
// `REPLY`, and any block of G1's denied topics on output. A failed call fails closed: nothing leaves
// without G2. The Bedrock runtime client of `ApplyGuardrail` (timeouts, retries, error mapping) of the
// pipeline lives here and in g3.ts.
import { ApplyGuardrailCommand, type ApplyGuardrailCommandOutput, BedrockRuntimeClient, type GuardrailAssessment, type GuardrailContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import type { MessageKind } from "@cuadrilla/shared";
import { type G2RefusalReason, STATUS_QUESTION, groundingQuery } from "../agent/grounding";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";

/** `Resource.GuardrailG2` (infra/guardrail.ts): the published version, its thresholds and its input limits. */
export const G2Config = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  groundingThreshold: z.number().min(0).max(1),
  relevanceThreshold: z.number().min(0).max(1),
  queryMaxChars: z.number().int().positive(),
  groundingSourceMaxChars: z.number().int().positive(),
  contentMaxChars: z.number().int().positive(),
});
export type G2Config = z.infer<typeof G2Config>;

export function linkedG2Config(): G2Config {
  return readLinked("GuardrailG2", G2Config);
}

export interface G2Input {
  readonly kind: MessageKind;
  readonly text: string;
  readonly groundingSource: string;
  readonly query: string;
}

export interface G2Verdict {
  readonly action: "NONE" | "BLOCKED";
  readonly groundingScore?: number;
  readonly relevanceScore?: number;
  readonly failure?: G2RefusalReason;
  readonly groundingThreshold: number;
  readonly relevanceThreshold: number;
}

export interface OutputGuardrail {
  check(input: G2Input): Promise<G2Verdict>;
}

export class GuardrailUnavailableError extends Error {
  override readonly name = "GuardrailUnavailableError";
}

// ---- What G2 reads -------------------------------------------------------------------------------

/** One JSON line per tool result of the turn, clipped from the oldest side. */
export function groundingSourceOf(results: readonly { readonly tool: string; readonly output: unknown }[], maxChars: number): string {
  const text = results.map((result) => JSON.stringify({ tool: result.tool, output: result.output })).join("\n");
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** What a message that answers no question is about, in the words relevance would be scored against. */
const KIND_QUERIES: Readonly<Partial<Record<MessageKind, string>>> = {
  ORDERS_DETAIL: "¿Cuáles son mis órdenes de hoy y a qué hora es cada una?",
  CASE_BRIEF: "¿Qué pasó en esta orden y por qué se escaló el caso?",
  ZONE_CHIEF_ALERT: "¿Qué pasó en esta orden y por qué se escaló el caso?",
};

/** The `query` of G2: the installer's text (or the status question) for a `REPLY`, the kind's question otherwise. */
export function queryOf(kind: MessageKind, question: string | undefined, maxChars: number): string {
  const asked = question?.trim() ?? "";
  const query = kind !== "REPLY" ? (KIND_QUERIES[kind] ?? STATUS_QUESTION.es) : asked === "" ? STATUS_QUESTION.es : groundingQuery(asked, "es");
  return query.slice(0, maxChars);
}

export function contentBlocks(input: G2Input, config: Pick<G2Config, "queryMaxChars" | "groundingSourceMaxChars">): GuardrailContentBlock[] {
  return [
    { text: { text: input.groundingSource.slice(-config.groundingSourceMaxChars) || "{}", qualifiers: ["grounding_source"] } },
    { text: { text: input.query.slice(0, config.queryMaxChars) || "-", qualifiers: ["query"] } },
    { text: { text: input.text, qualifiers: ["guard_content"] } },
  ];
}

// ---- The verdict ---------------------------------------------------------------------------------

function scoreOf(assessments: readonly GuardrailAssessment[], type: "GROUNDING" | "RELEVANCE"): number | undefined {
  let score: number | undefined;
  for (const assessment of assessments) {
    for (const filter of assessment.contextualGroundingPolicy?.filters ?? []) {
      if (filter.type === type && filter.score !== undefined) score = score === undefined ? filter.score : Math.min(score, filter.score);
    }
  }
  return score;
}

/** A block of any policy other than contextual grounding: G1's denied topics and words on output. */
function blockedByPolicy(assessments: readonly GuardrailAssessment[]): boolean {
  return assessments.some(
    (assessment) =>
      (assessment.topicPolicy?.topics ?? []).some((topic) => topic.action === "BLOCKED") ||
      (assessment.wordPolicy?.customWords ?? []).some((word) => word.action === "BLOCKED") ||
      (assessment.wordPolicy?.managedWordLists ?? []).some((word) => word.action === "BLOCKED") ||
      (assessment.contentPolicy?.filters ?? []).some((filter) => filter.action === "BLOCKED") ||
      (assessment.sensitiveInformationPolicy?.piiEntities ?? []).some((entity) => entity.action === "BLOCKED") ||
      (assessment.sensitiveInformationPolicy?.regexes ?? []).some((regex) => regex.action === "BLOCKED"),
  );
}

export function verdictOf(response: Pick<ApplyGuardrailCommandOutput, "action" | "assessments">, kind: MessageKind, config: Pick<G2Config, "groundingThreshold" | "relevanceThreshold">): G2Verdict {
  const assessments = response.assessments ?? [];
  const groundingScore = scoreOf(assessments, "GROUNDING");
  const relevanceScore = scoreOf(assessments, "RELEVANCE");
  const base = {
    groundingThreshold: config.groundingThreshold,
    relevanceThreshold: config.relevanceThreshold,
    ...(groundingScore === undefined ? {} : { groundingScore }),
    ...(relevanceScore === undefined ? {} : { relevanceScore }),
  };
  if (response.action === "GUARDRAIL_INTERVENED" && blockedByPolicy(assessments)) return { ...base, action: "BLOCKED", failure: "BLOCKED" };
  // A grounding check that returned no score checked nothing: fail closed.
  if (groundingScore === undefined || groundingScore < config.groundingThreshold) return { ...base, action: "BLOCKED", failure: "GROUNDING" };
  if (kind === "REPLY" && (relevanceScore === undefined || relevanceScore < config.relevanceThreshold)) return { ...base, action: "BLOCKED", failure: "RELEVANCE" };
  return { ...base, action: "NONE" };
}

// ---- Bedrock -------------------------------------------------------------------------------------

const RETRYABLE = new Set(["ThrottlingException", "ServiceUnavailableException", "InternalServerException", "ServiceQuotaExceededException"]);

export function isRetryableBedrock(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return RETRYABLE.has(name) || (typeof error === "object" && error !== null && "$retryable" in error);
}

let client: BedrockRuntimeClient | undefined;

/** The Bedrock runtime client of `ApplyGuardrail` (G2 and G3), one per container. */
export function guardrailRuntimeClient(): BedrockRuntimeClient {
  client ??= new BedrockRuntimeClient(awsClientConfig(CLIENT_TIMEOUTS.guardrail));
  return client;
}

export interface BedrockG2Deps {
  readonly client: Pick<BedrockRuntimeClient, "send">;
  readonly config: () => G2Config;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createBedrockG2(deps: BedrockG2Deps): OutputGuardrail {
  return {
    async check(input) {
      const config = deps.config();
      const thresholds = { groundingThreshold: config.groundingThreshold, relevanceThreshold: config.relevanceThreshold };
      if (input.text.length > config.contentMaxChars) return { ...thresholds, action: "BLOCKED", failure: "TOO_LONG" };
      const command = new ApplyGuardrailCommand({ guardrailIdentifier: config.id, guardrailVersion: config.version, source: "OUTPUT", content: contentBlocks(input, config) });
      try {
        const response = await withRetry(() => deps.client.send(command), { attempts: 2, shouldRetry: isRetryableBedrock, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
        return verdictOf(response, input.kind, config);
      } catch (error) {
        throw new GuardrailUnavailableError("ApplyGuardrail (G2) failed", { cause: error });
      }
    },
  };
}
