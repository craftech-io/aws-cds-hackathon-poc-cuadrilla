// The installer queue and its consumers (docs/architecture.md §7 and §14, ADR-0017, docs/build-plan.md
// WP-27): everything that talks to an installer or changes their work goes through one FIFO queue,
// one message group per installer, so a voice note, a supervisor's button and an expiring rung of the
// same installer never run in parallel.
//
//   InstallerEvents.fifo   MessageGroupId = installerId, MessageDeduplicationId = eventId, set by every
//                          producer (content-based deduplication stays off; `Runtime/IDEMP#` is the
//                          second guard). Visibility 720 s, twice the worker's timeout; after 5 receives
//                          an event goes to InstallerEventsDlq.fifo.
//   InstallerEventsDlq     FIFO, 14 days of retention; read and cleaned only by the QaDriver (`dlq.find`,
//                          `dlq.delete`). Its alarm is one of the §12 alarms (infra/observability.ts,
//                          WP-38), named `<app>-<stage>-InstallerEventsDlq…` so it stays inside the
//                          QaDriver's `cloudwatch:DescribeAlarmHistory` fence (IAM_ARNS.dlqAlarm).
//   InstallerWorker        timeout 360 s, batch 1, and ScalingConfig.MaximumConcurrency 10 on the event
//                          source mapping INSTEAD of reserved concurrency: a burst would otherwise
//                          throttle receives, and every throttled receive counts toward maxReceiveCount.
//                          Turns of one installer are sequential; concurrency is across installers.
//   ChannelEvents          SES events of the configuration set (EventBridge rule of
//                          infra/messaging-email.ts, WP-20) → message states and EMAIL_EVENT.
//   FeedEvents             events of the Feeds bus (rule of infra/feeds.ts, WP-24) → DISPATCH_EVENT.
//
// Least privilege (docs/architecture.md §14, infra/iam-capabilities.ts). SST would give a linked queue
// `sqs:*`; this module wraps sst.aws.Queue (it is the only one that creates queues) so a link carries
// the queue's url and exactly one role: `sqs:SendMessage` on InstallerEvents for its producers, the two
// DLQ actions of QA_DRIVER_DLQ_ONLY_ACTIONS on InstallerEventsDlq for the QaDriver. The worker's own
// statement is the one its event source mapping polls with, on InstallerEvents only (the four actions
// of its row in infra/iam-capabilities.ts). Tables and buckets come by name (`linkNameOnly`)
// with `storagePermissions`, and the object grants no capability Linkable carries with
// `storageGrantPermissions`. Every other grant comes from the module that owns it: G1/G2/G3
// (infra/guardrail.ts), TIMERS (`Scheduler`, infra/scheduler.ts, which imports this module), and what
// modules built by other work packages of the same wave export, taken late (`WORKER_LATE_LINKS`,
// `LATE_CALLS`; infra/late-links.ts): until an owner exports it the deploy warns and the Lambda answers
// UNAVAILABLE for what needs it.
//
// Names. The queues have fixed physical names, `<app>-<stage>-InstallerEvents.fifo` and
// `…-InstallerEventsDlq.fifo`, inside the `sqs:<app>-*` fence of the CI deploy role
// (TopicsAndQueuesOfThisApp). SQS keeps a deleted name for 60 s: if a change ever forces a
// replacement, deploy the removal first.
//
// Cost: per request and per invocation; nothing bills while no installer event moves.
//
// Verify:
//   aws --profile craftech-demos sqs get-queue-url --queue-name aws-cds-hackathon-poc-cuadrilla-poc-InstallerEvents.fifo
//   aws --profile craftech-demos sqs get-queue-attributes --queue-url <url> --attribute-names All
//     → FifoQueue true · ContentBasedDeduplication false · VisibilityTimeout 720 · SqsManagedSseEnabled true ·
//       RedrivePolicy {maxReceiveCount 5, deadLetterTargetArn …-InstallerEventsDlq.fifo}
//   aws --profile craftech-demos lambda list-event-source-mappings --function-name <InstallerWorker name>
//     → BatchSize 1 · ScalingConfig.MaximumConcurrency 10 · State Enabled
//   aws --profile craftech-demos lambda get-function-concurrency --function-name <InstallerWorker name>   → {} (none reserved)

