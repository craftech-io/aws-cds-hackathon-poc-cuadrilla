// The events of `InstallerEvents.fifo` as the `InstallerWorker` reads them (docs/architecture.md §7),
// validated with zod on both sides of the queue: producers import the schema of their type from here
// and enqueue through worker/sink.ts (`MessageGroupId = installerId`, `MessageDeduplicationId = eventId`).
//
//   INBOUND_MESSAGE    InboundWhatsApp (an installer's message, already stored and masked)
//   AGENT_TURN         InboundWhatsApp (ÓRDENES, "Ver órdenes"), the worker's own follow-ups, the
//                      console (CASE_CLOSED, EVIDENCE_OVERRIDDEN), FeedEvents' follow-up (WORK_ORDER_CHANGED)
//   BUTTON_ACTION      InboundWhatsApp (a button of the installer on a work order)
//   SUPERVISOR_ACTION  InboundWhatsApp (a supervisor's button or text about a case), the console
//   TIMER              ScheduleDispatch and the clock (`{clockId, timerKey, dueAtSim, version}`)
//   DISPATCH_EVENT     FeedEvents (rescheduled, reassigned, cancelled)
//   EMAIL_EVENT        ChannelEvents (an SES event about one of our emails)
//   OUTBOUND_SEND      the console and the QaDriver (a send a person orders)
//   HEALTH_PROBE       QaDriver (`probe.mocks`): no installer, its own FIFO group
//   POISON             QaDriver (`event.poison`), only `qa-*` worlds
//
// Every event of a world carries its operator, its world and the installer whose group it runs in
// (a supervisor's event runs in the group of the installer who owns the case, ADR-0017).
import { z } from "zod";
import {
  CaseId,
  ClockId,
  InstallerId,
  IsoInstant,
  IspId,
  PersonId,
  SupervisorId,
  TimerFiredBy,
  TurnTrigger,
  WorkOrderId,
  ispIdOfClock,
  parseClockId,
} from "@cuadrilla/shared";
import { BounceType } from "../channels/email/events";
import { Actor, JsonObject } from "../domain/common";
import { EmailEventType, EmailKind } from "../domain/conversations";

/** `maxReceiveCount` of the redrive policy (infra/workers.ts `INSTALLER_EVENTS`): the last attempt. */
export const MAX_RECEIVE_COUNT = 5;

