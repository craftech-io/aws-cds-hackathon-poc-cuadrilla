/// <reference path="../../sst-env.d.ts" />
// The producer of `InstallerEvents.fifo` (docs/architecture.md §7, ADR-0017): every event is validated with
// the worker's own schema (worker/events.ts), marked in flight for its installer and its world, and only
// then sent, with `MessageGroupId = installerId` (the probes' own group for `HEALTH_PROBE`) and
// `MessageDeduplicationId = eventId`. A send that fails takes the mark back, so a world never stays busy
// with an event that never reached the queue. The worker uses it for its follow-ups; InboundWhatsApp,
// ChannelEvents, FeedEvents, ScheduleDispatch, the BFF and the QaDriver can use the same producer.
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { z } from "zod";
import type { Connector } from "../connector/ports";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { type InstallerQueueEventInput, checkQueueEvent, isWorldEvent, messageGroupOf } from "./events";
import type { InstallerEventSink } from "./ports";

const REGION = "us-east-1";

export interface QueueMessage {
  readonly body: string;
  readonly groupId: string;
  readonly deduplicationId: string;
}

export type QueueSend = (message: QueueMessage) => Promise<void>;

/** Validates, marks in flight, sends; a failed send gives the mark back. */
export function createEventSink(deps: { readonly data: Pick<Connector, "worlds">; readonly send: QueueSend }): InstallerEventSink {
  return {
    async enqueue(input: InstallerQueueEventInput) {
      const event = checkQueueEvent(input);
      const world = isWorldEvent(event) ? event : undefined;
      if (world !== undefined) await deps.data.worlds.markInFlight(world.installerId, world.clockId, world.eventId);
      try {
        await deps.send({ body: JSON.stringify(event), groupId: messageGroupOf(event), deduplicationId: event.eventId });
      } catch (error) {
        if (world !== undefined) await deps.data.worlds.clearInFlight(world.installerId, world.clockId, world.eventId);
        throw error;
      }
    },
  };
}

const QueueLink = z.object({ url: z.string().url() });

let sqs: SQSClient | undefined;

/** `SendMessage` to the linked `InstallerEvents` queue (`Resource.InstallerEvents.url`, `sqs:SendMessage` only). */
export function linkedQueueSend(): QueueSend {
  return async (message) => {
    sqs ??= new SQSClient({ region: REGION, ...awsClientConfig(CLIENT_TIMEOUTS.sqs) });
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: readLinked("InstallerEvents", QueueLink).url,
        MessageBody: message.body,
        MessageGroupId: message.groupId,
        MessageDeduplicationId: message.deduplicationId,
      }),
    );
  };
}
