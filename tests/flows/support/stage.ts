// The stage's own modules wired over one local world: what each Lambda's `stage*` factory builds from
// its links (outbound/stage.ts, cases/stage.ts, timers/stage.ts, handlers/inbound-whatsapp.ts,
// handlers/channel-events.ts, handlers/feed-events.ts), built here from the in-memory connector, the
// local queue, the AWS fakes (aws.ts) and the world's master key, and nothing else:
//
//   outbound   the pipeline's ports (outbound/deps.ts): the simulated WhatsApp transport of the channel
//              registry with the window fallback, the single SES client with its real fence over the SES
//              fake, G2 over the guardrail fake, G3's deterministic layer, the button nonces, the timers
//   cases      cases/ports.ts over that pipeline, the timers, the installer queue and the orchestrator
//   timers     timers/ over a recording Scheduler (a paused world needs none) and a dispatcher that
//              enqueues `TIMER` on the local queue, as the worker's producer does
//   inbound    `InboundWhatsApp` (channels/whatsapp/inbound.ts) with the stage's notices, queue and
//              keyword handlers; the simulator's envelopes are signed with this world's subkey
//   live       only when a test asks for it (P-01 closed in the stage): the live transport over an EUM
//              Social stand-in and SNS events signed with the fixtures' key (channels/whatsapp/testing.ts)
import { createChannelRegistry } from "../../../packages/bff/src/channels/registry";
import { type EmailClient, createEmailClient } from "../../../packages/bff/src/channels/email/outbound";
import type { EmailChannelConfig } from "../../../packages/bff/src/channels/email/config";
import { whatsAppTransportFactories } from "../../../packages/bff/src/channels/whatsapp/defaults";
import type { SocialMessagingPort } from "../../../packages/bff/src/channels/whatsapp/client";
import type { InboundDeps } from "../../../packages/bff/src/channels/whatsapp/inbound";
import { createLiveTransport } from "../../../packages/bff/src/channels/whatsapp/outbound";
import { AWS_ID, META_ID, TOPIC_ARN, testVerifier } from "../../../packages/bff/src/channels/whatsapp/testing";
import { connectorWorldTime, logMetricSink, worldModeReader } from "../../../packages/bff/src/channels/whatsapp/ports";
import { createCertificatePort, inProcessCertificateWriter } from "../../../packages/bff/src/certificates/port";
import { pipelineCertificateSender } from "../../../packages/bff/src/certificates/pipeline-sender";
import { scriptedG3 } from "../../../packages/bff/src/certificates/testing";
import { queueCaseTurns } from "../../../packages/bff/src/cases/stage";
import { openCase } from "../../../packages/bff/src/cases/open";
import type { CaseDeps } from "../../../packages/bff/src/cases/ports";
import { fixedSummary } from "../../../packages/bff/src/cases/summary";
import type { MemoryConnector } from "../../../packages/bff/src/connector/index";
import type { Message } from "../../../packages/bff/src/domain/conversations";
import { resolveBrand } from "../../../packages/bff/src/copy/brand";
import { esMX } from "../../../packages/bff/src/copy/es-MX";
import type { CertificatePort } from "../../../packages/bff/src/agent-tools/common/ports";
import { type SecretKey, type SubkeyPurpose, deriveSubkey, phoneHash, ulid } from "../../../packages/bff/src/lib/crypto";
import type { Clock } from "../../../packages/bff/src/lib/clock";
import type { Logger } from "../../../packages/bff/src/lib/log";
import { createCaseOutbound, createSummaryCheck } from "../../../packages/bff/src/outbound/cases";
import type { OutboundDeps } from "../../../packages/bff/src/outbound/deps";
import { createWindowFallback } from "../../../packages/bff/src/outbound/fallback";
import { maskParams } from "../../../packages/bff/src/outbound/g3";
import { createBedrockG2 } from "../../../packages/bff/src/outbound/grounding";
import { createInstallerNoticeSender, createNoticeSender } from "../../../packages/bff/src/outbound/notices";
import type { ConversationsPort } from "../../../packages/bff/src/connector/ports";
import type { CostCapsDeps, GlobalCostCaps } from "../../../packages/bff/src/ops/cost-caps";
import { type KillSwitchReader, createKillSwitchReader } from "../../../packages/bff/src/ops/kill-switch";
import { type MemoryRuntimeStore, createMemoryRuntimeStore } from "../../../packages/bff/src/ops/memory-runtime-store";
import { channelActions } from "../../../packages/bff/src/services/consent/channel-actions";
import { type TimerDispatcher, queueTimerDispatcher } from "../../../packages/bff/src/timers/dispatch";
import { RecordingScheduler } from "../../../packages/bff/src/timers/testing";
import { type TimerService, createTimerService } from "../../../packages/bff/src/timers/timers";
import type { InstallerEventSink } from "../../../packages/bff/src/worker/ports";
import { createEventSink } from "../../../packages/bff/src/worker/sink";
import type { GuardrailFake, SesFake } from "./aws";
import { LOCAL_G2 } from "./aws";
import type { LocalNetwork } from "./mocks";
import type { FlowObjects } from "./objects";
import type { LocalQueue } from "./queue";