/** `MessageDeduplicationId` (≤ 128 printable characters) and `IDEMP#<type>#<eventId>`. */
export const EventId = z.string().regex(/^[A-Za-z0-9_.:#=+/-]{1,128}$/, "expected an event id");

/** Events the `QaDriver` injects carry `qa-<40 hex>` ids, so `dlq.*` never touches a real one. */
export const QaEventId = z.string().regex(/^qa-[0-9a-f]{40}$/, "expected qa-<40 hex>");

export const InstallerEventType = z.enum(["INBOUND_MESSAGE", "AGENT_TURN", "BUTTON_ACTION", "SUPERVISOR_ACTION", "TIMER", "DISPATCH_EVENT", "EMAIL_EVENT", "OUTBOUND_SEND", "HEALTH_PROBE", "POISON"]);
export type InstallerEventType = z.infer<typeof InstallerEventType>;

/** A stored message of a person's thread (`Conversations`): the queue never carries its text. */
export const QueuedMessageRef = z.object({ personId: PersonId, sentAtSim: IsoInstant, messageId: z.string().min(1).max(200) });
export type QueuedMessageRef = z.infer<typeof QueuedMessageRef>;

const WorldEventBase = z.object({
  eventId: EventId,
  clockId: ClockId,
  ispId: IspId,
  /** `MessageGroupId`: the installer, also for the events of a supervisor about the installer's case. */
  installerId: InstallerId,
  correlationId: z.string().min(1).max(64).optional(),
});

export const InboundMessageEvent = WorldEventBase.extend({ type: z.literal("INBOUND_MESSAGE"), message: QueuedMessageRef });
export type InboundMessageEvent = z.infer<typeof InboundMessageEvent>;

/** A turn of the agent (docs/design-brief.md §5.1); without `workOrderId` the turn takes the installer's active order. */
export const AgentTurnEvent = WorldEventBase.extend({
  type: z.literal("AGENT_TURN"),
  trigger: TurnTrigger,
  workOrderId: WorkOrderId.optional(),
  caseId: CaseId.optional(),
  /** The inbound message the turn answers (ÓRDENES, "Ver órdenes"). */
  message: QueuedMessageRef.optional(),
  /** Simulated instant of what opened the turn; the world's "now" when absent. */
  eventAtSim: IsoInstant.optional(),
});
export type AgentTurnEvent = z.infer<typeof AgentTurnEvent>;

export const ButtonActionEvent = WorldEventBase.extend({
  type: z.literal("BUTTON_ACTION"),
  action: z.enum(["CONSULT_SUPERVISOR", "CLOSE_INSTALLATION", "CUSTOMER_OK"]),
  workOrderId: WorkOrderId,
  message: QueuedMessageRef,
  offerMessageId: z.string().min(1).max(200).optional(),
});
export type ButtonActionEvent = z.infer<typeof ButtonActionEvent>;

export const SupervisorActionEvent = WorldEventBase.extend({
  type: z.literal("SUPERVISOR_ACTION"),
  action: z.enum(["TAKE_CASE", "DECLINE_CASE", "CLOSE_CASE", "RELAY"]),
  supervisorId: SupervisorId,
  caseId: CaseId,
  /** The supervisor's tap or text; absent for an action taken from the console. */
  message: QueuedMessageRef.optional(),
  /** The ladder version the button was armed with: an older one is ignored and audited. */
  rungVersion: z.int().min(0).optional(),
  actor: Actor.optional(),
});
export type SupervisorActionEvent = z.infer<typeof SupervisorActionEvent>;

/** A `TIMER#` that fell due: the input of a schedule, or what the clock dispatches when it advances. */
export const TimerEvent = WorldEventBase.extend({
  type: z.literal("TIMER"),
  /** `timerRefKey` of connector/keys.ts. */
  timerKey: z.string().min(1).max(256),
  dueAtSim: IsoInstant,
  /** Version of the timer when it was scheduled: a timer fired with another one is ignored. */
  version: z.int().min(1),
  firedBy: TimerFiredBy,
});
export type TimerEvent = z.infer<typeof TimerEvent>;

/** A change of the dispatch system (docs/architecture-integrations.md §7), already deduplicated by FeedEvents. */
export const DispatchEvent = WorldEventBase.extend({
  type: z.literal("DISPATCH_EVENT"),
  workOrderId: WorkOrderId,
  change: z.enum(["RESCHEDULED", "REASSIGNED", "CANCELLED"]),
  occurredAtSim: IsoInstant,
  /** The dispatch event as the mock published it, validated by `apply_dispatch_event`. */
  detail: JsonObject.default({}),
});
export type DispatchEvent = z.infer<typeof DispatchEvent>;

/** channels/email/events.ts `EmailEventRecord`, across the queue. */
export const QueuedEmailEventRecord = z.object({
  type: EmailEventType,
  providerMessageId: z.string().min(1).max(256),
  atReal: IsoInstant,
  bounceType: BounceType.optional(),
  ispId: IspId,
  clockId: ClockId,
  mailId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  kind: EmailKind,
  workOrderId: WorkOrderId.optional(),
  detail: z.string().max(200).optional(),
});

export const EmailEventEvent = WorldEventBase.extend({ type: z.literal("EMAIL_EVENT"), record: QueuedEmailEventRecord });
export type EmailEventEvent = z.infer<typeof EmailEventEvent>;

/** A send a person ordered (console) or the QaDriver injected; the outbound pipeline validates `request`. */
export const OutboundSendEvent = WorldEventBase.extend({ type: z.literal("OUTBOUND_SEND"), author: Actor, request: JsonObject });
export type OutboundSendEvent = z.infer<typeof OutboundSendEvent>;

/** `GET /v1/health` of the mocks with the worker's role; the result lands in `Runtime/PROBE#<probeId>`. */
export const HealthProbeEvent = z.object({
  type: z.literal("HEALTH_PROBE"),
  eventId: QaEventId,
  probeId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, "expected a probe id"),
  correlationId: z.string().min(1).max(64).optional(),
});
export type HealthProbeEvent = z.infer<typeof HealthProbeEvent>;

/** An event that fails on purpose until the DLQ (FL-099 d), only in a scenario world. */
export const PoisonEvent = WorldEventBase.extend({
  type: z.literal("POISON"),
  eventId: QaEventId,
  clockId: ClockId.refine((clockId) => parseClockId(clockId)?.kind === "QA", "POISON only runs in qa-* worlds"),
});
export type PoisonEvent = z.infer<typeof PoisonEvent>;

export const InstallerQueueEvent = z.discriminatedUnion("type", [
  InboundMessageEvent,
  AgentTurnEvent,
  ButtonActionEvent,
  SupervisorActionEvent,
  TimerEvent,
  DispatchEvent,
  EmailEventEvent,
  OutboundSendEvent,
  HealthProbeEvent,
  PoisonEvent,
]);
export type InstallerQueueEvent = z.infer<typeof InstallerQueueEvent>;
export type InstallerQueueEventInput = z.input<typeof InstallerQueueEvent>;

/** An event of one installer in one world (every type but `HEALTH_PROBE`). */
export type WorldEvent = Exclude<InstallerQueueEvent, HealthProbeEvent>;

export function isWorldEvent(event: InstallerQueueEvent): event is WorldEvent {
  return event.type !== "HEALTH_PROBE";
}

/** The FIFO group: the installer (their events run one at a time, in order), or the probes' own group. */
export function messageGroupOf(event: InstallerQueueEvent): string {
  return isWorldEvent(event) ? event.installerId : "health-probe";
}

/** The body of a queue message that does not parse: a bug of its producer, never retried into a turn. */
export class MalformedEventError extends Error {
  override readonly name = "MalformedEventError";
}

function json(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new MalformedEventError("the queue message is not JSON");
  }
}

/** Validates an event on either side of the queue; the operator must be the one of the world (a producer bug otherwise). */
export function checkQueueEvent(value: unknown): InstallerQueueEvent {
  const parsed = InstallerQueueEvent.safeParse(value);
  if (!parsed.success) throw new MalformedEventError(`the queue message is not an event: ${parsed.error.issues.map((issue) => issue.path.join(".") || "(event)").join(", ")}`);
  if (isWorldEvent(parsed.data) && ispIdOfClock(parsed.data.clockId) !== parsed.data.ispId) throw new MalformedEventError("the operator is not the one of the world");
  return parsed.data;
}

/** Parses a body of the queue. */
export function parseQueueEvent(body: string): InstallerQueueEvent {
  return checkQueueEvent(json(body));
}

/** What a body says about itself before validation: enough to take a lost event out of `inFlight`. */
export const LooseIdentity = z
  .object({
    type: InstallerEventType.optional(),
    eventId: EventId.optional(),
    clockId: ClockId.optional(),
    ispId: IspId.optional(),
    installerId: InstallerId.optional(),
    correlationId: z.string().min(1).max(64).optional(),
  })
  .loose();
export type LooseIdentity = z.infer<typeof LooseIdentity>;

/** Best-effort identity of any body; never throws. */
export function looseIdentity(body: string): LooseIdentity {
  try {
    const parsed = LooseIdentity.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
