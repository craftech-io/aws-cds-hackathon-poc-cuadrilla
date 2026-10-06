import { BedrockAgentRuntimeClient, RetrieveCommand, type RetrieveCommandOutput } from "@aws-sdk/client-bedrock-agent-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FaultSetting } from "../domain/runtime-world";
import { createLogger } from "../lib/log";
import { KNOWLEDGE_FAULTS, NUMBER_OF_RESULTS, createKnowledgeClient, type KnowledgeClientDeps } from "./client";

const KB_ID = "KBTEST0001";
const DEMO = "GLOBAL#isp-demo";
const GUEST = "GUEST#isp-guest-07";
const QA = "qa-812-1-sc-03";
const EVAL = "eval-812-1";
const QUERY = "La señora quiere la roseta en el otro cuarto, su tel es 55 1234 5678, ¿se le cobra?";

/** `Retrieve` as the Knowledge Base answers it: chunk text, score, S3 location and the sidecar metadata. */
function retrieved(...chunks: Array<{ sectionId?: string; title?: string; text: string; score: number; manualVersion?: string }>): RetrieveCommandOutput {
  return {
    $metadata: {},
    retrievalResults: chunks.map((chunk) => ({
      content: { type: "TEXT", text: chunk.text },
      location: { type: "S3", s3Location: { uri: `s3://manual-bucket/manual/v001/${chunk.sectionId ?? "x"}.md` } },
      score: chunk.score,
      metadata: {
        "x-amz-bedrock-kb-source-uri": `s3://manual-bucket/manual/v001/${chunk.sectionId ?? "x"}.md`,
        "x-amz-bedrock-kb-chunk-id": "chunk-1",
        ...(chunk.sectionId === undefined ? {} : { sectionId: chunk.sectionId }),
        ...(chunk.title === undefined ? {} : { title: chunk.title }),
        manualVersion: chunk.manualVersion ?? "v001",
        category: chunk.sectionId?.split("-")[0] ?? "GEN",
        ispScope: "all",
      },
    })),
  };
}

const sdk = new BedrockAgentRuntimeClient({ region: "us-east-1", credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "test" }, maxAttempts: 1 });
const bedrock = mockClient(sdk);
let lines: Array<Record<string, unknown>>;
let fault: ReturnType<typeof vi.fn<(clockId: string) => Promise<FaultSetting | undefined>>>;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;

function client(extra: Partial<KnowledgeClientDeps> = {}) {
  const logger = createLogger({ level: "debug", correlationId: "corr-kb-0001", sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  return createKnowledgeClient({
    send: (input, signal) => sdk.send(new RetrieveCommand(input), { abortSignal: signal }),
    knowledgeBaseId: () => KB_ID,
    fault,
    logger,
    sleep,
    random: () => 0,
    ...extra,
  });
}

const ask = (clockId = DEMO, extra: { category?: "COM" } = {}) => ({ clockId, query: QUERY, manualVersion: "v001", ...extra });

beforeEach(() => {
  bedrock.reset();
  lines = [];
  fault = vi.fn(async () => undefined);
  sleep = vi.fn(async () => undefined);
});

describe("Retrieve over the manual in force", () => {
  it("asks for 5 results of the version in force with the query masked, and returns the chunks with their section", async () => {
    bedrock.on(RetrieveCommand).resolves(retrieved({ sectionId: "COM-04", title: "Reubicación de la roseta", text: "Hasta 15 m de cable no tiene costo.", score: 0.71 }, { text: "sin sidecar", score: 0.9 }));
    const outcome = await client().retrieve(ask());
    expect(outcome).toEqual({ kind: "OK", attempts: 1, chunks: [{ sectionId: "COM-04", title: "Reubicación de la roseta", manualVersion: "v001", category: "COM", text: "Hasta 15 m de cable no tiene costo.", score: 0.71 }] });
    const input = bedrock.commandCalls(RetrieveCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ knowledgeBaseId: KB_ID, retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: NUMBER_OF_RESULTS, filter: { equals: { key: "manualVersion", value: "v001" } } } } });
    expect(input?.retrievalQuery?.text).not.toContain("1234 5678");
    expect(JSON.stringify(lines)).not.toContain("roseta en el otro cuarto");
  });

  it("narrows to one category with the version", async () => {
    bedrock.on(RetrieveCommand).resolves(retrieved());
    await client().retrieve(ask(DEMO, { category: "COM" }));
    expect(bedrock.commandCalls(RetrieveCommand)[0]?.args[0].input.retrievalConfiguration?.vectorSearchConfiguration?.filter).toEqual({
      andAll: [{ equals: { key: "manualVersion", value: "v001" } }, { equals: { key: "category", value: "COM" } }],
    });
  });
});