/** Master key of every local world; the stage's comes from `SessionTokenKey` (infra/secrets.ts). */
export const LOCAL_MASTER_KEY = "cuadrilla-local-flows-master-key-not-a-secret-v1";
export const LOCAL_STAGE = "poc";

/** The stage's ceiling of the day (ADR-0019 values). */
export const LOCAL_GLOBAL_CAPS: GlobalCostCaps = { turnsPerDay: 1_500, validationsPerDay: 400, transcribeSecondsPerDay: 5_400 };

/** The SES configuration of a local world: the app's configuration set of the `poc` stage. */
export const LOCAL_EMAIL_CONFIG: EmailChannelConfig = {
  identityDomain: "cuadrilla.demo.craftech.io",
  configurationSetName: `aws-cds-hackathon-poc-cuadrilla-email-${LOCAL_STAGE}`,
  evidenceBucket: "Evidence",
  stage: LOCAL_STAGE,
};

export interface StageBase {
  readonly memory: MemoryConnector;
  readonly objects: FlowObjects;
  readonly queue: LocalQueue;
  readonly network: LocalNetwork;
  readonly guardrails: GuardrailFake;
  readonly ses: SesFake;
  readonly now: () => Date;
  readonly log: Logger;
  /** EUM Social stand-in: the stage has the live transport too (`ChannelModes.whatsapp.transports`). */
  readonly live?: SocialMessagingPort;
}

export interface Stage extends StageBase {
  key(purpose: SubkeyPurpose): SecretKey;
  readonly hashPhone: (phone: string) => string;
  readonly realClock: Clock;
  readonly runtimeStore: MemoryRuntimeStore;
  readonly kill: KillSwitchReader;
  readonly costs: CostCapsDeps;
  readonly sink: InstallerEventSink;
  readonly scheduler: RecordingScheduler;
  readonly dispatcher: TimerDispatcher;
  readonly timers: TimerService;
  readonly email: EmailClient;
  readonly outbound: OutboundDeps;
  readonly cases: CaseDeps;
  readonly summaries: ReturnType<typeof createSummaryCheck>;
  readonly certificates: CertificatePort;
  readonly notices: ReturnType<typeof createNoticeSender>;
  readonly installerNotices: ReturnType<typeof createInstallerNoticeSender>;
  readonly inbound: InboundDeps;
  /** The world's simulated now (`Runtime/CLOCK#`). */
  simNow(clockId: string): Promise<Date>;
  /** ULIDs that grow within one real millisecond (real time stands still between two steps). */
  newId(): string;
}

/** ULIDs of a still real clock: the counter fills the random part, so two ids of one instant still sort. */
function monotonicIds(now: () => Date): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const value = counter;
    return ulid(now().getTime(), (size) => Uint8Array.from({ length: size }, (_, index) => (index === size - 1 ? value & 0xff : index === size - 2 ? (value >> 8) & 0xff : 0)));
  };
}

const SIMULATED_MODES = { email: "live" as const, whatsapp: { transports: ["simulated" as const] } };
const LIVE_MODES = { email: "live" as const, whatsapp: { transports: ["simulated" as const, "live" as const] } };

