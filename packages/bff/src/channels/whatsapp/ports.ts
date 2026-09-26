// What the WhatsApp adapter needs from the rest of the product, as ports. The adapter decides; the
// ports act: the outbound pipeline sends every fixed notice (packages/bff/src/outbound/, so the
// contact policy and the audit log see it), the installer queue takes what a turn, a case or a button
// on a work order must do (`InstallerEvents.fifo`, `MessageGroupId = installerId`, ADR-0017), and the
// deterministic handlers of docs/tool-catalog.md run what a keyword asks for (`caller CHANNEL`, never a
// turn). A button on a work order is a `BUTTON_ACTION` the InstallerWorker runs (button-actions.ts).
import { createHash } from "node:crypto";
import { type ChecklistItem, type WhatsAppMode, type WhatsAppTransport, parseClockId } from "@cuadrilla/shared";
import type { Connector, MessageRef } from "../../connector/ports";
import type { JsonObject } from "../../domain/common";
import { type Clock, simNowOf, systemClock } from "../../lib/clock";
import type { Logger } from "../../lib/log";
import { MEXICO_CITY_TIME_ZONE } from "../../services/business-hours/zoned-time";
import type { ListRowSpec } from "./render";

// ---- Fixed notices ------------------------------------------------------------------------------

/** The texts of copy/es-MX.ts the channel sends as `SYSTEM_NOTICE`. */
export type NoticeKey =
  | "welcome"
  | "optInRequired"
  | "unknownNumber"
  | "optOutConfirmed"
  | "shiftRegistered"
  | "supervisorNoCase"
  | "unsupportedMedia"
  | "imageTooLarge"
  | "imageUnreadable"
  | "voiceTooLong"
  | "voiceFailed"
  | "closeNotComplete"
  | "buttonExpired"
  | "joinCodeInvalid"
  | "leaseInUse"
  | "leaseBound"
  | "caseChoice";

export interface NoticeRecipient {
  /** Absent for a number outside the allow list. */
  readonly personId?: string;
  readonly phone: string;
  readonly phoneHash: string;
  /**
   * The transport the inbound message came through: a fixed reply goes back the same way. (An
   * unknown live number is registered nowhere, so channels/registry.ts alone would keep it simulated.)
   */
  readonly transport: WhatsAppTransport;
}

export interface NoticeRequest {
  readonly clockId: string;
  readonly ispId: string;
  readonly recipient: NoticeRecipient;
  readonly notice: NoticeKey;
  readonly text: string;
  /** `wamid` of the inbound message it answers: a reply is exempt from quiet hours and opens no window. */
  readonly replyToWamid: string;
  /** `closeNotComplete`: `{ items: missing }` (FL-050). */
  readonly refs?: JsonObject;
  /** A list the person picks from (a supervisor with several cases); row ids are nonces. */
  readonly list?: { readonly button: string; readonly rows: readonly ListRowSpec[] };
}

export interface NoticeSender {
  send(request: NoticeRequest): Promise<void>;
}

/**
 * A fixed notice the worker sends to the installer of a queued event, answering the tap: no phone
 * travels in the queue; the outbound pipeline resolves the recipient and its transport from the person.
 */
export interface InstallerNotice extends Omit<NoticeRequest, "recipient" | "list"> {
  readonly personId: string;
}

export interface InstallerNoticeSender {
  send(notice: InstallerNotice): Promise<void>;
}

// ---- Installer queue ----------------------------------------------------------------------------

export type SupervisorAction = "TAKE_CASE" | "DECLINE_CASE" | "CLOSE_CASE" | "RELAY";

/** Buttons of an installer on a work order: they change the installer's work, so they run in the installer's queue. */
export type WorkOrderButton = "CONSULT_SUPERVISOR" | "CLOSE_INSTALLATION" | "CUSTOMER_OK";

interface QueuedBase {
  /** `MessageDeduplicationId` and `IDEMP#<type>#<eventId>` of the worker. */
  readonly eventId: string;
  readonly clockId: string;
  readonly ispId: string;
  /** `MessageGroupId`: the installer, also for events of a supervisor about the installer's case. */
  readonly installerId: string;
  /** The inbound message the event comes from. */
  readonly message: MessageRef;
}

export type ChannelQueueEvent =
  | (QueuedBase & { readonly type: "INBOUND_MESSAGE" })
  | (QueuedBase & { readonly type: "AGENT_TURN"; readonly trigger: "ORDERS_REQUESTED" })
  | (QueuedBase & { readonly type: "SUPERVISOR_ACTION"; readonly action: SupervisorAction; readonly supervisorId: string; readonly caseId: string })
  | (QueuedBase & {
      readonly type: "BUTTON_ACTION";
      readonly action: WorkOrderButton;
      readonly workOrderId: string;
      /** The message that offered the button (its nonce's `messageId`): the sections a consult cites. */
      readonly offerMessageId?: string;
    });

