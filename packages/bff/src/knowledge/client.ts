// Client of the manual's Knowledge Base (docs/architecture.md §9.5), the one module that calls
// `bedrock-agent-runtime:Retrieve`: `numberOfResults 5`, filtered by the manual version in force (and by
// category when asked), 8 s per attempt and 2 retries with backoff for what is worth retrying, and every
// failure mapped to an outcome instead of an exception. `search_procedures` reports `UNAVAILABLE` as
// `coverage: UNAVAILABLE` (FL-034), so the agent says it cannot read the manual now and offers to
// escalate. Faults are injected only in `qa-*` worlds (`Runtime/FAULTS#<clockId>.knowledge`, written by
// the `QaDriver`), never in a demo, guest or evaluation world.
//
// The query the model wrote is masked before it leaves (a phone or a document number the installer
// dictated never reaches the Knowledge Base) and never logged whole: only its length.
import { BedrockAgentRuntimeClient, RetrieveCommand, type RetrieveCommandInput, type RetrieveCommandOutput } from "@aws-sdk/client-bedrock-agent-runtime";
import { ManualCategory, ManualSectionId, VersionTag } from "@cuadrilla/shared";
import { z } from "zod";
import type { FaultSetting } from "../domain/runtime-world";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { DeadlineError, withDeadline } from "../lib/deadline";
import { createLogger, type Logger } from "../lib/log";
import { maskText } from "../lib/mask";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { mayHaveFaults } from "../network/faults";

/** Passages `Retrieve` returns (docs/tool-catalog.md `search_procedures`). */
export const NUMBER_OF_RESULTS = 5;
export const KNOWLEDGE_TIMEOUT_MS = CLIENT_TIMEOUTS.knowledgeBase.requestTimeoutMs;
export const KNOWLEDGE_RETRIES = 2;

/** Fault modes the `QaDriver` sets for the Knowledge Base (`knowledge.setFaults`). */
export const KNOWLEDGE_FAULTS = { unavailable: "ERROR_503", timeout: "TIMEOUT", empty: "EMPTY" } as const;

export type KnowledgeUnavailableReason = "THROTTLED" | "SERVICE_ERROR" | "TIMEOUT" | "ACCESS_DENIED" | "BAD_REQUEST" | "NOT_CONFIGURED" | "FAULT_INJECTED";

/** A chunk of the manual as the Knowledge Base returned it, with the metadata of its section. */
export interface RetrievedChunk {
  readonly sectionId: string;
  readonly title?: string;
  readonly manualVersion?: string;
  readonly category?: string;
  readonly text: string;
  readonly score: number;
}

export type RetrieveOutcome =
  | { readonly kind: "OK"; readonly chunks: readonly RetrievedChunk[]; readonly attempts: number }
  | { readonly kind: "UNAVAILABLE"; readonly reason: KnowledgeUnavailableReason; readonly attempts: number };

export interface RetrieveRequest {
  readonly clockId: string;
  readonly query: string;
  readonly manualVersion: string;
  readonly category?: ManualCategory;
  readonly logger?: Logger;
}

export interface KnowledgeClient {
  retrieve(request: RetrieveRequest): Promise<RetrieveOutcome>;
}

export type RetrieveSend = (input: RetrieveCommandInput, signal: AbortSignal) => Promise<RetrieveCommandOutput>;

