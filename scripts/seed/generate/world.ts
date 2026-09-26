// The two worlds the generator writes rows for (docs/seed-spec.md §3): the operator's demo world and
// the `guest` template. Both tell the same story; the template carries the placeholder guest number
// `00` in every id, phone and email of its world (`inst-rogelio-g00`, `wo-24817-g00`, `+52 55 0200
// 0001`, `success+g00-c10421@…`), which the world factory replaces with the guest world's own tokens
// (`guestBlock` of lib/synthetic.ts). Nothing of a world names the operator (ADR-0018).
import { guestClockId } from "@cuadrilla/shared";
import { guestBlock, simulatorEmail, type SimulatorOutcome } from "../lib/synthetic";
import { DAY_ORDERS, DEMO_CLOCK, DEMO_ISP, HISTORY_ORDERS, NEXT_DAY_ORDERS, STAFF, type OrderDef, type StaffDef } from "./catalog";

export type WorldKind = "DEMO" | "GUEST";

export interface WorldSpec {
  readonly name: "demo" | "guest";
  readonly kind: WorldKind;
  readonly ispId: string;
  readonly clockId: string;
  readonly staff: readonly StaffDef[];
  /** Orders of the world, each with its received power already resolved for the history. */
  readonly orders: readonly OrderDef[];
  readonly consoleUsers: ReadonlyArray<{ readonly userId: string; readonly role: "SUPERVISOR" | "OPS" | "GUEST"; readonly name: string }>;
  readonly opsMailbox: string;
  readonly unknownNumber: string;
  personId(base: string): string;
  customerId(customer: number): string;
  workOrderId(number: string): string;
  staffPhone(person: StaffDef): string | undefined;
  customerPhone(customer: number): string;
  customerEmail(customer: number, outcome?: SimulatorOutcome): string;
  zoneChiefEmail(person: StaffDef): string;
}

/** The supervisor console user of a world: who validated by hand in the 12/10 history. */
export function supervisorUser(world: WorldSpec): { readonly userId: string; readonly name: string } {
  const user = world.consoleUsers.find((candidate) => candidate.role === "SUPERVISOR");
  if (user === undefined) throw new RangeError(`${world.name} has no supervisor console user`);
  return user;
}

/** Placeholder guest of the `guest` template. */
export const TEMPLATE_GUEST = 0;

function phone(block: string, slot: number): string {
  return `${block}${String(slot).padStart(4, "0")}`;
}

/** Slot of a person inside a world's block: installers 0001-0010, supervisors 0011-0020. */
function staffSlot(person: StaffDef): number | undefined {
  if (person.phoneSlot === undefined) return undefined;
  return person.role === "SUPERVISOR" ? 10 + person.phoneSlot : person.phoneSlot;
}

export function demoWorld(historyRx: ReadonlyMap<string, number>): WorldSpec {
  return {
    name: "demo",
    kind: "DEMO",
    ispId: DEMO_ISP,
    clockId: DEMO_CLOCK,
    staff: STAFF,
    orders: [...withHistoryRx(historyRx), ...DAY_ORDERS, ...NEXT_DAY_ORDERS],
    consoleUsers: [
      { userId: "usr-adriana", role: "SUPERVISOR", name: "Adriana Solís" },
      { userId: "usr-ops-lina", role: "OPS", name: "Lina Carranza" },
    ],
    opsMailbox: simulatorEmail("success", "ops-demo"),
    unknownNumber: "+525501990001",
    personId: (base) => base,
    customerId: (customer) => `cust-${customer}`,
    workOrderId: (number) => `wo-${number}`,
    staffPhone: (person) => (person.phoneSlot === undefined ? undefined : `+52550${person.role === "SUPERVISOR" ? "102" : "101"}00${String(person.phoneSlot).padStart(2, "0")}`),
    customerPhone: (customer) => `+52550103${String(customer - 10000).padStart(4, "0")}`,
    customerEmail: (customer, outcome = "success") => simulatorEmail(outcome, `c${customer}`),
    zoneChiefEmail: (person) => simulatorEmail("success", person.personId),
  };
}

/** Staff of the curated guest template (docs/seed-spec.md §3): crew Norte 3 complete, crew Sur 1 reduced. */
export const GUEST_STAFF = ["inst-rogelio", "inst-karina", "inst-julian", "inst-beatriz", "sup-adriana", "sup-hector", "sup-paola", "sup-daniel", "zc-marisol", "zc-ricardo"] as const;

/** Orders of the guest template: the day of crew Norte 3 and its 12/10 history, Beatriz's two, and 14/10. */
export const GUEST_ORDERS = ["24801", "24802", "24803", "24804", "24805", "24806", "24817", "24818", "24819", "24820", "24821", "24822", "24830", "24831", "24840", "24842", "24850", "24851", "24852", "24853"] as const;

export function guestWorld(historyRx: ReadonlyMap<string, number>): WorldSpec {
  const tokens = guestBlock(TEMPLATE_GUEST);
  const tag = tokens.clockTag;
  const clockId = guestClockId(TEMPLATE_GUEST);
  const all = [...withHistoryRx(historyRx), ...DAY_ORDERS, ...NEXT_DAY_ORDERS];
  return {
    name: "guest",
    kind: "GUEST",
    ispId: clockId.slice("GUEST#".length),
    clockId,
    staff: STAFF.filter((person) => (GUEST_STAFF as readonly string[]).includes(person.personId)),
    orders: all.filter((order) => (GUEST_ORDERS as readonly string[]).includes(order.number)),
    // The supervisor's user signs the manual validations of the 12/10 history; nobody logs in with it.
    consoleUsers: [
      { userId: `usr-guest-${tokens.number}`, role: "GUEST", name: "Invitado" },
      { userId: `usr-adriana-${tag}`, role: "SUPERVISOR", name: "Adriana Solís" },
    ],
    opsMailbox: simulatorEmail("success", `ops-${tag}`),
    unknownNumber: phone(tokens.phoneBlock, 999),
    personId: (base) => `${base}-${tag}`,
    customerId: (customer) => `cust-${customer}-${tag}`,
    workOrderId: (number) => `wo-${number}-${tag}`,
    staffPhone: (person) => {
      const slot = staffSlot(person);
      return slot === undefined ? undefined : phone(tokens.phoneBlock, slot);
    },
    customerPhone: (customer) => phone(tokens.phoneBlock, customer - 10000),
    customerEmail: (customer, outcome = "success") => simulatorEmail(outcome, `${tag}-c${customer}`),
    zoneChiefEmail: (person) => simulatorEmail("success", `${tag}-${person.personId}`),
  };
}

function withHistoryRx(historyRx: ReadonlyMap<string, number>): OrderDef[] {
  return HISTORY_ORDERS.map((order) => {
    const rxDbm = historyRx.get(order.number);
    if (rxDbm === undefined) throw new RangeError(`no historical reading for ${order.number}`);
    return { ...order, rxDbm };
  });
}
