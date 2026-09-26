// Storage port of the mock and its in-memory adapter (unit tests and the in-process flows of
// tests/flows). The DynamoDB adapter is store-dynamo.ts. A change is one atomic step: the order moves
// only if its `version` is still the one read, and the event is appended only if it is new.
import type { InstallerId } from "@cuadrilla/shared";
import type { DispatchOrderStatus } from "./contract";
import type { AppointmentWindow, DispatchEventId } from "./events";
import { DISPATCH_META_SK, DispatchEventItem, DispatchOrderItem, dispatchOrderPk } from "./items";

export interface DispatchRecord {
  readonly order: DispatchOrderItem;
  /** Events of the order, oldest first. */
  readonly events: readonly DispatchEventItem[];
}

/** Attributes a control route changes on the `META` row (the rest belongs to the world factory). */
export interface OrderChange {
  readonly status: DispatchOrderStatus;
  readonly installerId: InstallerId;
  readonly appointmentWindow: AppointmentWindow;
  readonly lastEventId: DispatchEventId;
  /** Real instant of the write. */
  readonly updatedAt: string;
}

export interface DispatchStore {
  load(ispId: string, workOrderNumber: string): Promise<DispatchRecord | undefined>;
  /**
   * Applies `change` to `order` if its version is still `order.version` and appends `event`.
   * Throws `DispatchConflictError` when either condition fails; nothing is written then.
   */
  commit(order: DispatchOrderItem, change: OrderChange, event: DispatchEventItem): Promise<void>;
}

/** The order moved since it was read, or the event already exists. */
export class DispatchConflictError extends Error {
  override readonly name = "DispatchConflictError";
}

/** The order after a change, as `commit` leaves it. */
export function applyChange(order: DispatchOrderItem, change: OrderChange): DispatchOrderItem {
  return { ...order, ...change, version: order.version + 1 };
}

export interface MemoryDispatchStore extends DispatchStore {
  /** Writes (or replaces) the `META` row of an order, as the seed and the world factory do. */
  putOrder(order: DispatchOrderItem): void;
  /** Every row, `META` first and then events in key order, for assertions. */
  rows(ispId: string, workOrderNumber: string): ReadonlyArray<DispatchOrderItem | DispatchEventItem>;
}

export function memoryDispatchStore(orders: readonly DispatchOrderItem[] = []): MemoryDispatchStore {
  const partitions = new Map<string, { order: DispatchOrderItem; events: Map<string, DispatchEventItem> }>();

  const putOrder = (order: DispatchOrderItem): void => {
    const row = DispatchOrderItem.parse(order);
    const existing = partitions.get(row.PK);
    partitions.set(row.PK, { order: row, events: existing?.events ?? new Map() });
  };
  for (const order of orders) putOrder(order);

  const sortedEvents = (events: Map<string, DispatchEventItem>) => [...events.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, event]) => event);

  return {
    putOrder,
    rows(ispId, workOrderNumber) {
      const partition = partitions.get(dispatchOrderPk(ispId, workOrderNumber));
      return partition === undefined ? [] : [partition.order, ...sortedEvents(partition.events)];
    },
    async load(ispId, workOrderNumber) {
      const partition = partitions.get(dispatchOrderPk(ispId, workOrderNumber));
      if (partition === undefined) return undefined;
      return { order: structuredClone(partition.order), events: sortedEvents(partition.events).map((event) => structuredClone(event)) };
    },
    async commit(order, change, event) {
      const row = DispatchEventItem.parse(event);
      const partition = partitions.get(order.PK);
      if (partition === undefined || order.SK !== DISPATCH_META_SK || row.PK !== order.PK) throw new DispatchConflictError("the order does not exist");
      if (partition.order.version !== order.version) throw new DispatchConflictError("the order changed since it was read");
      if (partition.events.has(row.SK)) throw new DispatchConflictError("the event already exists");
      partition.order = DispatchOrderItem.parse(applyChange(partition.order, change));
      partition.events.set(row.SK, row);
    },
  };
}