import { ChannelModes } from "./channel-modes";
import { CostCaps } from "./cost-caps";
import { GuardrailG1, GuardrailG2, GuardrailG3 } from "./guardrail";
import { CAPABILITIES, QA_DRIVER_DLQ_ONLY_ACTIONS, expectedGrants, type CapabilityName, type Condition, type LambdaName } from "./iam-capabilities";
import { lateLinks, links, type LinkList } from "./late-links";
import { BrandConfig, SeedOverrides, SessionTokenKey, WhatsAppPhoneNumberId } from "./secrets";
import { evidenceBucket, mediaBucket, storageLinks, storagePermissions, storageResource } from "./storage";

/** The queue and its dead letters (docs/architecture.md §7). */
export const INSTALLER_EVENTS = {
  visibilityTimeoutSeconds: 720,
  maxReceiveCount: 5,
  /** SQS's maximum: a dead-lettered event stays readable for the operator and the QaDriver. */
  dlqRetentionSeconds: 14 * 24 * 60 * 60,
} as const;

/** The consumer (docs/architecture.md §7, ADR-0017). No reserved concurrency, on purpose. */
export const INSTALLER_WORKER = {
  timeoutSeconds: 360,
  // Streams the Harness, polls Transcribe and runs the outbound pipeline; CPU scales with memory.
  memoryMb: 1024,
  batchSize: 1,
  maximumConcurrency: 10,
} as const;

/** ChannelEvents and FeedEvents: one EventBridge event each, a few writes and one SendMessage. */
export const EVENT_CONSUMER = { timeoutSeconds: 30, memoryMb: 256 } as const;

/** Lambda entries; each file belongs to the WP that writes the code (docs/build-plan.md §2). */
export const WORKERS_HANDLERS = {
  InstallerWorker: "packages/bff/src/handlers/installer-worker.handler", // WP-32
  ChannelEvents: "packages/bff/src/handlers/channel-events.handler", // WP-33
  FeedEvents: "packages/bff/src/handlers/feed-events.handler", // WP-33
} as const satisfies Partial<Record<LambdaName, string>>;

/** What the event source mapping polls with; granted on InstallerEvents.fifo and nothing else. */
export const QUEUE_CONSUMER_ACTIONS = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"] as const;

/** The only action a producer gets on the queue. */
export const QUEUE_PRODUCER_ACTIONS = ["sqs:SendMessage"] as const;

export type InstallerQueue = "InstallerEvents" | "InstallerEventsDlq";

/** Fixed physical name of a queue of the stage. */
export function queueName(app: string, stage: string, queue: InstallerQueue): string {
  return `${app}-${stage}-${queue}.fifo`;
}

// ---- Late reads of modules built in the same wave --------------------------------------------------

/** Modules of other work packages this infra reads once they have been evaluated. */
const LATE_MODULES = {
  agentcore: () => import("./agentcore"),
  certificates: () => import("./certificates"),
  media: () => import("./media"),
  "messaging-email": () => import("./messaging-email"),
  "messaging-whatsapp": () => import("./messaging-whatsapp"),
  mocks: () => import("./mocks"),
} as const satisfies Record<string, () => Promise<object>>;

export type LateModule = keyof typeof LATE_MODULES;

const loaded = new Map<LateModule, Promise<object>>();

/** One import per module of the wave, shared by every late read of this module and infra/scheduler.ts. */
export function lateModule(owner: LateModule): Promise<object> {
  const pending = loaded.get(owner) ?? LATE_MODULES[owner]();
  loaded.set(owner, pending);
  return pending;
}

/**
 * Capability Linkables the worker takes late (mode `optional`), each with its runtime properties and
 * exactly the grants of its capability: `Harness` (bedrock-agentcore:InvokeHarness, WP-26),
 * `Transcribe` (TRANSCRIBE, WP-21), `EmailChannel` (SEND_EMAIL with the recipient fence, WP-20), and
 * the `CertificateWriter` Function (WP-38; linking it grants InvokeFunction on it alone) that
 * close_installation invokes when the worker runs a "Cerrar instalación" tap (BUTTON_ACTION).
 */