describe("[FL-034] the Knowledge Base unavailable", () => {
  it("[FL-034] retries throttling with backoff and answers once it recovers", async () => {
    const throttled = Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    bedrock.on(RetrieveCommand).rejectsOnce(throttled).resolves(retrieved({ sectionId: "MED-01", text: "B+ de −8 a −25 dBm.", score: 0.8 }));
    const outcome = await client().retrieve(ask());
    expect(outcome).toMatchObject({ kind: "OK", attempts: 2 });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("[FL-034] answers UNAVAILABLE after the retries, never an exception", async () => {
    bedrock.on(RetrieveCommand).rejects(Object.assign(new Error("boom"), { name: "InternalServerException" }));
    expect(await client().retrieve(ask())).toEqual({ kind: "UNAVAILABLE", reason: "SERVICE_ERROR", attempts: 3 });
    expect(lines.some((line) => line.message === "knowledge.unavailable" && line.reason === "SERVICE_ERROR")).toBe(true);
  });

  it("[FL-034] does not retry what another attempt cannot fix", async () => {
    bedrock.on(RetrieveCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    expect(await client().retrieve(ask())).toEqual({ kind: "UNAVAILABLE", reason: "ACCESS_DENIED", attempts: 1 });
  });

  it("[FL-034] gives up on a call that does not answer within its deadline", async () => {
    const hanging = client({ send: () => new Promise(() => undefined), timeoutMs: 5, retries: 0 });
    expect(await hanging.retrieve(ask())).toEqual({ kind: "UNAVAILABLE", reason: "TIMEOUT", attempts: 1 });
  });

  it("[FL-034] answers UNAVAILABLE when the Knowledge Base is not linked", async () => {
    const unlinked = client({
      knowledgeBaseId: () => {
        throw new Error('resource "KnowledgeBase" is not linked to this function');
      },
    });
    expect(await unlinked.retrieve(ask())).toEqual({ kind: "UNAVAILABLE", reason: "NOT_CONFIGURED", attempts: 0 });
    expect(bedrock.commandCalls(RetrieveCommand)).toHaveLength(0);
  });
});

describe("[FL-034] faults only in qa-* worlds", () => {
  it("[FL-034] a fault of a QA world fails the call without calling Bedrock", async () => {
    fault.mockResolvedValue(KNOWLEDGE_FAULTS.unavailable);
    expect(await client().retrieve(ask(QA))).toEqual({ kind: "UNAVAILABLE", reason: "FAULT_INJECTED", attempts: 0 });
    fault.mockResolvedValue(KNOWLEDGE_FAULTS.timeout);
    expect(await client().retrieve(ask(QA))).toMatchObject({ kind: "UNAVAILABLE", reason: "TIMEOUT" });
    fault.mockResolvedValue(KNOWLEDGE_FAULTS.empty);
    expect(await client().retrieve(ask(QA))).toEqual({ kind: "OK", chunks: [], attempts: 0 });
    expect(bedrock.commandCalls(RetrieveCommand)).toHaveLength(0);
  });

  it("[FL-034] demo, guest and evaluation worlds never read faults", async () => {
    fault.mockResolvedValue(KNOWLEDGE_FAULTS.unavailable);
    bedrock.on(RetrieveCommand).resolves(retrieved());
    for (const clockId of [DEMO, GUEST, EVAL]) expect(await client().retrieve(ask(clockId))).toMatchObject({ kind: "OK" });
    expect(fault).not.toHaveBeenCalled();
  });

  it("[FL-034] an unreadable fault never fails the call", async () => {
    fault.mockRejectedValue(new Error("Runtime unavailable"));
    bedrock.on(RetrieveCommand).resolves(retrieved());
    expect(await client().retrieve(ask(QA))).toMatchObject({ kind: "OK" });
  });
});
