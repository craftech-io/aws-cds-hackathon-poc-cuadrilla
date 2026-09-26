// `Isps` of a world (docs/seed-spec.md §4): the operator without a visible name (the loader writes
// `displayName` from `resolveBrand`, ADR-0018), its settings and caps, the two zones with their
// optical class, the crews, the shift roster of every day with orders and the console users (seeded
// with an empty `cognitoSub`, which `console:invite` fills).
import { TemplateName } from "@cuadrilla/shared";
import type { SeedItem } from "../lib/tables";
import { CITY } from "./names";
import { CREWS, ZONES } from "./catalog";
import { row } from "./context";
import { sim } from "./time";
import type { WorldSpec } from "./world";

/** Caps of the phone simulator per world (docs/seed-spec.md §4, ADR-0019). */
export const SIMULATOR_CAPS = {
  turnsPerHour: 60,
  turnsPerDay: 300,
  validationsPerDay: 100,
  transcribeSecPerDay: 30 * 60,
  emailsPerDay: 20,
  messagesPerRealHourPerIdentity: 20,
} as const;

/** Settings every world of the seed starts with (`IspSettings` without its operator and clock). */
export function worldSettings(): Record<string, unknown> {
  return {
    timezone: "America/Mexico_City",
    quietHours: { start: "21:00", end: "07:00" },
    caseTimeoutSec: 600,
    demoMode: true,
    demoCaseTimeoutSec: 60,
    whatsappMode: "simulated",
    turnCaps: { perHour: 200, perDay: 1000 },
    simulatorCaps: { ...SIMULATOR_CAPS },
    templateStatus: Object.fromEntries(TemplateName.options.map((name) => [name, "APPROVED"])),
  };
}

export function ispItems(world: WorldSpec): SeedItem[] {
  const items: SeedItem[] = [
    row("Isp", { ispId: world.ispId, kind: world.kind, clockId: world.clockId, cityName: CITY, opsMailbox: world.opsMailbox }),
    row("IspSettings", { ispId: world.ispId, clockId: world.clockId, ...worldSettings() }),
  ];
  for (const zone of ZONES) {
    items.push(
      row("Zone", {
        ispId: world.ispId,
        clockId: world.clockId,
        zoneId: zone.zoneId,
        name: zone.name,
        opticalClass: zone.opticalClass,
        acceptanceRange: { ...zone.acceptanceRange },
        zoneChiefId: world.personId(zone.zoneChiefId),
      }),
    );
  }
  const staffIds = new Set(world.staff.map((person) => person.personId));
  for (const crew of CREWS) {
    const members = world.staff.filter((person) => person.crewId === crew.crewId);
    if (members.length === 0) continue;
    items.push(row("Crew", { ispId: world.ispId, clockId: world.clockId, crewId: crew.crewId, zoneId: crew.zoneId, name: crew.name }));
    if (!staffIds.has(crew.primaryId) || !staffIds.has(crew.secondaryId)) throw new RangeError(`${world.name}: ${crew.crewId} needs both supervisors of its roster`);
    for (const date of rosterDates(world)) {
      items.push(
        row("ShiftRoster", {
          ispId: world.ispId,
          clockId: world.clockId,
          crewId: crew.crewId,
          date,
          primaryId: world.personId(crew.primaryId),
          secondaryId: world.personId(crew.secondaryId),
          startsAtSim: sim(date, crew.shift[0]),
          endsAtSim: sim(date, crew.shift[1]),
        }),
      );
    }
  }
  for (const user of world.consoleUsers) items.push(row("ConsoleUser", { ispId: world.ispId, userId: user.userId, role: user.role, name: user.name, cognitoSub: "", active: true }));
  return items;
}

/** Every day with orders in the world: each crew has its roster on each of them (invariant 5). */
export function rosterDates(world: Pick<WorldSpec, "orders">): string[] {
  return [...new Set(world.orders.map((order) => order.date))].sort();
}
