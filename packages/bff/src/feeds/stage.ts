// The installer queue of the entries of WP-33 in a Lambda (`InboundWhatsApp`, `ChannelEvents`,
// `FeedEvents`, `ScheduleDispatch`): the worker's producer (worker/sink.ts), so every event is validated
// with the consumer's schema, marked in flight for its installer and its world, and only then sent to
// the linked `InstallerEvents` queue (`Resource.InstallerEvents.url`, `sqs:SendMessage` only).
import type { Connector } from "../connector/ports";
import { createEventSink, linkedQueueSend } from "../worker/sink";
import type { QueueSink } from "./queue-events";

export function stageQueueSink(data: Pick<Connector, "worlds">): QueueSink {
  return createEventSink({ data, send: linkedQueueSend() });
}
