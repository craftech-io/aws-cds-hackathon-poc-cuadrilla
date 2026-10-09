// `InboundWhatsApp` in process for the local UI server: the simulator's signed envelope goes through the
// real channels/whatsapp/inbound.ts (origin, number, world and identity, idempotency by `wamid`, keywords,
// buttons, media from the simulator's uploads), over the server's memory. What would leave the process
// is recorded instead: the events for the installer queue (no worker runs here, so nothing is marked in
// flight and the world never stays busy waiting for a turn), the fixed notices and the window fallback.
import { type InboundDeps, processInboundEvent } from "../../packages/bff/src/channels/whatsapp/inbound";
import { type ChannelQueueEvent, type NoticeRequest, connectorWorldTime, logMetricSink, worldModeReader } from "../../packages/bff/src/channels/whatsapp/ports";
import type { MediaStore } from "../../packages/bff/src/channels/whatsapp/media-store";
import type { Connector } from "../../packages/bff/src/connector/ports";
import { type Clock, systemClock } from "../../packages/bff/src/lib/clock";
import { type SecretKey, deriveSubkey } from "../../packages/bff/src/lib/crypto";
import type { Logger } from "../../packages/bff/src/lib/log";
import type { KillSwitchReader } from "../../packages/bff/src/ops/kill-switch";
import type { MemoryObjects } from "../../packages/bff/src/routers/console-testing";
import { channelActions } from "../../packages/bff/src/services/consent/channel-actions";

/** The simulator's envelope key of this server (the ports sign with it, the channel checks it). */
export const UI_SIM_ENVELOPE_KEY: SecretKey = deriveSubkey("ui-server-world-key-not-a-secret", "sim-envelope");
const UI_NONCE_KEY: SecretKey = deriveSubkey("ui-server-world-key-not-a-secret", "nonce");

export interface LocalInbound {
  /** Events the installer queue would have received, in order. */
  readonly queued: ChannelQueueEvent[];
  /** Fixed notices the channel would have sent. */
  readonly notices: NoticeRequest[];
  handle(event: unknown): Promise<unknown>;
}

export interface LocalInboundOptions {
  readonly connector: Connector;
  readonly objects: MemoryObjects;
  readonly phoneHashKey: SecretKey;
  readonly kill: KillSwitchReader;
  readonly logger: Logger;
  readonly realClock?: Clock;
}

/** The `Media` bucket of the memory objects as the channel's media store reads it. */
function mediaStoreOf(objects: MemoryObjects): MediaStore {
  return { head: ({ key }) => objects.media.head(key), readStart: ({ key }, count) => objects.media.readStart(key, count), delete: ({ key }) => objects.media.delete(key) };
}

export function createLocalInbound(options: LocalInboundOptions): LocalInbound {
  const queued: ChannelQueueEvent[] = [];
  const notices: NoticeRequest[] = [];
  const realClock = options.realClock ?? systemClock;
  const deps: InboundDeps = {
    connector: options.connector,
    filter: {
      verifier: { verify: async () => ({ valid: false, reason: "LIVE_NOT_HERE" }) as never },
      topicArn: () => "arn:aws:sns:us-east-1:000000000000:ui-server",
      simEnvelopeKey: UI_SIM_ENVELOPE_KEY,
      numberIds: () => undefined,
      stageTransports: () => ["simulated"],
      worldMode: worldModeReader(options.connector),
    },
    phoneHashKey: options.phoneHashKey,
    nonceKey: UI_NONCE_KEY,
    worldTime: connectorWorldTime(options.connector, realClock),
    kill: options.kill,
    notices: { send: async (request) => void notices.push(request) },
    queue: { enqueue: async (event) => void queued.push(event) },
    actions: channelActions({ connector: options.connector, realClock, logger: options.logger }),
    media: { store: mediaStoreOf(options.objects), mediaBucket: () => "Media", worlds: options.connector.worlds },
    fallback: { sendTemplate: async () => undefined, holdForNextInbound: async () => undefined },
    metrics: logMetricSink(options.logger),
    logger: options.logger,
    realClock,
  };
  return {
    queued,
    notices,
    handle: (event) => processInboundEvent(event, deps),
  };
}
