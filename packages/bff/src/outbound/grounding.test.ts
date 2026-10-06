import { ApplyGuardrailCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { STATUS_QUESTION } from "../agent/grounding";
import { createBedrockG3 } from "./g3";
import { GuardrailUnavailableError, contentBlocks, createBedrockG2, groundingSourceOf, queryOf, verdictOf } from "./grounding";
import { guardrailResponse } from "./testing";

const CONFIG = { id: "gr-g2", version: "1", groundingThreshold: 0.75, relevanceThreshold: 0.5, queryMaxChars: 1000, groundingSourceMaxChars: 100_000, contentMaxChars: 5000 };
const COM_04 = { tool: "search_procedures", output: { passages: [{ sectionId: "COM-04", text: "Hasta 15 m de cable dentro del domicilio no tiene costo." }] } };

function bedrock() {
  const client = new BedrockRuntimeClient({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  return { client, mock: mockClient(client) };
}

describe("G2 inputs", () => {
  it("[FL-028] the grounding source is the turn's tool results, one JSON line each, clipped from the oldest side", () => {
    const source = groundingSourceOf([{ tool: "get_work_order", output: { workOrderNumber: "24817" } }, COM_04], 100_000);
    expect(source.split("\n")).toHaveLength(2);
    expect(source).toContain('"sectionId":"COM-04"');
    const clipped = groundingSourceOf([{ tool: "get_work_order", output: { note: "x".repeat(500) } }, COM_04], 120);
    expect(clipped.length).toBe(120);
    expect(clipped).toContain("COM-04");
  });

  it("[FL-028] a REPLY is measured against the installer's question; a greeting against the fixed status question", () => {
    expect(queryOf("REPLY", "La señora quiere la roseta en el otro cuarto, ¿se le cobra?", 1000)).toBe("La señora quiere la roseta en el otro cuarto, ¿se le cobra?");
    expect(queryOf("REPLY", "hola", 1000)).toBe(STATUS_QUESTION.es);
    expect(queryOf("REPLY", "ok gracias", 1000)).toBe(STATUS_QUESTION.es);
    expect(queryOf("REPLY", undefined, 1000)).toBe(STATUS_QUESTION.es);
    expect(queryOf("REPLY", "¿".padEnd(2000, "a"), 1000)).toHaveLength(1000);
    expect(queryOf("ORDERS_DETAIL", undefined, 1000)).toContain("órdenes");
  });

  it("puts the three qualifiers in the content", () => {
    const blocks = contentBlocks({ kind: "REPLY", text: "Hasta 15 m no tiene costo (Manual v1, §COM-04).", groundingSource: "{}", query: "¿se cobra?" }, CONFIG);
    expect(blocks.map((block) => block.text?.qualifiers?.[0])).toEqual(["grounding_source", "query", "guard_content"]);
  });
});

describe("G2 verdict", () => {
  it("[FL-028] passes a grounded and relevant reply with its score", () => {
    expect(verdictOf(guardrailResponse({ grounding: 0.91, relevance: 0.8 }), "REPLY", CONFIG)).toMatchObject({ action: "NONE", groundingScore: 0.91, relevanceScore: 0.8 });
  });

  it("[FL-033] refuses below the grounding threshold, below relevance only for a REPLY, and fails closed without a score", () => {
    expect(verdictOf(guardrailResponse({ grounding: 0.4, relevance: 0.9 }, true), "REPLY", CONFIG)).toMatchObject({ action: "BLOCKED", failure: "GROUNDING", groundingThreshold: 0.75 });
    expect(verdictOf(guardrailResponse({ grounding: 0.9, relevance: 0.2 }, true), "REPLY", CONFIG)).toMatchObject({ action: "BLOCKED", failure: "RELEVANCE" });
    expect(verdictOf(guardrailResponse({ grounding: 0.9, relevance: 0.2 }), "ORDERS_DETAIL", CONFIG)).toMatchObject({ action: "NONE" });
    expect(verdictOf(guardrailResponse({}), "REPLY", CONFIG)).toMatchObject({ action: "BLOCKED", failure: "GROUNDING" });
  });

  it("[FL-033] a denied topic on output blocks whatever the scores", () => {
    const response = { ...guardrailResponse({ grounding: 0.95, relevance: 0.9 }, true), assessments: [{ topicPolicy: { topics: [{ name: "PRICING", type: "DENY" as const, action: "BLOCKED" as const }] } }] };
    expect(verdictOf(response, "REPLY", CONFIG)).toMatchObject({ action: "BLOCKED", failure: "BLOCKED" });
  });
});

describe("G2 and G3 over Bedrock", () => {
  it("[FL-028] calls ApplyGuardrail with source OUTPUT and the published version", async () => {
    const { client, mock } = bedrock();
    mock.on(ApplyGuardrailCommand).resolves(guardrailResponse({ grounding: 0.88, relevance: 0.7 }));
    const verdict = await createBedrockG2({ client, config: () => CONFIG, sleep: async () => undefined }).check({ kind: "REPLY", text: "Hasta 15 m no tiene costo (Manual v1, §COM-04).", groundingSource: groundingSourceOf([COM_04], 1000), query: "¿se cobra?" });
    expect(verdict).toMatchObject({ action: "NONE", groundingScore: 0.88 });
    expect(mock.commandCalls(ApplyGuardrailCommand)[0]?.args[0].input).toMatchObject({ guardrailIdentifier: "gr-g2", guardrailVersion: "1", source: "OUTPUT" });
  });

  it("[FL-033] a text longer than G2's content limit is refused without a call; an outage fails closed", async () => {
    const { client, mock } = bedrock();
    const g2 = createBedrockG2({ client, config: () => ({ ...CONFIG, contentMaxChars: 10 }), sleep: async () => undefined });
    expect(await g2.check({ kind: "REPLY", text: "un texto más largo que el límite", groundingSource: "{}", query: "-" })).toMatchObject({ action: "BLOCKED", failure: "TOO_LONG" });
    expect(mock.commandCalls(ApplyGuardrailCommand)).toHaveLength(0);
    mock.on(ApplyGuardrailCommand).rejects(Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
    await expect(createBedrockG2({ client, config: () => CONFIG, sleep: async () => undefined }).check({ kind: "REPLY", text: "hola", groundingSource: "{}", query: "-" })).rejects.toBeInstanceOf(GuardrailUnavailableError);
    expect(mock.commandCalls(ApplyGuardrailCommand)).toHaveLength(2);
  });

  it("[FL-053] G3 masks first, takes G3's anonymized output and refuses a card", async () => {
    const { client, mock } = bedrock();
    mock.on(ApplyGuardrailCommand).callsFake((input: { content: Array<{ text: { text: string } }> }) => {
      const text = input.content[0]?.text.text ?? "";
      if (text.includes("Héctor")) return { action: "GUARDRAIL_INTERVENED", outputs: [{ text: "{NAME} [TELÉFONO]" }], assessments: [{ sensitiveInformationPolicy: { piiEntities: [{ type: "NAME", match: "Héctor", action: "ANONYMIZED" }] } }] };
      return { action: "NONE", outputs: [], assessments: [] };
    });
    const g3 = createBedrockG3({ client, config: () => ({ id: "gr-g3", version: "1" }), sleep: async () => undefined });
    const result = await g3.check(["Héctor 5598765432", "24818"]);
    expect(result).toEqual({ action: "ANONYMIZED", texts: ["{NAME} [TELÉFONO]", "24818"] });
    const sent = mock.commandCalls(ApplyGuardrailCommand).map((call) => call.args[0].input.content?.[0]?.text?.text);
    expect(sent[0]).not.toContain("5598765432");
    mock.on(ApplyGuardrailCommand).resolves({ action: "GUARDRAIL_INTERVENED", outputs: [], assessments: [{ sensitiveInformationPolicy: { piiEntities: [{ type: "CREDIT_DEBIT_CARD_NUMBER", match: "x", action: "BLOCKED" }], regexes: [] } }] });
    expect((await g3.check(["Rogelio"])).action).toBe("BLOCKED");
  });
});
