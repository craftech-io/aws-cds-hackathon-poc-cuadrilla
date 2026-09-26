// Work orders of a world (docs/seed-spec.md §7) and what the mocks of external systems hold for them:
// the ONU of each order in the network orchestrator (`Network`, with its behaviour) and the order in
// the dispatcher (`Dispatch`). Orders of 13/10 and 14/10 start with the five checklist items
// PENDING; the orders closed on 12/10 get their checklist, evidence and certificate from history.ts.
import { ChecklistItem } from "@cuadrilla/shared";
import { dispatchOrderPk } from "../../../packages/dispatch-mock/src/items";
import { newOnuRow } from "../../../packages/network-mock/src/rows";
import type { SeedItem } from "../lib/tables";
import { ONU_MODEL, staff, zoneOfOrder, type OrderDef } from "./catalog";
import { SEED_CLOCK, SEED_META, row } from "./context";
import { DAYS, addMinutes, sim } from "./time";
import type { WorldSpec } from "./world";

/** Minutes after the window starts: the order's closing on 12/10. */
export const HISTORY_CLOSE_AFTER_MIN = 95;

export function windowOf(order: Pick<OrderDef, "date" | "window">): { startSim: string; endSim: string } {
  return { startSim: sim(order.date, order.window[0]), endSim: sim(order.date, order.window[1]) };
}

export function isClosedHistory(order: Pick<OrderDef, "date">): boolean {
  return order.date === DAYS.history;
}

export function closedAt(order: Pick<OrderDef, "date" | "window">): string {
  return addMinutes(windowOf(order).startSim, HISTORY_CLOSE_AFTER_MIN);
}

function workOrderItem(world: WorldSpec, order: OrderDef): SeedItem {
  const installer = staff(order.installerId);
  const zone = zoneOfOrder(order);
  const workOrderId = world.workOrderId(order.number);
  const window = windowOf(order);
  const base = {
    workOrderId,
    workOrderNumber: order.number,
    ispId: world.ispId,
    clockId: world.clockId,
    sessionEpoch: 0,
    installerId: world.personId(order.installerId),
    customerId: world.customerId(order.customer),
    crewId: installer.crewId,
    zoneId: zone.zoneId,
    date: order.date,
    appointmentWindow: window,
    plan: order.plan,
    onuSerial: order.serial,
    onuModel: ONU_MODEL,
    oltPort: order.oltPort,
    opticalClass: zone.opticalClass,
    onHoldSafety: false,
  };
  if (!isClosedHistory(order)) return row("WorkOrder", { ...base, status: "SCHEDULED" });
  const closed = closedAt(order);
  const started = addMinutes(window.startSim, 10);
  const actor = `PERSON:${world.personId(order.installerId)}`;
  return row("WorkOrder", {
    ...base,
    status: "CLOSED",
    closedAtSim: closed,
    lastOnuReading: { operState: "ONLINE", rxPowerDbm: order.rxDbm, inRange: true, observedAtSim: addMinutes(closed, -2), source: "CLOSE" },
    history: [
      { field: "status", from: "SCHEDULED", to: "IN_PROGRESS", atSim: started, atReal: started, actor },
      { field: "status", from: "IN_PROGRESS", to: "CLOSED", atSim: closed, atReal: closed, actor: "SYSTEM", reason: "close_installation" },
    ],
  });
}

function pendingChecklist(world: WorldSpec, order: OrderDef): SeedItem[] {
  return ChecklistItem.options.map((item) => row("ChecklistItem", { workOrderId: world.workOrderId(order.number), clockId: world.clockId, item, status: "PENDING", attempts: 0 }));
}

export function workOrderItems(world: WorldSpec): SeedItem[] {
  return world.orders.flatMap((order) => [workOrderItem(world, order), ...(isClosedHistory(order) ? [] : pendingChecklist(world, order))]);
}

/** The ONU of every order in the orchestrator of the world, with the behaviour its story needs. */
export function networkItems(world: WorldSpec): SeedItem[] {
  return world.orders.map((order) => {
    const onu = newOnuRow({
      clockId: world.clockId,
      serial: order.serial,
      behaviour: order.behaviour,
      ...(order.rxDbm === undefined ? {} : { rxPowerDbm: order.rxDbm }),
      oltPort: order.oltPort,
      profile: order.plan,
      nowIso: SEED_CLOCK,
      synthetic: true,
    });
    return { ...onu } as SeedItem;
  });
}

/** Every order in the dispatcher: the master data it answers and publishes events about. */
export function dispatchItems(world: WorldSpec): SeedItem[] {
  return world.orders.map((order) => {
    const window = windowOf(order);
    return {
      PK: dispatchOrderPk(world.ispId, order.number),
      SK: "META",
      entity: "DispatchOrder",
      createdAt: SEED_META.createdAt,
      updatedAt: SEED_META.updatedAt,
      version: SEED_META.version,
      clockId: world.clockId,
      synthetic: true,
      ispId: world.ispId,
      workOrderNumber: order.number,
      workOrderId: world.workOrderId(order.number),
      installerId: world.personId(order.installerId),
      customerId: world.customerId(order.customer),
      plan: order.plan,
      appointmentWindow: { start: window.startSim, end: window.endSim },
      status: "SCHEDULED",
    };
  });
}
