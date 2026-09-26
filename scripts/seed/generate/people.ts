// `People` of a world (docs/seed-spec.md §5-§6): the staff on the allow list with their opt-in and its
// dated history, the installer profiles measured from the 12/10 history, and the synthetic customers
// (common names combined from the generator's lists, streets named after trees and flowers, invented
// neighborhoods, a phone of the synthetic block and an address of the SES mailbox simulator). Phones
// are stored in clear; the loader computes `phoneHash` with the stage's key.
import { OPT_IN_TEXT_VERSION } from "../../../packages/bff/src/copy/es-MX";
import type { SeedItem } from "../lib/tables";
import { CUSTOMER_FIRST_NAMES, CUSTOMER_LAST_NAMES, NORTH_NEIGHBORHOODS, SOUTH_NEIGHBORHOODS, STREET_KINDS, STREET_NAMES, type Neighborhood } from "./names";
import { CUSTOMER_NUMBERS, FIXED_CUSTOMERS, zoneOfOrder, type OptInDef, type StaffDef } from "./catalog";
import { rngFor, row } from "./context";
import { curpNote } from "./curp";
import { sim } from "./time";
import type { WorldSpec } from "./world";

/** When a person sent "ALTA" and "BAJA": 18:00 of the day, local time. */
export function optInInstants(optIn: OptInDef): { granted: string; revoked?: string } {
  return { granted: sim(optIn.grantedOn, "18:00"), ...(optIn.revokedOn === undefined ? {} : { revoked: sim(optIn.revokedOn, "19:10") }) };
}

export interface ProfileEvent {
  readonly installerId: string;
  readonly code: string;
  readonly atSim: string;
  readonly workOrderId: string;
}

export function personItems(world: WorldSpec, lastInboundAtSim: ReadonlyMap<string, string>): SeedItem[] {
  return world.staff.map((person) => {
    const personId = world.personId(person.personId);
    const phone = world.staffPhone(person);
    const lastInbound = lastInboundAtSim.get(personId);
    return row("Person", {
      personId,
      ispId: world.ispId,
      clockId: world.clockId,
      role: person.role,
      firstName: person.firstName,
      lastName: person.lastName,
      ...(person.crewId === undefined ? {} : { crewId: person.crewId }),
      zoneId: person.zoneId,
      ...(phone === undefined ? {} : { phone }),
      ...(person.role === "ZONE_CHIEF" ? { email: world.zoneChiefEmail(person) } : {}),
      active: true,
      ...(lastInbound === undefined ? {} : { lastInboundAtSim: lastInbound }),
    });
  });
}

export function consentItems(world: WorldSpec): SeedItem[] {
  return world.staff.flatMap((person: StaffDef) => {
    if (person.optIn === null) return [];
    const personId = world.personId(person.personId);
    const { granted, revoked } = optInInstants(person.optIn);
    const actor = `PERSON:${personId}`;
    const history = [
      { field: "consent", to: "GRANTED", atSim: granted, atReal: granted, actor, reason: "ALTA" },
      ...(revoked === undefined ? [] : [{ field: "consent", from: "GRANTED", to: "REVOKED", atSim: revoked, atReal: revoked, actor, reason: "BAJA" }]),
    ];
    return [
      row("Consent", {
        personId,
        clockId: world.clockId,
        kind: "WHATSAPP_OPT_IN",
        status: revoked === undefined ? "GRANTED" : "REVOKED",
        medium: "WHATSAPP_KEYWORD",
        textVersion: OPT_IN_TEXT_VERSION,
        grantedAtSim: granted,
        ...(revoked === undefined ? {} : { revokedAtSim: revoked }),
        history,
      }),
    ];
  });
}

/** Measured profile of every installer: the rejections of 12/10 counted by reason (docs/seed-spec.md §5). */
export function profileItems(world: WorldSpec, events: readonly ProfileEvent[]): SeedItem[] {
  return world.staff
    .filter((person) => person.role === "INSTALLER")
    .map((person) => {
      const installerId = world.personId(person.personId);
      const own = events.filter((event) => event.installerId === installerId).sort((a, b) => Date.parse(a.atSim) - Date.parse(b.atSim));
      const rejects: Record<string, number> = {};
      for (const event of own) rejects[event.code] = (rejects[event.code] ?? 0) + 1;
      return row("InstallerProfile", {
        installerId,
        clockId: world.clockId,
        rejects,
        stepsBySymptom: {},
        casesByReason: {},
        events: own.map((event) => ({ kind: "REJECT", code: event.code, atSim: event.atSim, workOrderId: event.workOrderId })),
      });
    });
}

export interface CustomerDef {
  readonly customer: number;
  readonly firstName: string;
  readonly lastName: string;
  readonly addressLine: string;
  readonly neighborhood: Neighborhood;
  readonly emailOutcome: "success" | "bounce" | "complaint";
  readonly note?: string;
}

/** The 42 customers of the demo operator, fixed ones as the stories name them, the rest combined. */
export function customerCatalog(orders: WorldSpec["orders"]): CustomerDef[] {
  const zoneByCustomer = new Map(orders.map((order) => [order.customer, zoneOfOrder(order).zoneId]));
  const customers: CustomerDef[] = [];
  for (let customer = CUSTOMER_NUMBERS.first; customer <= CUSTOMER_NUMBERS.last; customer += 1) {
    const index = customer - CUSTOMER_NUMBERS.first;
    const rng = rngFor("customer", customer);
    const fixed = FIXED_CUSTOMERS[customer];
    const zone = zoneByCustomer.get(customer) ?? (index % 2 === 0 ? "zone-norte" : "zone-sur");
    const neighborhoods = zone === "zone-norte" ? NORTH_NEIGHBORHOODS : SOUTH_NEIGHBORHOODS;
    const street = `${rng.pick(STREET_KINDS)} ${rng.pick(STREET_NAMES)} ${rng.int(3, 480)}`;
    customers.push({
      customer,
      firstName: fixed?.firstName ?? CUSTOMER_FIRST_NAMES[(index * 7) % CUSTOMER_FIRST_NAMES.length] ?? "Alma",
      lastName: fixed?.lastName ?? CUSTOMER_LAST_NAMES[(index * 5 + 3) % CUSTOMER_LAST_NAMES.length] ?? "Vega",
      addressLine: fixed?.street ?? street,
      neighborhood: fixed?.neighborhood ?? rng.pick(neighborhoods),
      emailOutcome: fixed?.emailOutcome ?? "success",
      ...(fixed?.curpNote === true ? { note: curpNote() } : {}),
    });
  }
  return customers;
}

export function customerItems(world: WorldSpec, customers: readonly CustomerDef[]): SeedItem[] {
  return customers.map((customer) =>
    row("Customer", {
      customerId: world.customerId(customer.customer),
      ispId: world.ispId,
      clockId: world.clockId,
      firstName: customer.firstName,
      lastName: customer.lastName,
      addressLine: customer.addressLine,
      neighborhood: customer.neighborhood,
      phone: world.customerPhone(customer.customer),
      email: world.customerEmail(customer.customer, customer.emailOutcome),
      ...(customer.note === undefined ? {} : { note: customer.note }),
    }),
  );
}