export interface EventQueue {
  /** Marks the event in flight for the installer and the world, then `SendMessage` (docs/architecture.md §7). */
  enqueue(event: ChannelQueueEvent): Promise<void>;
}

/** Event id of an inbound message in its world: a redelivery of the same `wamid` is the same event. */
export function inboundEventId(clockId: string, wamid: string, purpose = "in"): string {
  return `wa-${purpose}-${createHash("sha256").update(`${clockId}\n${wamid}`, "utf8").digest("hex").slice(0, 40)}`;
}

// ---- Deterministic handlers (caller CHANNEL) ----------------------------------------------------

export interface ChannelActionInput {
  readonly clockId: string;
  readonly ispId: string;
  readonly personId: string;
  /** Simulated instant of the world when the message arrived. */
  readonly atSim: string;
  /** The inbound message (`wamid`) that asked for it. */
  readonly sourceMessageId: string;
  readonly eventId: string;
}

export interface WorkOrderActionInput extends ChannelActionInput {
  readonly workOrderId: string;
}

export type CloseOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "NOT_COMPLETE"; readonly missing: readonly ChecklistItem[] }
  | { readonly ok: false; readonly code: "FAILED" };

/** What `InboundWhatsApp` runs itself for a keyword: the person's consent and a supervisor's shift, never a work order. */
export interface ChannelActions {
  /** `record_consent` with medium `WHATSAPP_KEYWORD` and the poster's text version. */
  recordConsent(input: ChannelActionInput & { readonly textVersion: string }): Promise<void>;
  revokeConsent(input: ChannelActionInput): Promise<void>;
  /** `register_shift` (plan B "TURNO"): the supervisor's shift window. */
  registerShift(input: ChannelActionInput): Promise<{ readonly closesAtSim: string }>;
}

/**
 * What the InstallerWorker runs for a `BUTTON_ACTION` (`caller CHANNEL`: the tap is the installer's,
 * not a turn), inside the installer's message group, with the worker's PIPELINE, TIMERS, MOCK_NETWORK
 * and CertificateWriter invoke.
 */
export interface WorkOrderActions {
  /**
   * `open_case(OUT_OF_MANUAL)` from the "Consultar a mi supervisor" button (FL-031), with what the
   * summary is built from: the last question (already masked) and the sections of the offer.
   */
  openConsultCase(input: WorkOrderActionInput & { readonly question?: string; readonly citations: readonly string[] }): Promise<void>;
  /** `close_installation(INSTALLED)` from the "Cerrar instalación" button (FL-047, FL-050). */
  closeInstallation(input: WorkOrderActionInput): Promise<CloseOutcome>;
  /** `record_customer_ok` from the "Cliente conforme" button. */
  recordCustomerOk(input: WorkOrderActionInput): Promise<void>;
}

// ---- Metrics ------------------------------------------------------------------------------------

/** Metrics of `CuadrillaAgent/*` the channel emits (docs/architecture.md §12). */
export type ChannelMetric = "ForeignPhoneNumberEvents" | "UnknownSenderReplies" | "WhatsAppTemplateCategory" | "WhatsAppWindowFallback";

export interface MetricSink {
  count(metric: ChannelMetric, dimensions?: Readonly<Record<string, string>>): void;
}

/** One JSON line per data point, for the metric filters of the Lambda's log group. */
export function logMetricSink(logger: Logger): MetricSink {
  return { count: (metric, dimensions = {}) => logger.info("metric", { metric, value: 1, ...dimensions }) };
}

// ---- World time ---------------------------------------------------------------------------------

export interface WorldTime {
  readonly simNow: Date;
  readonly worldEpoch: number;
  readonly timeZone: string;
}

export type WorldTimeReader = (clockId: string) => Promise<WorldTime | undefined>;

/** Simulated "now" of a world from `Runtime/CLOCK#` (ADR-0010); `undefined` when the world does not exist. */
export function connectorWorldTime(connector: Pick<Connector, "runtime" | "isps">, realClock: Clock = systemClock): WorldTimeReader {
  return async (clockId) => {
    const clock = await connector.runtime.getClock(clockId);
    if (clock === undefined) return undefined;
    const settings = await connector.isps.getSettings(clock.ispId);
    const realNow = (await realClock.now()).getTime();
    return { simNow: simNowOf(clock, realNow), worldEpoch: clock.worldEpoch, timeZone: settings?.timezone ?? MEXICO_CITY_TIME_ZONE };
  };
}

/** `Isps/SETTINGS.whatsappMode` of a world; `undefined` for an invalid clock or a world that does not exist. */
export function worldModeReader(connector: Pick<Connector, "isps">): (clockId: string) => Promise<WhatsAppMode | undefined> {
  return async (clockId) => {
    const world = parseClockId(clockId);
    if (world === undefined) return undefined;
    const settings = await connector.isps.getSettings(world.ispId);
    return settings?.clockId === clockId ? settings.whatsappMode : undefined;
  };
}