export function createStage(base: StageBase): Stage {
  const { memory, objects, now, log } = base;
  const data = memory.connector;
  const key = (purpose: SubkeyPurpose) => deriveSubkey(LOCAL_MASTER_KEY, purpose);
  const realClock: Clock = { now: async () => now() };
  const runtimeStore = createMemoryRuntimeStore();
  const kill = createKillSwitchReader({ store: runtimeStore, realClock, ttlMs: 0 });
  const costs: CostCapsDeps = { store: runtimeStore, globalCaps: () => LOCAL_GLOBAL_CAPS, kill, realClock, logger: log };
  const sink = createEventSink({ data, send: base.queue.send });
  const scheduler = new RecordingScheduler();
  const dispatcher = queueTimerDispatcher(sink);
  const timers = createTimerService({ data, scheduler, dispatcher, realClock, log });
  const worldTime = connectorWorldTime(data, realClock);
  const newId = monotonicIds(now);
  let outbound: OutboundDeps | undefined;
  const lateOutbound = (): OutboundDeps => outbound as OutboundDeps;
  const fallback = createWindowFallback({ outbound: lateOutbound, worldTime, logger: log });
  const email = createEmailClient({
    connector: data,
    ses: base.ses as never,
    attachments: objects.attachments,
    config: () => LOCAL_EMAIL_CONFIG,
    demoRecipients: () => [],
    caps: { store: runtimeStore },
    realClock,
    newMailId: () => `mail-${newId()}`,
    logger: log,
  });
  const social = base.live;
  const modes = social === undefined ? SIMULATED_MODES : LIVE_MODES;
  const liveFactory = (conversations: ConversationsPort) => (social === undefined ? {} : { live: () => createLiveTransport({ social, conversations, templates: data.reference, bucketName: (bucket) => bucket, realClock }) });
  const registry = createChannelRegistry({ modes, factories: { whatsapp: { ...whatsAppTransportFactories({ fallback, logger: log, connector: data, realClock }), ...liveFactory(data.conversations) }, email: () => email } });
  outbound = {
    connector: data,
    whatsapp: (route) => registry.whatsapp(route),
    email,
    g2: createBedrockG2({ client: { send: base.guardrails.send } as never, config: () => LOCAL_G2, sleep: async () => undefined }),
    g2Limits: () => LOCAL_G2,
    g3: { check: async (texts) => maskParams(texts) },
    nonces: { runtime: data.runtime, nonceKey: key("nonce"), realClock },
    timers,
    brand: () => resolveBrand({ mode: "neutral" }),
    registeredRealPhones: () => new Set<string>(),
    demoRecipients: () => [],
    realClock,
    newId,
  };
  const cases: CaseDeps = { connector: data, outbound: createCaseOutbound(outbound, log), timers, turns: queueCaseTurns(sink), network: base.network.client, realClock, logger: log };
  const simNow = async (clockId: string): Promise<Date> => (await worldTime(clockId))?.simNow ?? now();
  const certificates = createCertificatePort({
    connector: data,
    writer: inProcessCertificateWriter({ connector: data, objects: objects.certificates, g3: scriptedG3(), brand: () => undefined, logger: log }),
    sender: pipelineCertificateSender(outbound, log),
    timers,
    brand: () => undefined,
    logger: log,
    async openBlockedCase(request) {
      const workOrder = await data.workOrders.requireWorkOrder(request.workOrderId);
      const summary = fixedSummary({ reason: "OTHER", reasonText: esMX.caseReason({ reason: "OTHER" }), workOrder });
      await openCase(cases, { workOrderId: workOrder.workOrderId, reason: "OTHER", summary, atSim: request.closedAtSim, actor: "SYSTEM" });
    },
  });
  // The reply to a number outside the allow list has no thread to be filed under (outbound/stage.ts).
  const unthreadedConversations: ConversationsPort = { ...data.conversations, getMessage: async () => undefined, updateMessage: async () => undefined as unknown as Message, findMessageByProviderId: async () => undefined };
  const unthreaded = createChannelRegistry({
    modes,
    factories: { whatsapp: { ...whatsAppTransportFactories({ fallback, logger: log, connector: { ...data, conversations: unthreadedConversations }, realClock }), ...liveFactory(unthreadedConversations) }, email: () => email },
  });
  const noticeDeps = { outbound, worldTime, unthreaded: (route: Parameters<typeof unthreaded.whatsapp>[0]) => unthreaded.whatsapp(route), logger: log };
  const notices = createNoticeSender(noticeDeps);
  const installerNotices = createInstallerNoticeSender(noticeDeps);
  const inbound: InboundDeps = {
    connector: data,
    filter: {
      verifier: social === undefined ? ({ verify: async () => ({ valid: false, reason: "LIVE_NOT_HERE" }) } as never) : testVerifier(),
      topicArn: () => TOPIC_ARN,
      simEnvelopeKey: key("sim-envelope"),
      numberIds: () => (social === undefined ? undefined : { phoneNumberId: AWS_ID, metaPhoneNumberId: META_ID }),
      stageTransports: () => modes.whatsapp.transports,
      worldMode: worldModeReader(data),
    },
    phoneHashKey: key("phone-hash"),
    nonceKey: key("nonce"),
    worldTime,
    kill,
    notices,
    queue: sink,
    actions: channelActions({ connector: data, realClock, logger: log }),
    media: { store: objects.mediaStore, mediaBucket: () => "Media", worlds: data.worlds, ...(social === undefined ? {} : { social }) },
    ...(social === undefined ? {} : { social }),
    fallback,
    metrics: logMetricSink(log),
    logger: log,
    realClock,
  };
  const hashPhone = (phone: string) => phoneHash(key("phone-hash"), phone);
  return {
    ...base,
    key,
    hashPhone,
    realClock,
    runtimeStore,
    kill,
    costs,
    sink,
    scheduler,
    dispatcher,
    timers,
    email,
    outbound,
    cases,
    summaries: createSummaryCheck(outbound, log),
    certificates,
    notices,
    installerNotices,
    inbound,
    simNow,
    newId,
  };
}