export const WORKER_LATE_LINKS = { agentcore: ["Harness"], media: ["Transcribe"], "messaging-email": ["EmailChannel"], certificates: ["CertificateWriter"] } as const satisfies Partial<
  Record<LateModule, readonly string[]>
>;

/**
 * Functions of those modules called with the role's name: `mockLinks`/`mockPermissions` (the mocks a
 * role calls and the mocks' tables it writes, WP-24) and `whatsappPermissions` (the role's grants on our
 * WhatsApp number over whatsappPhoneArn(), none while it is `not-connected`, WP-24).
 */
export const LATE_CALLS = { mocks: ["mockLinks", "mockPermissions"], "messaging-whatsapp": ["whatsappPermissions"] } as const satisfies Partial<Record<LateModule, readonly string[]>>;

type LateCall = { [M in keyof typeof LATE_CALLS]: (typeof LATE_CALLS)[M][number] }[keyof typeof LATE_CALLS];

/** `exportName(fn)` of a module of the wave, once it has been evaluated; `[]` and a warning until it exports it. */
export function lateCall(consumer: string, owner: keyof typeof LATE_CALLS, exportName: LateCall, fn: LambdaName): $util.Output<unknown[]> {
  return $util.output(
    lateModule(owner).then((module): unknown[] | $util.Output<unknown[]> => {
      const call: unknown = Reflect.get(module, exportName);
      if (typeof call === "function") return (call as (role: LambdaName) => unknown[] | $util.Output<unknown[]>)(fn);
      $util.log.warn(`infra/${owner}.ts exports no ${exportName} yet: ${fn} (infra/${consumer}.ts) goes without it until it does.`);
      return [];
    }),
  ) as $util.Output<unknown[]>;
}

// ---- Object grants no capability Linkable carries ----------------------------------------------------

type Statement = { actions: string[]; resources: $util.Input<string>[]; conditions?: Array<{ test: string; variable: string; values: string[] }> };

export const conditionsOf = (conditions: readonly Condition[] | undefined) =>
  conditions ? { conditions: conditions.map((condition) => ({ test: condition.test, variable: condition.variable, values: [...condition.values] })) } : {};

/**
 * A role's grants whose resources are all storage of infra/storage.ts (a prefix of a bucket), except
 * those of the capabilities in `linked`, which reach it complete through their Linkable.
 */
export function storageGrantPermissions(fn: LambdaName, linked: readonly CapabilityName[] = []): Statement[] {
  const carried = new Set(linked.flatMap((name) => CAPABILITIES[name].grants));
  return expectedGrants(fn)
    .filter((grant) => !carried.has(grant) && grant.resources.every((resource) => storageResource(resource) !== undefined))
    .map((grant) => ({ actions: [...grant.actions], resources: grant.resources.map((resource) => storageResource(resource) as $util.Output<string>), ...conditionsOf(grant.conditions) }));
}

// ---- Queues ----------------------------------------------------------------------------------------

export const InstallerEventsDlq = new sst.aws.Queue("InstallerEventsDlq", {
  fifo: true,
  transform: {
    queue: {
      name: queueName($app.name, $app.stage, "InstallerEventsDlq"),
      messageRetentionSeconds: INSTALLER_EVENTS.dlqRetentionSeconds,
      sqsManagedSseEnabled: true,
    },
  },
});

export const InstallerEvents = new sst.aws.Queue("InstallerEvents", {
  fifo: { contentBasedDeduplication: false },
  visibilityTimeout: `${INSTALLER_EVENTS.visibilityTimeoutSeconds} seconds`,
  dlq: { queue: InstallerEventsDlq.arn, retry: INSTALLER_EVENTS.maxReceiveCount },
  transform: {
    queue: {
      name: queueName($app.name, $app.stage, "InstallerEvents"),
      sqsManagedSseEnabled: true,
    },
  },
});

/** What linking a queue hands a Lambda: `Resource.<Queue>.url` and the one role of that queue, never `sqs:*`. */
export function queueLink(queue: sst.aws.Queue) {
  const actions = queue === InstallerEventsDlq ? QA_DRIVER_DLQ_ONLY_ACTIONS : QUEUE_PRODUCER_ACTIONS;
  return { properties: { url: queue.url }, include: [sst.aws.permission({ actions: [...actions], resources: [queue.arn] })] };
}

