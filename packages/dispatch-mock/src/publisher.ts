// Port through which the mock publishes its events (docs/build-plan.md WP-15: `PutEvents` by an
// injectable port). The Lambda uses the EventBridge adapter on the `Feeds` bus; unit tests and the
// in-process flows use the recording adapter, which can also hand each event to a consumer.
import { EventBridgeClient, PutEventsCommand, type PutEventsCommandOutput, type PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";
import { DISPATCH_EVENT_SOURCE, DispatchEvent } from "./events";

export interface EventPublisher {
  /** Resolves once the bus accepted the event; rejects with `PublishError` otherwise. */
  publish(event: DispatchEvent): Promise<void>;
}

export class PublishError extends Error {
  override readonly name = "PublishError";
}

// ---- EventBridge --------------------------------------------------------------------------------

export const EVENTBRIDGE_TIMEOUTS = { requestTimeoutMs: 2_000, connectionTimeoutMs: 1_000, maxAttempts: 3 } as const;

export function createEventBridgeClient(): EventBridgeClient {
  return new EventBridgeClient({
    maxAttempts: EVENTBRIDGE_TIMEOUTS.maxAttempts,
    requestHandler: { requestTimeout: EVENTBRIDGE_TIMEOUTS.requestTimeoutMs, connectionTimeout: EVENTBRIDGE_TIMEOUTS.connectionTimeoutMs },
  });
}

/** What the adapter needs from the EventBridge client; tests pass a fake. */
export interface PutEventsSender {
  send(command: PutEventsCommand): Promise<Pick<PutEventsCommandOutput, "FailedEntryCount" | "Entries">>;
}

/** The entry the mock puts on the bus for an event. */
export function putEventsEntry(event: DispatchEvent, busName: string): PutEventsRequestEntry {
  const valid = DispatchEvent.parse(event);
  return { EventBusName: busName, Source: DISPATCH_EVENT_SOURCE, DetailType: valid.type, Detail: JSON.stringify(valid.detail) };
}

export interface PublisherRetry {
  /** Attempts for an entry the bus rejected with a transient code, the first one included. */
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

// PutEvents answers 200 with per-entry failures, which the SDK does not retry: throttling and
// internal failures of an entry are retried here with exponential backoff and full jitter.
const TRANSIENT_ENTRY_CODES = new Set(["ThrottlingException", "InternalException", "InternalFailure", "ServiceUnavailable"]);

export function eventBridgePublisher(client: PutEventsSender, busName: string, retry: PublisherRetry = {}): EventPublisher {
  const attempts = Math.max(1, retry.attempts ?? 3);
  const base = retry.baseDelayMs ?? 100;
  const cap = retry.maxDelayMs ?? 1_000;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = retry.random ?? Math.random;
  return {
    async publish(event) {
      const entry = putEventsEntry(event, busName);
      for (let attempt = 1; ; attempt += 1) {
        let output: Pick<PutEventsCommandOutput, "FailedEntryCount" | "Entries">;
        try {
          output = await client.send(new PutEventsCommand({ Entries: [entry] }));
        } catch (error) {
          // The SDK already spent its own attempts with backoff on this call.
          throw new PublishError("PutEvents failed", { cause: error });
        }
        if ((output.FailedEntryCount ?? 0) === 0) return;
        const code = output.Entries?.[0]?.ErrorCode ?? "Unknown";
        if (!TRANSIENT_ENTRY_CODES.has(code) || attempt >= attempts) throw new PublishError(`the bus rejected the entry (${code})`);
        await sleep(Math.floor(random() * Math.min(cap, base * 2 ** (attempt - 1))));
      }
    },
  };
}

// ---- In process ---------------------------------------------------------------------------------

export interface RecordingPublisher extends EventPublisher {
  /** Every event the bus accepted, in order (a replay appears twice, as on a real bus). */
  readonly published: readonly DispatchEvent[];
  /** Makes the next `count` publishes fail, as a bus outage would. */
  failNext(count?: number): void;
}

/** Records what the mock publishes and, when given, delivers each event to an in-process consumer. */
export function recordingPublisher(deliver?: (event: DispatchEvent) => Promise<void>): RecordingPublisher {
  const published: DispatchEvent[] = [];
  let failures = 0;
  return {
    published,
    failNext(count = 1) {
      failures += count;
    },
    async publish(event) {
      const valid = DispatchEvent.parse(event);
      if (failures > 0) {
        failures -= 1;
        throw new PublishError("the bus is unavailable");
      }
      published.push(structuredClone(valid));
      if (deliver !== undefined) await deliver(structuredClone(valid));
    },
  };
}
