// The run's model as the agent scenarios use it. A local model server shared by the machine (Ollama) can
// restart or drop a request while a scenario waits for it: the call fails with `fetch failed` (or an HTTP
// 5xx) before the model answered anything. That is the test bench, not the product: such a call is asked
// again after a pause, since a `converse` call has no side effect (tools run in the Gateway, after the
// model answered). A billed model is never asked twice.
import type { ModelClient } from "@craftech/agent-testkit";

/** Pauses before each new attempt: about 80 s in all, enough for Ollama to restart and load the model again. */
export const LOCAL_MODEL_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 40_000];

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

/** `model`, with a local model's transport failures retried; a billed model unchanged. */
export function withLocalRetries(model: ModelClient, delaysMs: readonly number[] = LOCAL_MODEL_RETRY_DELAYS_MS, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): ModelClient {
  if (!model.id.startsWith("ollama:")) return model;
  return {
    ...model,
    async converse(request) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await model.converse(request);
        } catch (error) {
          const delay = delaysMs[attempt];
          if (delay === undefined || !isTransientLocalFailure(error)) throw error;
          await sleep(delay);
        }
      }
    },
  };
}