sst.Linkable.wrap(sst.aws.Queue, queueLink);

// ---- InstallerWorker -------------------------------------------------------------------------------

const WORKER: LambdaName = "InstallerWorker";

export const installerWorker = new sst.aws.Function(WORKER, {
  description: "Consumes InstallerEvents.fifo one event per installer at a time: voice, safety, agent turns, cases, bridge, timers, feeds.",
  handler: WORKERS_HANDLERS.InstallerWorker,
  timeout: `${INSTALLER_WORKER.timeoutSeconds} seconds`,
  memory: `${INSTALLER_WORKER.memoryMb} MB`,
  link: links(
    [
      // Its tables; Media and Evidence by name only (Transcribe input and output, media of the sends).
      ...storageLinks(WORKER).filter((linked) => linked !== mediaBucket && linked !== evidenceBucket),
      mediaBucket,
      evidenceBucket,
      // G1: pre-filter of untrusted text; G2 and G3: the outbound pipeline (PIPELINE).
      GuardrailG1,
      GuardrailG2,
      GuardrailG3,
      ChannelModes,
      CostCaps,
      // Session tokens and hashes, the sending number, the live world and demo recipients, the brand.
      SessionTokenKey,
      WhatsAppPhoneNumberId,
      SeedOverrides,
      BrandConfig,
      // Re-enqueues (a TIMER that is not due yet, AGENT_TURN after an inbound message).
      InstallerEvents,
    ],
    // TIMERS: infra/scheduler.ts imports this module, so its Linkable arrives late; it always exists.
    lateLinks("workers", "scheduler", () => import("./scheduler"), ["Scheduler"]),
    ...(Object.keys(WORKER_LATE_LINKS) as Array<keyof typeof WORKER_LATE_LINKS>).map(
      (owner): LinkList => lateLinks("workers", owner, () => lateModule(owner), WORKER_LATE_LINKS[owner], "optional"),
    ),
    lateCall("workers", "mocks", "mockLinks", WORKER),
  ),
  permissions: $util
    .all([
      [{ actions: [...QUEUE_CONSUMER_ACTIONS], resources: [InstallerEvents.arn] }],
      storagePermissions(WORKER),
      // SEND_WHATSAPP's reads of certificates and photos; TRANSCRIBE's prefixes come with `Transcribe`.
      storageGrantPermissions(WORKER, ["TRANSCRIBE"]),
      lateCall("workers", "mocks", "mockPermissions", WORKER),
      lateCall("workers", "messaging-whatsapp", "whatsappPermissions", WORKER),
    ])
    .apply((parts) => parts.flat() as Statement[]),
});

/** One event per invocation; at most 10 installers at once (ADR-0017). */
export const installerWorkerEvents = new aws.lambda.EventSourceMapping("InstallerWorkerEvents", {
  eventSourceArn: InstallerEvents.arn,
  functionName: installerWorker.arn,
  batchSize: INSTALLER_WORKER.batchSize,
  scalingConfig: { maximumConcurrency: INSTALLER_WORKER.maximumConcurrency },
});

// ---- Event consumers -------------------------------------------------------------------------------

/**
 * A consumer of EventBridge events that turns them into installer events. Its rule, target and
 * resource policy (`events.amazonaws.com` with the rule as SourceArn) belong to the module that owns
 * the event source: infra/messaging-email.ts (ChannelEvents) and infra/feeds.ts (FeedEvents).
 */
function eventConsumer(name: "ChannelEvents" | "FeedEvents", description: string): sst.aws.Function {
  return new sst.aws.Function(name, {
    description,
    handler: WORKERS_HANDLERS[name],
    timeout: `${EVENT_CONSUMER.timeoutSeconds} seconds`,
    memory: `${EVENT_CONSUMER.memoryMb} MB`,
    link: [...storageLinks(name), InstallerEvents],
    permissions: storagePermissions(name),
  });
}

export const channelEvents = eventConsumer("ChannelEvents", "SES events of the configuration set: message and outbox states, EMAIL_EVENT to the installer queue.");

export const feedEvents = eventConsumer("FeedEvents", "Events of the Feeds bus (mock dispatch): DISPATCH_EVENT to the installer queue, deduplicated.");
