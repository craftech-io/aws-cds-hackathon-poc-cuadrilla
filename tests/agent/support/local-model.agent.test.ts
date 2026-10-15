// The bench's retry of the local model server's transport failures (local-model.ts): a restart of Ollama is
// waited out, an answer of the model or any other error is not retried, and a billed model is never asked twice.
import type { ModelClient, ModelResponse } from "@craftech/agent-testkit";
import { describe, expect, it } from "vitest";
import { withLocalRetries } from "./local-model";

const ANSWER: ModelResponse = { content: [{ text: "ok" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
const REQUEST = { system: "s", messages: [], tools: [], maxTokens: 10 };

function failing(id: string, errors: readonly Error[]): { model: ModelClient; calls: () => number } {
  let calls = 0;
  const model: ModelClient = {
    id,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    async converse() {
      const error = errors[calls];
      calls += 1;
      if (error !== undefined) throw error;
      return ANSWER;
    },
  };
  return { model, calls: () => calls };
}

const noSleep = async () => undefined;

describe("withLocalRetries (bench)", () => {
  it("asks a local model again after `fetch failed`, an HTTP 500 and a stopped runner of a restarting server", async () => {
    const { model, calls } = failing("ollama:qwen", [new TypeError("fetch failed"), new Error("Ollama qwen: HTTP 500"), new Error("Ollama qwen: model runner has unexpectedly stopped")]);
    await expect(withLocalRetries(model, [1, 1, 1], noSleep).converse(REQUEST)).resolves.toBe(ANSWER);
    expect(calls()).toBe(4);
  });

  it("gives up after the last pause and throws the transport error", async () => {
    const { model, calls } = failing("ollama:qwen", [new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    await expect(withLocalRetries(model, [1, 1], noSleep).converse(REQUEST)).rejects.toThrow("fetch failed");
    expect(calls()).toBe(3);
  });

  it("never retries a request the server calls wrong, nor an error outside the model call", async () => {
    const wrong = failing("ollama:qwen", [new Error("Ollama qwen: model 'x' not found")]);
    await expect(withLocalRetries(wrong.model, [1, 1], noSleep).converse(REQUEST)).rejects.toThrow("not found");
    expect(wrong.calls()).toBe(1);
    const other = failing("ollama:qwen", [new Error("InvokeHarness without a user message")]);
    await expect(withLocalRetries(other.model, [1, 1], noSleep).converse(REQUEST)).rejects.toThrow("without a user message");
    expect(other.calls()).toBe(1);
  });

  it("leaves a billed model as it is", async () => {
    const { model, calls } = failing("bedrock:opus", [new TypeError("fetch failed")]);
    expect(withLocalRetries(model, [1], noSleep)).toBe(model);
    await expect(withLocalRetries(model, [1], noSleep).converse(REQUEST)).rejects.toThrow("fetch failed");
    expect(calls()).toBe(1);
  });
});
