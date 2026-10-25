// What the `InstallerWorker` runs for each event, as ports (docs/architecture.md §7). The agent turn
// (turns/), the inbound pipeline, the timers' dispatch, the probe and the poison event are the worker's
// own (this folder); the rest are deterministic handlers of their modules, imported in process with
// `caller WORKER` (docs/tool-catalog.md, "Handlers de invocación directa") and wired by the Lambda
// entry (handlers/installer-worker.ts, worker/production.ts):
//
//   VoiceTranscriber   `transcribe_voice_note`                  media/ (WP-31)
//   SafetyPort         `classify_safety` / `handle_safety`      safety/ (WP-34)
//   CasePort           `open_case`, `relay_message`, supervisor actions, `advance_ladder(TIMEOUT)`, the
//                      factory's `case` preset (`CASE_PRESET`)                                     cases/ (WP-34)
//   WorkerNoticeSender the worker's fixed notices (`SYSTEM_NOTICE`) through the outbound pipeline   outbound/ (WP-28)
//   TimerPort          `fire_timer` (versions, `dueAtSim` re-evaluated)   timers/ (WP-36)
//   TimerHandlers      `fire_day_start`, `deferred_send`, `CERT_RETRY`   dayplan/ (WP-29), outbound/ (WP-28), certificates/ (WP-35)
//   EventHandlers      `apply_dispatch_event`, `apply_email_event`, `OUTBOUND_SEND`   feeds/ (WP-33), certificates/ (WP-35), outbound/ (WP-28)
//   OrderChoiceSender  the `ORDER_CHOICE` list of `set_active_work_order` (FL-013)    outbound/adapters.ts
//
// A handler throws to put the event back on the queue; whatever it enqueues goes through `ctx.sink`,
// so the follow-up is in flight before the current event leaves it.
import type { HazardCategory, PhotoItem } from "@cuadrilla/shared";
import type { TimerPort } from "../agent-tools/common/ports";
import type { InstallerNoticeSender, WorkOrderActions } from "../channels/whatsapp/ports";
import type { Message } from "../domain/conversations";
import type { Timer } from "../domain/timers";
import type { Logger } from "../lib/log";
import type { OrderChoiceSender } from "../outbound/adapters";
import type { CasePresetEvent, DispatchEvent, EmailEventEvent, InstallerQueueEventInput, OutboundSendEvent, SupervisorActionEvent, TimerEvent } from "./events";

/** The producer of follow-up events: marks them in flight, then sends them to the installer's group. */
export interface InstallerEventSink {
  enqueue(event: InstallerQueueEventInput): Promise<void>;
}

export interface WorkerContext {
  readonly log: Logger;
  readonly sink: InstallerEventSink;
  /** Real time; the simulated "now" of every rule is the event's or the world's clock. */
  readonly now: () => Date;
  /** `ApproximateReceiveCount` of the delivery (1 on the first one). */
  readonly receiveCount: number;
  /** Real instant (epoch ms) the Lambda ends at: `now + context.getRemainingTimeInMillis()`. */
  readonly lambdaDeadlineMs: number;
}

// ---- Fixed notices --------------------------------------------------------------------------------

/** The texts of copy/es-MX.ts the worker itself sends to the installer (`SYSTEM_NOTICE`). */
export type WorkerNoticeKey = "servicePaused" | "agentFallback" | "turnCap" | "guardrailRefusal" | "voiceUnclear" | "voiceTooLong" | "voiceFailed" | "itemChoicePrompt";

export interface WorkerNotice {
  readonly clockId: string;
  readonly ispId: string;
  /** The installer: the pipeline resolves the phone and its transport from the person. */
  readonly personId: string;
  readonly notice: WorkerNoticeKey;
  readonly text: string;
  /** `itemChoicePrompt`: one CHOOSE_ITEM button per photo item still to pass. */
  readonly buttons?: ReadonlyArray<{ readonly action: "CHOOSE_ITEM"; readonly item: PhotoItem }>;
  readonly workOrderId?: string;
  /** The inbound message it answers: a reply is exempt from quiet hours (`CP-QUIET-HOURS`). */
  readonly replyToMessageId?: string;
  readonly eventId: string;
}

/** `SYSTEM_NOTICE` through the outbound pipeline (policy, fence, transport, `Conversations`, `AuditLog`). */
export interface WorkerNoticeSender {
  send(notice: WorkerNotice): Promise<void>;
}

// ---- Voice notes ----------------------------------------------------------------------------------

export interface TranscriptionRequest {
  readonly clockId: string;
  readonly ispId: string;
  readonly installerId: string;
  /** The stored inbound voice note (its media key and duration). */
  readonly message: Message;
  readonly eventId: string;
}

/**
 * What `transcribe_voice_note` answers (docs/architecture-integrations.md §5). It reserves the world's
 * and the global transcription caps itself and stores the masked transcript on the message.
 */
export type TranscriptionOutcome =
  | { readonly status: "TRANSCRIBED"; readonly text: string; readonly confidence: number; readonly durationSec?: number }
  | { readonly status: "LOW_CONFIDENCE"; readonly confidence?: number }
  | { readonly status: "TOO_LONG" }
  | { readonly status: "FAILED" }
  | { readonly status: "CAP_REACHED"; readonly resetsAtReal?: string }
  | { readonly status: "PAUSED" };

export interface VoiceTranscriber {
  transcribe(request: TranscriptionRequest, ctx: WorkerContext): Promise<TranscriptionOutcome>;
}

// ---- Safety ---------------------------------------------------------------------------------------

