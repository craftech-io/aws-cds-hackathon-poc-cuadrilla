// Test support for the producers of the installer queue (never imported by runtime code): the worker's
// producer over a sender that records the FIFO messages (and fails on demand), a logger that keeps its
// lines, and a world over the in-memory connector with the orders of docs/seed-spec.md the dispatcher changes:
// 24817 and 24819 of Rogelio in the demo world, Karina's 24820, and the clone `wo-24817-g07` of the
// guest world 07 (numbers repeat across guest worlds).
import { type DispatchEvent, toBusEvent } from "@cuadrilla/dispatch-mock/events";
import { T0, testConnector, workOrder } from "../connector/testing";
import type { Connector } from "../connector/ports";
import { type Logger, createLogger } from "../lib/log";
import { type QueueMessage, type QueueSend, createEventSink } from "../worker/sink";
import type { QueueSink } from "./queue-events";

export const DEMO = "GLOBAL#isp-demo";
export const GUEST = "GUEST#isp-guest-07";
export const TIME_ZONE = "America/Mexico_City";
/** 07:40 of Tuesday 13/10 in the demo world. */
export const SIM_NOW = new Date("2026-10-13T07:40:00-06:00");

export interface RecordingSender {
  readonly send: QueueSend;
  readonly messages: QueueMessage[];
  /** The next `count` sends throw, as SQS would after the SDK's retries. */
  failNext(count?: number): void;
}

export function recordingSender(): RecordingSender {
  const messages: QueueMessage[] = [];
  let failures = 0;
  return {
    messages,
    failNext: (count = 1) => {
      failures = count;
    },
    send: async (message) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("SendMessage failed: InternalError");
      }
      messages.push(message);
    },
  };
}

/** The worker's producer (worker/sink.ts) over a recording sender. */
export function recordingSink(data: Pick<Connector, "worlds">, sender: RecordingSender): QueueSink {
  return createEventSink({ data, send: sender.send });
}

export function captureLogger(): { readonly logger: Logger; readonly lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({ level: "debug", sink: (line) => lines.push(line) }), lines };
}

/** The bodies of the recorded messages, parsed. */
export function queuedBodies(sender: RecordingSender): Array<Record<string, unknown>> {
  return sender.messages.map((message) => JSON.parse(message.body) as Record<string, unknown>);
}

export async function feedWorld() {
  const world = testConnector(T0);
  const { connector } = world;
  const orders = [
    workOrder(),
    workOrder({ workOrderId: "wo-24819", workOrderNumber: "24819", appointmentWindow: { startSim: "2026-10-13T14:00:00-06:00", endSim: "2026-10-13T16:00:00-06:00" } }),
    workOrder({ workOrderId: "wo-24820", workOrderNumber: "24820", installerId: "inst-karina", customerId: "cust-10424" }),
    workOrder({ workOrderId: "wo-24817-g07", ispId: "isp-guest-07", clockId: GUEST, installerId: "inst-rogelio-g07", customerId: "cust-10421-g07" }),
  ];
  for (const order of orders) await connector.workOrders.createWorkOrder(order);
  const sender = recordingSender();
  const { logger, lines } = captureLogger();
  const queue = recordingSink(connector, sender);
  return { world, connector, sender, queue, logger, lines };
}

let sequence = 0;

/** A dispatcher's event id (`evt_<ULID>`), new on every call. */
export function nextEventId(): string {
  sequence += 1;
  return `evt_01J9ZQX${String(sequence).padStart(19, "0")}`;
}

const DELIVERY = { id: "5f0c3b7e-0000-4000-8000-000000000001", time: "2026-10-13T13:40:00Z", account: "776805327629", region: "us-east-1" };

export function rescheduled(overrides: Partial<Extract<DispatchEvent, { type: "WorkOrderRescheduled" }>["detail"]> = {}): DispatchEvent {
  return {
    type: "WorkOrderRescheduled",
    detail: {
      eventId: nextEventId(),
      ispId: "isp-demo",
      workOrderNumber: "24817",
      reason: "CUSTOMER_REQUEST",
      occurredAtSim: "2026-10-13T07:40:00-06:00",
      previousWindow: { start: "2026-10-13T09:00:00-06:00", end: "2026-10-13T11:00:00-06:00" },
      newWindow: { start: "2026-10-14T09:00:00-06:00", end: "2026-10-14T11:00:00-06:00" },
      ...overrides,
    },
  };
}

export function reassigned(overrides: Partial<Extract<DispatchEvent, { type: "WorkOrderReassigned" }>["detail"]> = {}): DispatchEvent {
  return {
    type: "WorkOrderReassigned",
    detail: {
      eventId: nextEventId(),
      ispId: "isp-demo",
      workOrderNumber: "24819",
      reason: "WORKLOAD_BALANCE",
      occurredAtSim: "2026-10-13T07:40:00-06:00",
      previousInstallerId: "inst-rogelio",
      newInstallerId: "inst-karina",
      ...overrides,
    },
  };
}

export function cancelled(overrides: Partial<Extract<DispatchEvent, { type: "WorkOrderCancelled" }>["detail"]> = {}): DispatchEvent {
  return {
    type: "WorkOrderCancelled",
    detail: { eventId: nextEventId(), ispId: "isp-demo", workOrderNumber: "24817", reason: "CUSTOMER_REQUEST", occurredAtSim: "2026-10-13T07:40:00-06:00", ...overrides },
  };
}

/** The event as the `Feeds` rule hands it to `FeedEvents`. */
export function onBus(event: DispatchEvent): Record<string, unknown> {
  return toBusEvent(event, DELIVERY);
}
