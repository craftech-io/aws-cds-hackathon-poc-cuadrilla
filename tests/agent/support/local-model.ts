// The run's model as the agent scenarios use it. A local model server shared by the machine (Ollama) can
// restart or drop a request while a scenario waits for it: the call fails with `fetch failed` (or an HTTP
// 5xx) before the model answered anything. That is the test bench, not the product: such a call is asked
// again after a pause, since a `converse` call has no side effect (tools run in the Gateway, after the
// model answered). The server also answers HTTP 500 when its own parser cannot read the tool call the model
// wrote ("qwen tool call parsing failed": an XML <parameter> closed by </function>); at temperature 0 the
// same request writes the same broken call again (6 of 6 attempts, twice, on 2026-10-15), so every retry
// samples again at RETRY_TEMPERATURE. A billed model is never asked twice.
import type { ModelClient } from "@craftech/agent-testkit";

/** Pauses before each new attempt: about 80 s in all, enough for Ollama to restart and load the model again. */
export const LOCAL_MODEL_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 40_000];

/** Sampling temperature of a retry: a deterministic request would only repeat the call the server could not parse. */
export const RETRY_TEMPERATURE = 0.4;

/** Errors of the server that say the request itself is wrong: asking again cannot help. */
const PERMANENT = /not found|does not support|invalid|unknown model/i;

/**
 * A failure of the local model server, not an answer of the model: the transport (`fetch failed`, a refused
 * or reset connection) or the server's own error while it restarts, swaps or reloads the model (an HTTP 5xx,
 * a stopped runner, a busy server), unless the error says the request is wrong.
 */
export function isTransientLocalFailure(error: unknown): boolean {
  if (!(error instanceof Error) || PERMANENT.test(error.message)) return false;
  return error instanceof TypeError || /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|^Ollama /i.test(error.message);
}

/** `model`, with a local model's transport failures and unparseable tool calls retried; a billed model unchanged. */
export function withLocalRetries(model: ModelClient, delaysMs: readonly number[] = LOCAL_MODEL_RETRY_DELAYS_MS, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): ModelClient {
  if (!model.id.startsWith("ollama:")) return model;
  return {
    ...model,
    async converse(request) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await model.converse(attempt === 0 ? request : { ...request, temperature: Math.max(request.temperature ?? 0, RETRY_TEMPERATURE) });
        } catch (error) {
          const delay = delaysMs[attempt];
          if (delay === undefined || !isTransientLocalFailure(error)) throw error;
          await sleep(delay);
        }
      }
    },
  };
}