export type SafetyClassification = { readonly matched: false } | { readonly matched: true; readonly category: HazardCategory; readonly lexiconVersion: string };

export interface SafetyHandling {
  readonly clockId: string;
  readonly ispId: string;
  readonly installerId: string;
  readonly workOrderId?: string;
  readonly category: HazardCategory;
  readonly lexiconVersion: string;
  /** The inbound message that described the hazard. */
  readonly messageId: string;
  readonly eventId: string;
  readonly atSim: string;
}

/** Deterministic, never cut by the kill switch (ADR-0016, ADR-0019). */
export interface SafetyPort {
  classify(text: string): Promise<SafetyClassification>;
  /** `SAFETY_INSTRUCTION` with the fixed §SEG-01 text and `open_case(SAFETY)` in parallel; the order goes `ON_HOLD_SAFETY`. */
  handle(input: SafetyHandling, ctx: WorkerContext): Promise<void>;
}

// ---- Cases ----------------------------------------------------------------------------------------

export interface OpenCaseRequest {
  readonly clockId: string;
  readonly ispId: string;
  readonly installerId: string;
  readonly workOrderId: string;
  readonly reason: "DENIED_TOPIC" | "PROMPT_INJECTION" | "OTHER";
  /** A fixed text of copy/ (`caseReason`), never the blocked text. */
  readonly summary: string;
  readonly eventId: string;
  readonly atSim: string;
}

export interface InstallerRelay {
  readonly clockId: string;
  readonly ispId: string;
  readonly installerId: string;
  readonly workOrderId: string;
  readonly caseId: string;
  /** The installer's stored message (text, transcript or photo), relayed without a model. */
  readonly message: Message;
  readonly eventId: string;
}

export interface CasePort {
  /** `open_case` with `caller WORKER`: one open case per order and reason (idempotent). */
  openCase(request: OpenCaseRequest, ctx: WorkerContext): Promise<{ readonly caseId: string }>;
  /** `relay_message` installer → supervisor while the case is `TAKEN` (`CP-BRIDGE`, FL-058). */
  relayFromInstaller(relay: InstallerRelay, ctx: WorkerContext): Promise<void>;
  /** `take_case`, `decline_case`, `close_case` or `relay_message` supervisor → installer; `close_case` enqueues `AGENT_TURN(CASE_CLOSED)`. */
  supervisorAction(event: SupervisorActionEvent, ctx: WorkerContext): Promise<void>;
  /** The world factory's `case` preset (cases/preset.ts); skipped when the order is of another epoch. */
  preset(event: CasePresetEvent, ctx: WorkerContext): Promise<void>;
}

// ---- Timers ---------------------------------------------------------------------------------------

export interface FiredTimer {
  readonly timer: Timer;
  readonly event: TimerEvent;
  /** `eventAtSim` of what the timer triggers: `dueAtSim` when the clock advances, `simNow` when forced. */
  readonly eventAtSim: string;
}

/** What each `kind` does once fired (docs/architecture.md §8). */
export interface TimerHandlers {
  /** `fire_day_start`: template, denial or `SKIPPED NO_WORK_ORDERS`, then `plan_day(day + 1)`. */
  dayStart(fired: FiredTimer, ctx: WorkerContext): Promise<void>;
  /** `advance_ladder(TIMEOUT, rungVersion)`. */
  caseTimeout(fired: FiredTimer, ctx: WorkerContext): Promise<void>;
  /** Re-evaluation and send of a deferred message. */
  deferredSend(fired: FiredTimer, ctx: WorkerContext): Promise<void>;
  /** One resend of the certificate after a transient failure. */
  certRetry(fired: FiredTimer, ctx: WorkerContext): Promise<void>;
}

// ---- Other events ---------------------------------------------------------------------------------

export interface EventHandlers {
  /** `apply_dispatch_event`; enqueues `AGENT_TURN(WORK_ORDER_CHANGED)` for each installer whose day it touches. */
  applyDispatchEvent(event: DispatchEvent, ctx: WorkerContext): Promise<void>;
  /** `apply_email_event`: deliveries of the certificate and of the alerts; a bounce or complaint → `CERTIFICATE_UNDELIVERED`. */
  applyEmailEvent(event: EmailEventEvent, ctx: WorkerContext): Promise<void>;
  /** A send a person ordered, through the outbound pipeline with its author. */
  outboundSend(event: OutboundSendEvent, ctx: WorkerContext): Promise<void>;
}

// ---- Probes ---------------------------------------------------------------------------------------

/** `GET /v1/health` of each mock with the worker's role (`probe.mocks`, `SMK/3`). */
export interface MockProbe {
  readonly name: string;
  health(log: Logger): Promise<boolean>;
}

/** Everything the worker reaches outside its own folder, by event. */
export interface WorkerPorts {
  readonly transcriber: VoiceTranscriber;
  readonly safety: SafetyPort;
  readonly cases: CasePort;
  readonly notices: WorkerNoticeSender;
  readonly orderChoice: OrderChoiceSender;
  /** `fire_timer`: conditional on the version, re-evaluating `dueAtSim` against the world clock (timers/, WP-36). */
  readonly timers: Pick<TimerPort, "fire">;
  readonly timerHandlers: TimerHandlers;
  readonly handlers: EventHandlers;
  /** `BUTTON_ACTION` (channels/whatsapp/button-actions.ts): the deterministic handlers and their fixed notice. */
  readonly buttons: { readonly actions: WorkOrderActions; readonly notices: InstallerNoticeSender };
  readonly probes: readonly MockProbe[];
}
