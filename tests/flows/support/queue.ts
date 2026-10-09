// `InstallerEvents.fifo` in process (docs/architecture.md §7, ADR-0017): what the producers send (the
// worker's own sink, InboundWhatsApp, FeedEvents, ChannelEvents, the clock, the console) stays here,
// deduplicated by `MessageDeduplicationId` as SQS does, and `drain` hands it to the `InstallerWorker`
// one record per event (batch 1) with the receive count SQS would report. A record that fails is
// received again, before anything after it, until the queue's `maxReceiveCount`.
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { MAX_RECEIVE_COUNT } from "../../../packages/bff/src/worker/events";
import type { QueueMessage, QueueSend } from "../../../packages/bff/src/worker/sink";

interface Queued extends QueueMessage {
  readonly messageId: string;
  receiveCount: number;
}

export interface LocalQueue {
  readonly send: QueueSend;
  /** Every body received, duplicates included (as JSON). */
  readonly sent: Array<Record<string, unknown>>;
  /** Bodies that failed `maxReceiveCount` times. */
  readonly deadLetters: Array<Record<string, unknown>>;
  pending(): number;
  /** Delivers until the queue is empty. */
  drain(handler: (event: SQSEvent) => Promise<void>): Promise<void>;
}

function recordOf(message: Queued): SQSRecord {
  return {
    messageId: message.messageId,
    receiptHandle: `rh-${message.messageId}-${message.receiveCount}`,
    body: message.body,
    attributes: { ApproximateReceiveCount: String(message.receiveCount), SentTimestamp: "0", SenderId: "local-flows", ApproximateFirstReceiveTimestamp: "0", MessageGroupId: message.groupId, MessageDeduplicationId: message.deduplicationId },
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:000000000000:cuadrilla-local-installer-events.fifo",
    awsRegion: "us-east-1",
  };
}

/** Deliveries one drain may make before it is a loop of events producing events. */
const MAX_DELIVERIES = 2_000;

export function localQueue(): LocalQueue {
  const queue: Queued[] = [];
  const seen = new Set<string>();
  const sent: Array<Record<string, unknown>> = [];
  const deadLetters: Array<Record<string, unknown>> = [];
  let counter = 0;
  return {
    sent,
    deadLetters,
    async send(message) {
      sent.push(JSON.parse(message.body) as Record<string, unknown>);
      if (seen.has(message.deduplicationId)) return;
      seen.add(message.deduplicationId);
      counter += 1;
      queue.push({ ...message, messageId: `local-${String(counter).padStart(6, "0")}`, receiveCount: 0 });
    },
    pending: () => queue.length,
    async drain(handler) {
      let deliveries = 0;
      while (queue.length > 0) {
        if ((deliveries += 1) > MAX_DELIVERIES) throw new Error(`the local queue did not drain after ${MAX_DELIVERIES} deliveries`);
        const message = queue.shift() as Queued;
        message.receiveCount += 1;
        try {
          await handler({ Records: [recordOf(message)] });
        } catch {
          if (message.receiveCount >= MAX_RECEIVE_COUNT) deadLetters.push(JSON.parse(message.body) as Record<string, unknown>);
          else queue.unshift(message);
        }
      }
    },
  };
}
