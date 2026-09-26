// Timers a world starts with (docs/seed-spec.md §3): one `DAY_START` at 07:30 of 13/10 for every
// active installer of the allow list, with or without orders and with or without opt-in (the firing
// decides the template, the denial or `SKIPPED NO_WORK_ORDERS`, and plans the next day). It lives in
// the first order of the installer's day or, without orders, in the person's partition. No order has
// any other timer: the first event of "Avanzar al próximo evento" is the start of the day.
import type { SeedItem } from "../lib/tables";
import { row } from "./context";
import { DAYS, DAY_START_TIME, sim } from "./time";
import type { WorldSpec } from "./world";

export function dayStartTimerId(installerId: string, date: string): string {
  return `day-start-${date}-${installerId}`;
}

export function dayStartTimers(world: WorldSpec): SeedItem[] {
  const date = DAYS.demo;
  const dueAtSim = sim(date, DAY_START_TIME);
  return world.staff
    .filter((person) => person.role === "INSTALLER")
    .map((person) => {
      const installerId = world.personId(person.personId);
      const first = world.orders
        .filter((order) => order.installerId === person.personId && order.date === date)
        .sort((a, b) => (a.window[0] < b.window[0] ? -1 : a.window[0] > b.window[0] ? 1 : 0))[0];
      const home = first === undefined ? { kind: "PERSON", id: installerId } : { kind: "WORK_ORDER", id: world.workOrderId(first.number) };
      return row("Timer", {
        timerId: dayStartTimerId(installerId, date),
        kind: "DAY_START",
        home,
        clockId: world.clockId,
        dueAtSim,
        status: "SCHEDULED",
        reason: "Inicio del día",
        payload: { installerId, date },
      });
    });
}
