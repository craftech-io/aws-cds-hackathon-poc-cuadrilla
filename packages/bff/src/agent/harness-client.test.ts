import type { InvokeHarnessCommandInput, InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { describe, expect, it } from "vitest";
import { HarnessError, type HarnessLink, createHarnessClient, harnessRequest, hasRoomForAttempt, outcomeOf, readHarnessStream } from "./harness-client";

const LINK: HarnessLink = { harnessArn: "arn:aws:bedrock-agentcore:us-east-1:776805327629:harness/cuadrilla", endpointName: "live", timeoutSeconds: 90, maxIterations: 10, maxTokens: 4_096 };

async function* streamOf(events: readonly InvokeHarnessStreamOutput[]): AsyncIterable<InvokeHarnessStreamOutput> {
  for (const event of events) yield event;
}

const event = (value: Record<string, unknown>) => value as unknown as InvokeHarnessStreamOutput;

const TURN = [
  event({ messageStart: { role: "assistant" } }),
  event({ contentBlockStart: { start: { toolUse: { toolUseId: "t1", name: "cuadrilla-tools___messaging___send_whatsapp" } } } }),
  event({ messageStop: { stopReason: "tool_use" } }),
  event({ metadata: { usage: { inputTokens: 1_000, outputTokens: 80, cacheReadInputTokens: 600 } } }),
  event({ messageStart: { role: "assistant" } }),
  event({ contentBlockDelta: { delta: { text: "Le pedí la foto " } } }),
  event({ contentBlockDelta: { delta: { text: "del medidor." } } }),
  event({ messageStop: { stopReason: "end_turn" } }),
  event({ metadata: { usage: { inputTokens: 1_300, outputTokens: 40, cacheWriteInputTokens: 50 } } }),
];

const throttled = () => Object.assign(new Error("slow down"), { name: "ThrottlingException" });

describe("harnessRequest", () => {
  it("invokes the live endpoint with the turn's ids and only the envelope: no prompt, model or tools from the edge", () => {
    const input = harnessRequest(LINK, { runtimeSessionId: "a".repeat(48), actorId: "inst-rogelio-e3", envelope: "<session …/>", lambdaDeadlineMs: 0 });
    expect(input).toEqual({
      harnessArn: LINK.harnessArn,
      qualifier: "live",
      runtimeSessionId: "a".repeat(48),
      actorId: "inst-rogelio-e3",
      messages: [{ role: "user", content: [{ text: "<session …/>" }] }],
      maxIterations: 10,
      timeoutSeconds: 90,
      maxTokens: 4_096,
    });
    for (const field of ["systemPrompt", "model", "tools", "allowedTools", "skills"] as const) expect(input).not.toHaveProperty(field);
  });
});

describe("readHarnessStream", () => {
  it("keeps the last assistant text as the note, sums the usage of every model call and counts tool calls", async () => {
    const result = await readHarnessStream(streamOf(TURN));
    expect(result).toEqual({
      outcome: "COMPLETED",
      stopReason: "end_turn",
      note: "Le pedí la foto del medidor.",
      usage: { inputTokens: 2_300, outputTokens: 120, cacheReadTokens: 600, cacheWriteTokens: 50 },
      toolUses: 1,
    });
  });

  it("reads each stop reason as an outcome: guardrail, output budget, anything else incomplete", () => {
    expect(outcomeOf("end_turn")).toBe("COMPLETED");
    expect(outcomeOf("stop_sequence")).toBe("COMPLETED");
    expect(outcomeOf("content_filtered")).toBe("GUARDRAIL");
    expect(outcomeOf("guardrail_intervened")).toBe("GUARDRAIL");
    expect(outcomeOf("max_tokens")).toBe("MAX_TOKENS");
    expect(outcomeOf("max_output_tokens_exceeded")).toBe("MAX_TOKENS");
    expect(outcomeOf("max_iterations_exceeded")).toBe("INCOMPLETE");
    expect(outcomeOf("none")).toBe("INCOMPLETE");
  });

  it("fails the turn on an error event of the stream", async () => {
    await expect(readHarnessStream(streamOf([event({ messageStart: {} }), event({ internalServerException: { message: "boom" } })]))).rejects.toMatchObject({ name: "HarnessError", kind: "STREAM" });
  });
});

describe("createHarnessClient", () => {
  const clock = (start = 0) => {
    let now = start;
    return { nowMs: () => now, sleep: async (ms: number) => void (now += ms), advance: (ms: number) => void (now += ms) };
  };

  it("answers the turn read from the stream, with its attempts", async () => {
    const time = clock();
    const sent: InvokeHarnessCommandInput[] = [];
    const client = createHarnessClient({ link: () => LINK, nowMs: time.nowMs, send: async (input) => (sent.push(input), { stream: streamOf(TURN) }) });
    const result = await client.invoke({ runtimeSessionId: "s", actorId: "inst-rogelio-e3", envelope: "env", lambdaDeadlineMs: 340_000 });
    expect(result).toMatchObject({ outcome: "COMPLETED", attempts: 1 });
    expect(sent).toHaveLength(1);
  });

  it("retries a throttled call with backoff while the Lambda keeps more than timeoutSeconds + 30 s", async () => {
    const time = clock();
    let calls = 0;
    const client = createHarnessClient({
      link: () => LINK,
      nowMs: time.nowMs,
      sleep: time.sleep,
      random: () => 0.5,
      send: async () => {
        calls += 1;
        if (calls < 3) throw throttled();
        return { stream: streamOf(TURN) };
      },
    });
    const result = await client.invoke({ runtimeSessionId: "s", actorId: "a", envelope: "e", lambdaDeadlineMs: 340_000 });
    expect(result.attempts).toBe(3);
  });

  it("gives up as THROTTLED when the retry would leave less than timeoutSeconds + 30 s, so the worker requeues", async () => {
    const time = clock();
    let calls = 0;
    const client = createHarnessClient({
      link: () => LINK,
      nowMs: time.nowMs,
      sleep: time.sleep,
      random: () => 0,
      send: async () => {
        calls += 1;
        time.advance(15_000);
        throw throttled();
      },
    });
    // 130 s left: after the first throttle (15 s) only 115 s remain, under 90 + 30.
    await expect(client.invoke({ runtimeSessionId: "s", actorId: "a", envelope: "e", lambdaDeadlineMs: 130_000 })).rejects.toMatchObject({ kind: "THROTTLED" });
    expect(calls).toBe(1);
  });

  it("stops after 3 retries even with time left", async () => {
    const time = clock();
    let calls = 0;
    const client = createHarnessClient({ link: () => LINK, nowMs: time.nowMs, sleep: time.sleep, random: () => 0, send: async () => (calls++, Promise.reject(throttled())) });
    await expect(client.invoke({ runtimeSessionId: "s", actorId: "a", envelope: "e", lambdaDeadlineMs: 10_000_000 })).rejects.toMatchObject({ kind: "THROTTLED" });
    expect(calls).toBe(4);
  });

  it("never retries a call that may have reached the model, and refuses a turn with no time left", async () => {
    const time = clock();
    let calls = 0;
    const failing = createHarnessClient({ link: () => LINK, nowMs: time.nowMs, send: async () => (calls++, Promise.reject(new Error("AccessDenied"))) });
    await expect(failing.invoke({ runtimeSessionId: "s", actorId: "a", envelope: "e", lambdaDeadlineMs: 340_000 })).rejects.toMatchObject({ kind: "REQUEST" });
    expect(calls).toBe(1);
    await expect(failing.invoke({ runtimeSessionId: "s", actorId: "a", envelope: "e", lambdaDeadlineMs: 20_000 })).rejects.toBeInstanceOf(HarnessError);
    expect(calls).toBe(1);
  });

  it("measures the room for an attempt against timeoutSeconds + 30 s", () => {
    expect(hasRoomForAttempt(120_001, 90)).toBe(true);
    expect(hasRoomForAttempt(120_000, 90)).toBe(false);
  });
});