export interface KnowledgeClientDeps {
  readonly send: RetrieveSend;
  /** Id of the linked Knowledge Base, read on first use. */
  readonly knowledgeBaseId: () => string;
  /** The `knowledge` fault of a `qa-*` world (called only where `mayHaveFaults` holds). */
  readonly fault: (clockId: string) => Promise<FaultSetting | undefined>;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

class RetrieveFailure extends Error {
  override readonly name = "RetrieveFailure";
  constructor(
    readonly reason: KnowledgeUnavailableReason,
    readonly retryable: boolean,
  ) {
    super(reason);
  }
}

const RETRYABLE_ERRORS = new Set(["ThrottlingException", "ServiceQuotaExceededException", "InternalServerException", "DependencyFailedException", "BadGatewayException", "ConflictException"]);

/** An SDK or transport error as the reason it means and whether another attempt may help. */
export function classifyRetrieveError(error: unknown): RetrieveFailure {
  if (error instanceof RetrieveFailure) return error;
  if (error instanceof DeadlineError) return new RetrieveFailure("TIMEOUT", true);
  const name = error instanceof Error ? error.name : "";
  if (name === "ThrottlingException" || name === "ServiceQuotaExceededException") return new RetrieveFailure("THROTTLED", true);
  if (RETRYABLE_ERRORS.has(name) || name === "TimeoutError" || name === "AbortError") return new RetrieveFailure(name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "SERVICE_ERROR", true);
  if (name === "AccessDeniedException") return new RetrieveFailure("ACCESS_DENIED", false);
  if (name === "ValidationException" || name === "ResourceNotFoundException") return new RetrieveFailure("BAD_REQUEST", false);
  return new RetrieveFailure("SERVICE_ERROR", true);
}

/** The sidecar attributes of a chunk (`metadataAttributes` of `<sectionId>.md.metadata.json`). */
const ChunkMetadata = z.looseObject({
  sectionId: ManualSectionId,
  title: z.string().min(1).max(200).optional(),
  manualVersion: VersionTag.optional(),
  category: ManualCategory.optional(),
});

/** Chunks with a section id of the manual; anything else in the answer is dropped. */
export function chunksOf(output: RetrieveCommandOutput): RetrievedChunk[] {
  const chunks: RetrievedChunk[] = [];
  for (const result of output.retrievalResults ?? []) {
    const metadata = ChunkMetadata.safeParse(result.metadata ?? {});
    const text = result.content?.text?.trim();
    if (!metadata.success || text === undefined || text === "" || typeof result.score !== "number") continue;
    const { sectionId, title, manualVersion, category } = metadata.data;
    chunks.push({ sectionId, text, score: result.score, ...(title === undefined ? {} : { title }), ...(manualVersion === undefined ? {} : { manualVersion }), ...(category === undefined ? {} : { category }) });
  }
  return chunks;
}

/** `filter` of the vector search: the version in force and, when asked, one category. */
export function retrievalFilter(manualVersion: string, category?: ManualCategory) {
  const version = { equals: { key: "manualVersion", value: manualVersion } };
  return category === undefined ? version : { andAll: [version, { equals: { key: "category", value: category } }] };
}

export function createKnowledgeClient(deps: KnowledgeClientDeps): KnowledgeClient {
  const timeoutMs = deps.timeoutMs ?? KNOWLEDGE_TIMEOUT_MS;
  const attempts = 1 + (deps.retries ?? KNOWLEDGE_RETRIES);
  const baseLogger = deps.logger ?? createLogger({ bindings: { component: "knowledge-client" } });

  // Faults exist only in qa-* worlds; an unreadable fault never fails the call itself.
  async function faultOf(clockId: string, log: Logger): Promise<FaultSetting | undefined> {
    if (!mayHaveFaults(clockId)) return undefined;
    try {
      return await deps.fault(clockId);
    } catch (error) {
      log.warn("knowledge.faults_unreadable", { clockId, error });
      return undefined;
    }
  }

  return {
    async retrieve(request) {
      const log = (request.logger ?? baseLogger).child({ component: "knowledge-client", clockId: request.clockId });
      const fault = await faultOf(request.clockId, log);
      if (fault === KNOWLEDGE_FAULTS.empty) return { kind: "OK", chunks: [], attempts: 0 };
      if (fault !== undefined) {
        log.warn("knowledge.unavailable", { reason: "FAULT_INJECTED", fault: typeof fault === "string" ? fault : "DETAILED" });
        return { kind: "UNAVAILABLE", reason: fault === KNOWLEDGE_FAULTS.timeout ? "TIMEOUT" : "FAULT_INJECTED", attempts: 0 };
      }
      let knowledgeBaseId: string;
      try {
        knowledgeBaseId = deps.knowledgeBaseId();
      } catch (error) {
        log.error("knowledge.not_configured", { error });
        return { kind: "UNAVAILABLE", reason: "NOT_CONFIGURED", attempts: 0 };
      }
      const input: RetrieveCommandInput = {
        knowledgeBaseId,
        retrievalQuery: { text: maskText(request.query) },
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: NUMBER_OF_RESULTS, filter: retrievalFilter(request.manualVersion, request.category) } },
      };
      let tries = 0;
      try {
        const output = await withRetry(
          async (attempt) => {
            tries = attempt + 1;
            try {
              return await withDeadline("knowledge.retrieve", timeoutMs, (signal) => deps.send(input, signal));
            } catch (error) {
              throw classifyRetrieveError(error);
            }
          },
          {
            attempts,
            baseDelayMs: 200,
            maxDelayMs: 1_000,
            shouldRetry: (error) => error instanceof RetrieveFailure && error.retryable,
            ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
            ...(deps.random === undefined ? {} : { random: deps.random }),
          },
        );
        const chunks = chunksOf(output);
        log.info("knowledge.retrieved", { queryLength: request.query.length, manualVersion: request.manualVersion, category: request.category, results: chunks.length, attempts: tries });
        return { kind: "OK", chunks, attempts: tries };
      } catch (error) {
        const failure = classifyRetrieveError(error);
        const level = failure.reason === "ACCESS_DENIED" || failure.reason === "BAD_REQUEST" ? "error" : "warn";
        log[level]("knowledge.unavailable", { reason: failure.reason, attempts: tries });
        return { kind: "UNAVAILABLE", reason: failure.reason, attempts: tries };
      }
    },
  };
}

const LinkedKnowledgeBase = z.object({ id: z.string().min(1) });

let shared: KnowledgeClient | undefined;

/** The client of a deployed Lambda: the linked `KnowledgeBase`, role credentials, faults from `Runtime`. */
export function knowledgeClient(fault: KnowledgeClientDeps["fault"]): KnowledgeClient {
  if (shared === undefined) {
    // The SDK makes one attempt; this module owns the retries, the deadline and the error mapping.
    const sdk = new BedrockAgentRuntimeClient({ ...awsClientConfig(CLIENT_TIMEOUTS.knowledgeBase), maxAttempts: 1 });
    shared = createKnowledgeClient({
      send: (input, signal) => sdk.send(new RetrieveCommand(input), { abortSignal: signal }),
      knowledgeBaseId: () => readLinked("KnowledgeBase", LinkedKnowledgeBase).id,
      fault,
    });
  }
  return shared;
}
