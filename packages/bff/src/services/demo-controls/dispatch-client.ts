// Client of the dispatch mock's control routes (docs/architecture-integrations.md §7): reschedule,
// reassign and cancel an order, each of which publishes its event on the `Feeds` bus (then `FeedEvents`
// queues a `DISPATCH_EVENT` for the installer). The BFF calls it for the console's demo controls over
// the SigV4 transport of the linked `DispatchMock` Function URL; tests pass the mock's own router.
//
// 3 s per attempt, 3 attempts with backoff on a timeout, a network error, 429 or 5xx; every answer is
// checked against the mock's contract and every failure becomes an outcome, never an exception.
import { z } from "zod";
import {
  type CancelRequest,
  type DispatchAction,
  DispatchCommandResult,
  DispatchErrorBody,
  type ReassignRequest,
  type RescheduleRequest,
  workOrderPath,
} from "@cuadrilla/dispatch-mock";
import { withDeadline } from "../../lib/deadline";
import { withRetry } from "../../lib/retry";
import type { HttpResponse, HttpTransport } from "../../network/sigv4";

export const DISPATCH_TIMEOUT_MS = 3_000;
export const DISPATCH_ATTEMPTS = 3;

export type DispatchRequestBody = RescheduleRequest | ReassignRequest | CancelRequest;

export type DispatchOutcome =
  | { readonly kind: "OK"; readonly result: DispatchCommandResult }
  | { readonly kind: "REFUSED"; readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID"; readonly reason?: string; readonly message: string }
  | { readonly kind: "UNAVAILABLE"; readonly reason: "TIMEOUT_OR_NETWORK" | "HTTP_5XX" | "INVALID_RESPONSE" };

export interface DispatchControlClient {
  command(action: DispatchAction, workOrderNumber: string, body: DispatchRequestBody, correlationId?: string): Promise<DispatchOutcome>;
}

export interface DispatchClientDeps {
  readonly transport: HttpTransport;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

class Retryable extends Error {
  override readonly name = "DispatchRetryable";
  constructor(readonly reason: "TIMEOUT_OR_NETWORK" | "HTTP_5XX") {
    super(reason);
  }
}

function parseBody<T>(body: string, schema: z.ZodType<T>): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const REFUSAL_CODES = new Set(["NOT_FOUND", "CONFLICT", "INVALID"]);

function outcomeOf(response: HttpResponse): DispatchOutcome {
  if (response.status === 200) {
    const result = parseBody(response.body, DispatchCommandResult);
    return result === undefined ? { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" } : { kind: "OK", result };
  }
  const failure = parseBody(response.body, DispatchErrorBody);
  if (failure === undefined || !REFUSAL_CODES.has(failure.error.code)) return { kind: "UNAVAILABLE", reason: "INVALID_RESPONSE" };
  const { code, message, reason } = failure.error;
  return { kind: "REFUSED", code: code as "NOT_FOUND" | "CONFLICT" | "INVALID", message, ...(reason === undefined ? {} : { reason }) };
}

export function createDispatchControlClient(deps: DispatchClientDeps): DispatchControlClient {
  const timeoutMs = deps.timeoutMs ?? DISPATCH_TIMEOUT_MS;
  return {
    async command(action, workOrderNumber, body, correlationId) {
      const request = {
        method: "POST" as const,
        path: workOrderPath(workOrderNumber, action),
        headers: { "content-type": "application/json", accept: "application/json", ...(correlationId === undefined ? {} : { "x-correlation-id": correlationId }) },
        body: JSON.stringify(body),
      };
      try {
        const response = await withRetry(
          async () => {
            let answer: HttpResponse;
            try {
              answer = await withDeadline(`dispatch.${action}`, timeoutMs, (signal) => deps.transport(request, signal));
            } catch {
              throw new Retryable("TIMEOUT_OR_NETWORK");
            }
            if (answer.status === 429 || answer.status >= 500) throw new Retryable("HTTP_5XX");
            return answer;
          },
          {
            attempts: deps.attempts ?? DISPATCH_ATTEMPTS,
            baseDelayMs: 200,
            shouldRetry: (error) => error instanceof Retryable,
            ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
            ...(deps.random === undefined ? {} : { random: deps.random }),
          },
        );
        return outcomeOf(response);
      } catch (error) {
        return { kind: "UNAVAILABLE", reason: error instanceof Retryable ? error.reason : "TIMEOUT_OR_NETWORK" };
      }
    },
  };
}
