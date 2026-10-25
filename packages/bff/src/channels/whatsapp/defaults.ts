// The adapters a Lambda uses, built once per container from what SST links (`Resource` through
// lib/resource.ts and lib/secrets.ts, never `process.env`): the EUM Social client with the AWS id of
// our number, the SNS verifier and our topic's ARN, the S3 media store, the subkeys, the world readers and the kill
// switch. What belongs to other modules (the outbound pipeline, the installer queue, the
// deterministic handlers) arrives as ports: `handlers/inbound-whatsapp.ts` passes them in.
import { connector as defaultConnector } from "../../connector/index";
import type { Connector } from "../../connector/ports";
import { type Clock, systemClock } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import { bucketName, channelModes, waInboundTopicArn } from "../../lib/resource";
import { NOT_CONNECTED, WhatsAppMetaPhoneNumberIdValue, WhatsAppPhoneNumberIdValue } from "../../lib/secret-schemas";
import { secretValue, subkey } from "../../lib/secrets";
import { killSwitchReader } from "../../ops/defaults";
import { type SocialMessagingPort, createSocialMessaging } from "./client";
import { type StatusDeps, applyStatuses } from "./events";
import type { InboundDeps } from "./inbound";
import { createS3MediaStore } from "./media-store";
import type { NumberIds } from "./phone-filter";
import { createLiveTransport } from "./outbound";
import { type ChannelActions, type EventQueue, type NoticeSender, connectorWorldTime, logMetricSink, worldModeReader } from "./ports";
import { createSimulatedTransport, type SimulatedTransport } from "./simulated";
import { createCertificateFetcher, createSnsVerifier } from "./sns-signature";
import type { WhatsAppChannelTransport } from "./transport";

let social: SocialMessagingPort | undefined;
let verifier: ReturnType<typeof createSnsVerifier> | undefined;

/**
 * The two ids of our number from their secrets (docs/architecture.md §3); `undefined` while either holds
 * the placeholder value (P-01). Only these two are linked to the channel: the WABA id is not needed here. A
 * malformed value fails without echoing it.
 */
export function linkedNumberIds(): NumberIds | undefined {
  const phoneNumberId = WhatsAppPhoneNumberIdValue.safeParse(secretValue("WhatsAppPhoneNumberId"));
  const metaPhoneNumberId = WhatsAppMetaPhoneNumberIdValue.safeParse(secretValue("WhatsAppMetaPhoneNumberId"));
  if (!phoneNumberId.success || !metaPhoneNumberId.success) throw new Error("the WhatsApp number secrets do not match their schemas");
  if (phoneNumberId.data === NOT_CONNECTED || metaPhoneNumberId.data === NOT_CONNECTED) return undefined;
  return { phoneNumberId: phoneNumberId.data, metaPhoneNumberId: metaPhoneNumberId.data };
}

/** The container's EUM Social client; it reads the AWS id of the number at each call (it changes when the stage enables the live transport, P-01). */
export function socialMessaging(): SocialMessagingPort {
  social ??= createSocialMessaging({ originationPhoneNumberId: () => linkedNumberIds()?.phoneNumberId ?? NOT_CONNECTED });
  return social;
}

function snsVerifier() {
  verifier ??= createSnsVerifier({ fetchCertificate: createCertificateFetcher() });
  return verifier;
}

/** Ports of other modules the inbound processing acts through. */
export interface InboundPorts {
  readonly notices: NoticeSender;
  readonly queue: EventQueue;
  readonly actions: ChannelActions;
  readonly fallback: StatusDeps["fallback"];
  readonly logger: Logger;
  readonly connector?: Connector;
  readonly realClock?: Clock;
}

export function inboundDeps(ports: InboundPorts): InboundDeps {
  const connector = ports.connector ?? defaultConnector();
  const realClock = ports.realClock ?? systemClock;
  const live = socialMessaging();
  return {
    connector,
    filter: {
      verifier: snsVerifier(),
      topicArn: waInboundTopicArn,
      simEnvelopeKey: subkey("sim-envelope"),
      numberIds: linkedNumberIds,
      stageTransports: () => channelModes().whatsapp.transports,
      worldMode: worldModeReader(connector),
    },
    phoneHashKey: subkey("phone-hash"),
    nonceKey: subkey("nonce"),
    worldTime: connectorWorldTime(connector, realClock),
    kill: killSwitchReader(),
    notices: ports.notices,
    queue: ports.queue,
    actions: ports.actions,
    media: { store: createS3MediaStore(), mediaBucket: () => bucketName("Media"), social: live, worlds: connector.worlds },
    social: live,
    fallback: ports.fallback,
    metrics: logMetricSink(ports.logger),
    logger: ports.logger,
    realClock,
  };
}

/** The status handler bound to the container's adapters (the simulated transport and the inbound events). */
export function statusDeps(ports: Pick<InboundPorts, "fallback" | "logger" | "connector">): StatusDeps {
  const connector = ports.connector ?? defaultConnector();
  return { conversations: connector.conversations, runtime: connector.runtime, audit: connector.audit, metrics: logMetricSink(ports.logger), fallback: ports.fallback, logger: ports.logger };
}

/**
 * The two transports as channels/registry.ts builds them (`TransportFactories.whatsapp`): the registry
 * runs a factory only for a transport the stage has, so the live one is built only on a stage with the live transport (P-01).
 */
export function whatsAppTransportFactories(ports: Pick<InboundPorts, "fallback" | "logger" | "connector" | "realClock">): { readonly simulated: () => SimulatedTransport; readonly live: () => WhatsAppChannelTransport } {
  const connector = ports.connector ?? defaultConnector();
  const realClock = ports.realClock ?? systemClock;
  return {
    simulated: () => {
      const deps = statusDeps(ports);
      return createSimulatedTransport({ conversations: connector.conversations, isps: connector.isps, applyStatuses: (statuses) => applyStatuses(statuses, deps), realClock });
    },
    live: () => createLiveTransport({ social: socialMessaging(), conversations: connector.conversations, templates: connector.reference, bucketName: (bucket) => bucketName(bucket), realClock }),
  };
}

/** Test seam. */
export function resetWhatsAppDefaults(): void {
  social = undefined;
  verifier = undefined;
}
