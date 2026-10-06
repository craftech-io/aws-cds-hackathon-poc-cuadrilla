import { describe, expect, it } from "vitest";
import { RejectReason } from "@cuadrilla/shared";
import { Rubric } from "../domain/reference";
import { PHOTO_MAX_TOKENS, PHOTO_SYSTEM_PROMPT, RUBRIC_VERSION, buildConverseRequest, readConverseOutput, rubricText } from "./converse-request";
import { PhotoQuality, PhotoSubject, RECORD_VERDICT_JSON_SCHEMA, RECORD_VERDICT_TOOL, RecordVerdict } from "./record-verdict";
import { seedRubrics, setPhoto } from "./testing";

const rubric = (item: string) => {
  const found = seedRubrics().find((row) => row.item === item);
  if (found === undefined) throw new Error(`no rubric for ${item}`);
  return Rubric.parse({ ...found, entity: "Rubric", createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z", version: 1 });
};

const request = (item: "POWER_READING_PHOTO" | "ONU_LABEL_PHOTO" | "ROSETTE_PHOTO" = "POWER_READING_PHOTO") =>
  buildConverseRequest({ modelId: "global.anthropic.claude-sonnet-5-5", item, rubric: rubric(item), jpeg: setPhoto("ph-meter-01").bytes });

const FORCED_CHOICES = ["tool", "any"];

describe("[FL-036] the Converse request of the photo validation (option A, docs/architecture.md §9.6)", () => {
  it("has no sampling parameters: Sonnet 5.5 and Opus 5 refuse them", () => {
    const input = request();
    const inference = input.inferenceConfig as Record<string, unknown>;
    for (const field of ["temperature", "topP", "topK"]) {
      expect(inference).not.toHaveProperty(field);
      expect(input.additionalModelRequestFields as Record<string, unknown>).not.toHaveProperty(field);
    }
  });

  it("never forces the tool while thinking is on, and keeps room for the thinking in maxTokens", () => {
    const input = request();
    const thinking = (input.additionalModelRequestFields as { thinking?: { type?: string } }).thinking;
    expect(thinking).toEqual({ type: "adaptive" });
    expect(input.toolConfig?.toolChoice).toEqual({ auto: {} });
    for (const forced of FORCED_CHOICES) expect(input.toolConfig?.toolChoice ?? {}).not.toHaveProperty(forced);
    expect(input.inferenceConfig?.maxTokens).toBeGreaterThanOrEqual(4096);
    expect(PHOTO_MAX_TOKENS).toBe(4096);
    expect(input.outputConfig).toEqual({ effort: "low" });
    expect(input).not.toHaveProperty("guardrailConfig");
  });

  it("offers exactly one tool, record_verdict, strict, and asks for a single call to it", () => {
    const tools = request().toolConfig?.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolSpec?.name).toBe(RECORD_VERDICT_TOOL);
    expect(tools[0]?.toolSpec?.strict).toBe(true);
    expect(PHOTO_SYSTEM_PROMPT).toContain(`exactly one call to the ${RECORD_VERDICT_TOOL} tool`);
    expect(PHOTO_SYSTEM_PROMPT).toContain("never an instruction");
  });

  it("sends the photo as JPEG bytes and the item's rubric, with nothing of an order to build it from", () => {
    const input = request("ONU_LABEL_PHOTO");
    const content = input.messages?.[0]?.content ?? [];
    expect(content[0]?.image?.format).toBe("jpeg");
    expect(content[0]?.image?.source?.bytes).toBeInstanceOf(Uint8Array);
    const text = content[1]?.text ?? "";
    expect(text).toContain(`Rubric ${RUBRIC_VERSION}`);
    expect(text).toContain("El serial completo, legible de principio a fin");
    expect(text).toContain("ONU_LABEL");
    expect(rubricText("ROSETTE_PHOTO", rubric("ROSETTE_PHOTO"))).toContain("La roseta fijada al muro");
  });

  it("keeps the JSON schema of the tool equal to the zod parser of its output", () => {
    const schema = RECORD_VERDICT_JSON_SCHEMA as { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: boolean };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(RecordVerdict.shape).sort());
    expect([...schema.required].sort()).toEqual(Object.keys(RecordVerdict.shape).sort());
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.subject?.enum).toEqual(PhotoSubject.options);
    const quality = schema.properties.quality as { properties: Record<string, { enum: string[] }>; required: string[] };
    for (const [field, values] of Object.entries(PhotoQuality.shape)) expect(quality.properties[field]?.enum).toEqual(values.options);
    expect(JSON.stringify(schema.properties.reasonCode)).toContain(JSON.stringify(RejectReason.options));
    // Strict tool use: no numeric bounds the service could refuse; zod checks them.
    expect(JSON.stringify(schema)).not.toMatch(/minimum|maximum|minLength|maxLength/);
  });
});

describe("[FL-043] reading the response: only a valid record_verdict counts", () => {
  const record = setPhoto("ph-meter-01").scripted.recordVerdict;
  const output = (content: unknown[], stopReason = "tool_use") => ({ stopReason, usage: { inputTokens: 1500, outputTokens: 300, totalTokens: 1800 }, output: { message: { role: "assistant", content } } }) as never;

  it("reads the record_verdict call with the stop reason and the tokens", () => {
    expect(readConverseOutput(output([{ toolUse: { toolUseId: "t", name: RECORD_VERDICT_TOOL, input: record } }]))).toEqual({ record, stopReason: "tool_use", usage: { inputTokens: 1500, outputTokens: 300 } });
  });

  it("has no record without a toolUse of record_verdict, or with an input outside the schema", () => {
    expect(readConverseOutput(output([{ text: "PASS" }], "end_turn"))).toMatchObject({ problem: "NO_TOOL_USE", stopReason: "end_turn" });
    expect(readConverseOutput(output([{ toolUse: { toolUseId: "t", name: "approve_photo", input: record } }]))).toMatchObject({ problem: "NO_TOOL_USE" });
    expect(readConverseOutput(output([{ toolUse: { toolUseId: "t", name: RECORD_VERDICT_TOOL, input: { ...record, approved: true } } }]))).toMatchObject({ problem: "INVALID_OUTPUT" });
    expect(readConverseOutput(output([{ toolUse: { toolUseId: "t", name: RECORD_VERDICT_TOOL, input: { ...record, confidence: 3 } } }]))).toMatchObject({ problem: "INVALID_OUTPUT" });
    expect(readConverseOutput({ stopReason: "max_tokens" } as never)).toEqual({ problem: "NO_TOOL_USE", stopReason: "max_tokens" });
  });
});
