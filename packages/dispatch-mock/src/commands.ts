// The three control routes of the dispatcher: reschedule, reassign and cancel an order. Each one
// moves the `META` row, appends the event and publishes it on the bus, in that order, so a bus outage
// leaves the event stored and a repeat of the same idempotency key publishes it (same `eventId`)
// without moving the order again. The dispatcher knows only its own states: it reschedules an order
// the product already closed, and the product answers `DISPATCH_AFTER_CLOSE` (FL-014).
import { encodeUlid, sha256Hex } from "@cuadrilla/shared";
import {
  CONFLICT_REASON,
  EVENT_TYPE_OF_ACTION,
  type CancelRequest,
  type ConflictReason,
  type DispatchAction,
  type ReassignRequest,
  type RescheduleRequest,
} from "./contract";
import { DispatchEvent, sameWindow, type DispatchEventId } from "./events";
import { DispatchEventItem, dispatchEventSk, eventOfItem, type DispatchOrderItem } from "./items";
import type { EventPublisher } from "./publisher";
import { DispatchConflictError, applyChange, type DispatchRecord, type DispatchStore, type OrderChange } from "./store";

export interface CommandDeps {
  readonly store: DispatchStore;
  readonly publisher: EventPublisher;
  /** Real clock, only for `createdAt`/`updatedAt`; business time is the caller's `occurredAtSim`. */
  readonly now: () => Date;
}

export type DispatchCommand =
  | { readonly action: "reschedule"; readonly workOrderNumber: string; readonly request: RescheduleRequest }
  | { readonly action: "reassign"; readonly workOrderNumber: string; readonly request: ReassignRequest }
  | { readonly action: "cancel"; readonly workOrderNumber: string; readonly request: CancelRequest };

export type CommandOutcome =
  | { readonly ok: true; readonly replayed: boolean; readonly event: DispatchEvent; readonly order: DispatchOrderItem; readonly events: readonly DispatchEventItem[] }
  | { readonly ok: false; readonly code: "NOT_FOUND" }
  | { readonly ok: false; readonly code: "CONFLICT"; readonly reason: ConflictReason };

/**
 * Deterministic `evt_<ULID>`: the time part is the simulated instant of the event and the entropy is
 * the SHA-256 of operator, number and idempotency key, so a repeated call can never mint a second id.
 */
export async function dispatchEventId(ispId: string, workOrderNumber: string, idempotencyKey: string, occurredAtSim: string): Promise<DispatchEventId> {
  const digest = await sha256Hex(`${ispId}\n${workOrderNumber}\n${idempotencyKey}`);
  const entropy = Uint8Array.from({ length: 10 }, (_, index) => Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16));
  return `evt_${encodeUlid(Date.parse(occurredAtSim), entropy)}`;
}

type Decision = { readonly change: Omit<OrderChange, "lastEventId" | "updatedAt">; readonly event: (eventId: DispatchEventId) => DispatchEvent } | { readonly conflict: ConflictReason };

// What the command does to the order as the dispatcher sees it; never looks at the product's state.
function decide(order: DispatchOrderItem, command: DispatchCommand): Decision {
  if (order.status === "CANCELLED") return { conflict: CONFLICT_REASON.ORDER_CANCELLED };
  const base = { ispId: order.ispId, workOrderNumber: order.workOrderNumber, reason: command.request.reason, occurredAtSim: command.request.occurredAtSim };
  switch (command.action) {
    case "reschedule": {
      const newWindow = command.request.newWindow;
      if (sameWindow(order.appointmentWindow, newWindow)) return { conflict: CONFLICT_REASON.UNCHANGED };
      return {
        change: { status: "RESCHEDULED", installerId: order.installerId, appointmentWindow: newWindow },
        event: (eventId) => ({ type: "WorkOrderRescheduled", detail: { eventId, ...base, previousWindow: order.appointmentWindow, newWindow } }),
      };
    }
    case "reassign": {
      const newInstallerId = command.request.newInstallerId;
      if (newInstallerId === order.installerId) return { conflict: CONFLICT_REASON.UNCHANGED };
      return {
        change: { status: "REASSIGNED", installerId: newInstallerId, appointmentWindow: order.appointmentWindow },
        event: (eventId) => ({ type: "WorkOrderReassigned", detail: { eventId, ...base, previousInstallerId: order.installerId, newInstallerId } }),
      };
    }
    case "cancel":
      return {
        change: { status: "CANCELLED", installerId: order.installerId, appointmentWindow: order.appointmentWindow },
        event: (eventId) => ({ type: "WorkOrderCancelled", detail: { eventId, ...base } }),
      };
  }
}

function priorOf(record: DispatchRecord, idempotencyKey: string): DispatchEventItem | undefined {
  return record.events.find((event) => event.idempotencyKey === idempotencyKey);
}

// The key was applied before (by this caller or by a concurrent twin): publish the stored event again.
async function replay(deps: CommandDeps, record: DispatchRecord, prior: DispatchEventItem, action: DispatchAction): Promise<CommandOutcome> {
  if (prior.type !== EVENT_TYPE_OF_ACTION[action]) return { ok: false, code: "CONFLICT", reason: CONFLICT_REASON.IDEMPOTENCY_KEY_REUSED };
  const event = eventOfItem(prior);
  await deps.publisher.publish(event);
  return { ok: true, replayed: true, event, order: record.order, events: record.events };
}

export async function runCommand(deps: CommandDeps, command: DispatchCommand): Promise<CommandOutcome> {
  const { ispId, idempotencyKey, occurredAtSim } = command.request;
  const record = await deps.store.load(ispId, command.workOrderNumber);
  if (record === undefined) return { ok: false, code: "NOT_FOUND" };
  const prior = priorOf(record, idempotencyKey);
  if (prior !== undefined) return replay(deps, record, prior, command.action);

  const decision = decide(record.order, command);
  if ("conflict" in decision) return { ok: false, code: "CONFLICT", reason: decision.conflict };

  const eventId = await dispatchEventId(ispId, record.order.workOrderNumber, idempotencyKey, occurredAtSim);
  const event = DispatchEvent.parse(decision.event(eventId));
  const at = deps.now().toISOString();
  const change: OrderChange = { ...decision.change, lastEventId: eventId, updatedAt: at };
  const order = record.order;
  const item = DispatchEventItem.parse({
    PK: order.PK,
    SK: dispatchEventSk(occurredAtSim, eventId),
    entity: "DispatchEvent",
    type: event.type,
    detail: event.detail,
    idempotencyKey,
    createdAt: at,
    updatedAt: at,
    version: 1,
    clockId: order.clockId,
    ...(order.world === undefined ? {} : { world: order.world }),
    ...(order.runId === undefined ? {} : { runId: order.runId }),
    ...(order.expiresAt === undefined ? {} : { expiresAt: order.expiresAt }),
  });

  try {
    await deps.store.commit(order, change, item);
  } catch (error) {
    if (!(error instanceof DispatchConflictError)) throw error;
    const again = await deps.store.load(ispId, command.workOrderNumber);
    const twin = again === undefined ? undefined : priorOf(again, idempotencyKey);
    if (again !== undefined && twin !== undefined) return replay(deps, again, twin, command.action);
    return { ok: false, code: "CONFLICT", reason: CONFLICT_REASON.VERSION_CONFLICT };
  }

  await deps.publisher.publish(event);
  return { ok: true, replayed: false, event, order: applyChange(order, change), events: [...record.events, item] };
}
