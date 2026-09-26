// The demo operator as data (docs/seed-spec.md §4-§7): its zones and crews, the staff with their
// opt-in, the customers of the stories and every work order with the ONU behaviour of the network
// orchestrator. Everything else (rows, templates, models) is built from this one catalog, so the demo
// world, the judge template, the QA models and the evaluation worlds tell the same story.
import type { OpticalClass, PersonRole } from "@cuadrilla/shared";
import type { OnuBehaviour } from "@cuadrilla/network-contract";
import { DAYS } from "./time";
import type { Neighborhood, Plan } from "./names";

export const DEMO_ISP = "isp-demo";
export const DEMO_CLOCK = "GLOBAL#isp-demo";
export const ONU_MODEL = "ONU-G1 genérica";

export interface ZoneDef {
  readonly zoneId: "zone-norte" | "zone-sur";
  readonly name: string;
  readonly opticalClass: OpticalClass;
  readonly acceptanceRange: { readonly minDbm: number; readonly maxDbm: number };
  readonly zoneChiefId: string;
  readonly oltPrefix: string;
}

export const ZONES: readonly ZoneDef[] = [
  { zoneId: "zone-norte", name: "Zona Norte", opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8 }, zoneChiefId: "zc-marisol", oltPrefix: "OLT-N3" },
  { zoneId: "zone-sur", name: "Zona Sur", opticalClass: "C+", acceptanceRange: { minDbm: -28, maxDbm: -8 }, zoneChiefId: "zc-ricardo", oltPrefix: "OLT-S1" },
];

export interface CrewDef {
  readonly crewId: "crew-n3" | "crew-s1";
  readonly zoneId: ZoneDef["zoneId"];
  readonly name: string;
  readonly primaryId: string;
  readonly secondaryId: string;
  /** Shift of the roster, local time. */
  readonly shift: readonly [string, string];
}

export const CREWS: readonly CrewDef[] = [
  { crewId: "crew-n3", zoneId: "zone-norte", name: "Equipo Norte 3", primaryId: "sup-adriana", secondaryId: "sup-hector", shift: ["07:00", "19:00"] },
  { crewId: "crew-s1", zoneId: "zone-sur", name: "Equipo Sur 1", primaryId: "sup-paola", secondaryId: "sup-daniel", shift: ["07:00", "19:00"] },
];

export type StaffRole = Exclude<PersonRole, "CUSTOMER">;

export interface OptInDef {
  readonly grantedOn: string;
  readonly revokedOn?: string;
}

export interface StaffDef {
  readonly personId: string;
  readonly role: StaffRole;
  readonly firstName: string;
  readonly lastName: string;
  readonly crewId?: CrewDef["crewId"];
  readonly zoneId: ZoneDef["zoneId"];
  /** Position in the role's phone block (`+52 55 0101 00xx`, `+52 55 0102 00xx`); zone chiefs have none. */
  readonly phoneSlot?: number;
  /** `null`: never sent ALTA. */
  readonly optIn: OptInDef | null;
  readonly story: string;
}

export const STAFF: readonly StaffDef[] = [
  { personId: "inst-rogelio", role: "INSTALLER", firstName: "Rogelio", lastName: "Méndez", crewId: "crew-n3", zoneId: "zone-norte", phoneSlot: 1, optIn: { grantedOn: "2026-10-01" }, story: "Main story" },
  { personId: "inst-karina", role: "INSTALLER", firstName: "Karina", lastName: "Olvera", crewId: "crew-n3", zoneId: "zone-norte", phoneSlot: 2, optIn: { grantedOn: "2026-10-01" }, story: "Rejected photos, other serial, failed visit" },
  { personId: "inst-julian", role: "INSTALLER", firstName: "Julián", lastName: "Torres", crewId: "crew-n3", zoneId: "zone-norte", phoneSlot: 3, optIn: null, story: "New installer without opt-in (FL-003, FL-011)" },
  { personId: "inst-beatriz", role: "INSTALLER", firstName: "Beatriz", lastName: "Salazar", crewId: "crew-s1", zoneId: "zone-sur", phoneSlot: 4, optIn: { grantedOn: "2026-10-02" }, story: "ONU not provisioned, bounced certificate" },
  { personId: "inst-tomas", role: "INSTALLER", firstName: "Tomás", lastName: "Aguilar", crewId: "crew-s1", zoneId: "zone-sur", phoneSlot: 5, optIn: { grantedOn: "2026-10-02" }, story: "ONU without power, certificate complaint" },
  { personId: "inst-ernesto", role: "INSTALLER", firstName: "Ernesto", lastName: "Villalobos", crewId: "crew-s1", zoneId: "zone-sur", phoneSlot: 6, optIn: { grantedOn: "2026-10-02", revokedOn: "2026-10-09" }, story: "Opted out on 09/10 (FL-005, FL-011)" },
  { personId: "inst-lorena", role: "INSTALLER", firstName: "Lorena", lastName: "Ávila", crewId: "crew-s1", zoneId: "zone-sur", phoneSlot: 7, optIn: { grantedOn: "2026-10-05" }, story: "No work orders on 13/10 (FL-009)" },
  { personId: "sup-adriana", role: "SUPERVISOR", firstName: "Adriana", lastName: "Solís", crewId: "crew-n3", zoneId: "zone-norte", phoneSlot: 1, optIn: { grantedOn: "2026-10-01" }, story: "Supervisor on duty: ladder, safety alert" },
  { personId: "sup-hector", role: "SUPERVISOR", firstName: "Héctor", lastName: "Ibarra", crewId: "crew-n3", zoneId: "zone-norte", phoneSlot: 2, optIn: { grantedOn: "2026-10-01" }, story: "Backup supervisor: takes the reassigned case" },
  { personId: "sup-paola", role: "SUPERVISOR", firstName: "Paola", lastName: "Reyes", crewId: "crew-s1", zoneId: "zone-sur", phoneSlot: 3, optIn: { grantedOn: "2026-10-02" }, story: "Supervisor on duty of the south zone" },
  { personId: "sup-daniel", role: "SUPERVISOR", firstName: "Daniel", lastName: "Fuentes", crewId: "crew-s1", zoneId: "zone-sur", phoneSlot: 4, optIn: { grantedOn: "2026-10-02" }, story: "Backup supervisor: plan B without TURNO" },
  { personId: "zc-marisol", role: "ZONE_CHIEF", firstName: "Marisol", lastName: "Cárdenas", zoneId: "zone-norte", optIn: null, story: "Zone chief of the north zone (email)" },
  { personId: "zc-ricardo", role: "ZONE_CHIEF", firstName: "Ricardo", lastName: "Luna", zoneId: "zone-sur", optIn: null, story: "Zone chief of the south zone (email)" },
];

export interface FixedCustomer {
  readonly firstName: string;
  readonly lastName: string;
  readonly street?: string;
  readonly neighborhood?: Neighborhood;
  readonly emailOutcome?: "bounce" | "complaint";
  readonly curpNote?: boolean;
}

/** Customers the stories name (docs/seed-spec.md §6-§7); the rest are combined by the generator. */
export const FIXED_CUSTOMERS: Readonly<Record<number, FixedCustomer>> = {
  10421: { firstName: "Lucía", lastName: "Treviño", street: "Calle Jacaranda 214", neighborhood: "Las Lomitas" },
  10422: { firstName: "Armando", lastName: "Guzmán", street: "Av. Los Fresnos 88", neighborhood: "Arboledas" },
  10423: { firstName: "Rosa Elena", lastName: "Pineda", street: "Privada Olmo 12", neighborhood: "El Mirador" },
  10425: { firstName: "Noemí", lastName: "Sepúlveda", curpNote: true },
  10431: { firstName: "Genaro", lastName: "Vega", emailOutcome: "bounce" },
  10432: { firstName: "Consuelo", lastName: "Arriaga", emailOutcome: "complaint" },
};

export const CUSTOMER_NUMBERS = { first: 10401, last: 10442 } as const;

export interface OrderDef {
  readonly number: string;
  readonly date: string;
  readonly installerId: string;
  readonly customer: number;
  readonly plan: Plan;
  readonly window: readonly [string, string];
  readonly serial: string;
  readonly oltPort: string;
  readonly behaviour: Exclude<OnuBehaviour, "UNKNOWN">;
  /** Received power of the final state; absent where the behaviour has none (not provisioned). */
  readonly rxDbm?: number;
  readonly story: string;
}

const W1 = ["09:00", "11:00"] as const;
const W2 = ["11:30", "13:30"] as const;
const W3 = ["15:00", "17:00"] as const;

/** The orders of 13/10 (docs/seed-spec.md §7). */
export const DAY_ORDERS: readonly OrderDef[] = [
  { number: "24817", date: DAYS.demo, installerId: "inst-rogelio", customer: 10421, plan: "Fibra 300", window: W1, serial: "DEMO3F2C19A0", oltPort: "OLT-N3/1/4", behaviour: "LOS_THEN_ONLINE", rxDbm: -21.4, story: "Main story: voice, diagnosis, policy, photos, certificate" },
  { number: "24818", date: DAYS.demo, installerId: "inst-rogelio", customer: 10422, plan: "Fibra 100", window: W2, serial: "DEMO3F2C1A11", oltPort: "OLT-N3/1/6", behaviour: "LOW_POWER_THEN_OK", rxDbm: -22.1, story: "Ladder and bridge" },
  { number: "24819", date: DAYS.demo, installerId: "inst-rogelio", customer: 10423, plan: "Fibra 500", window: W3, serial: "DEMO3F2C1B27", oltPort: "OLT-N3/2/1", behaviour: "ONLINE_OK", rxDbm: -20.6, story: "Safety" },
  { number: "24820", date: DAYS.demo, installerId: "inst-karina", customer: 10424, plan: "Fibra 300", window: W1, serial: "DEMO3F2C2C04", oltPort: "OLT-N3/2/3", behaviour: "ONLINE_OK", rxDbm: -20.2, story: "Three rejected labels → PHOTO_ATTEMPTS" },
  { number: "24821", date: DAYS.demo, installerId: "inst-karina", customer: 10425, plan: "Fibra 100", window: W2, serial: "DEMO3F2C2D15", oltPort: "OLT-N3/2/5", behaviour: "ONLINE_OK", rxDbm: -22.8, story: "Label with another serial (DEMO3F2C9999)" },
  { number: "24822", date: DAYS.demo, installerId: "inst-karina", customer: 10426, plan: "Fibra 300", window: W3, serial: "DEMO3F2C2E26", oltPort: "OLT-N3/3/2", behaviour: "ONLINE_OK", rxDbm: -21.9, story: "Customer absent → failed visit" },
  { number: "24830", date: DAYS.demo, installerId: "inst-beatriz", customer: 10430, plan: "Fibra 300", window: ["10:00", "12:00"], serial: "DEMO3F2C3A01", oltPort: "OLT-S1/1/2", behaviour: "NOT_PROVISIONED", story: "NOT_PROVISIONED case" },
  { number: "24831", date: DAYS.demo, installerId: "inst-beatriz", customer: 10431, plan: "Fibra 100", window: ["13:00", "15:00"], serial: "DEMO3F2C3B12", oltPort: "OLT-S1/1/5", behaviour: "ONLINE_OK", rxDbm: -23.9, story: "Bounced certificate" },
  { number: "24832", date: DAYS.demo, installerId: "inst-tomas", customer: 10432, plan: "Fibra 500", window: ["10:00", "12:00"], serial: "DEMO3F2C3C23", oltPort: "OLT-S1/2/2", behaviour: "DYING_GASP", rxDbm: -22.1, story: "§DIAG-01; certificate complaint" },
  { number: "24833", date: DAYS.demo, installerId: "inst-tomas", customer: 10433, plan: "Fibra 100", window: ["13:00", "15:00"], serial: "DEMO3F2C3D34", oltPort: "OLT-S1/2/4", behaviour: "ONLINE_OK", rxDbm: -26.1, story: "In range in C+, out of range in B+ (class test)" },
  { number: "24840", date: DAYS.demo, installerId: "inst-julian", customer: 10440, plan: "Fibra 100", window: W1, serial: "DEMO3F2C4A05", oltPort: "OLT-N3/3/6", behaviour: "ONLINE_OK", rxDbm: -21.2, story: "No opt-in: day start denied" },
  { number: "24841", date: DAYS.demo, installerId: "inst-ernesto", customer: 10441, plan: "Fibra 300", window: W1, serial: "DEMO3F2C4B16", oltPort: "OLT-S1/3/1", behaviour: "ONLINE_OK", rxDbm: -23.3, story: "Opted out: day start denied" },
  { number: "24842", date: DAYS.demo, installerId: "inst-karina", customer: 10442, plan: "Fibra 100", window: ["17:00", "19:00"], serial: "DEMO3F2C4C27", oltPort: "OLT-N3/4/1", behaviour: "ONLINE_OK", rxDbm: -19.7, story: "ORDER_CHOICE list (Karina's four orders)" },
];

/** The orders of 14/10: destination of reschedules and "tomorrow's orders". */
export const NEXT_DAY_ORDERS: readonly OrderDef[] = [
  { number: "24850", date: DAYS.next, installerId: "inst-rogelio", customer: 10413, plan: "Fibra 300", window: W1, serial: "DEMO3F2C5A01", oltPort: "OLT-N3/4/3", behaviour: "ONLINE_OK", rxDbm: -20.8, story: "Tomorrow's order" },
  { number: "24851", date: DAYS.next, installerId: "inst-rogelio", customer: 10414, plan: "Fibra 100", window: W2, serial: "DEMO3F2C5B12", oltPort: "OLT-N3/4/5", behaviour: "ONLINE_OK", rxDbm: -22.4, story: "Tomorrow's order" },
  { number: "24852", date: DAYS.next, installerId: "inst-karina", customer: 10415, plan: "Fibra 500", window: W1, serial: "DEMO3F2C5C23", oltPort: "OLT-N3/5/2", behaviour: "ONLINE_OK", rxDbm: -19.9, story: "Tomorrow's order" },
  { number: "24853", date: DAYS.next, installerId: "inst-karina", customer: 10416, plan: "Fibra 300", window: W2, serial: "DEMO3F2C5D34", oltPort: "OLT-N3/5/4", behaviour: "ONLINE_OK", rxDbm: -21.6, story: "Tomorrow's order" },
];

const HISTORY_INSTALLERS = ["inst-rogelio", "inst-karina", "inst-beatriz", "inst-tomas"] as const;
const HISTORY_PLANS: readonly Plan[] = ["Fibra 300", "Fibra 100", "Fibra 500"];

/**
 * The orders closed on 12/10, three per installer (docs/seed-spec.md §7). Serials and classes are the
 * ones the historical renders of WP-18 print (`DEMO3E1B08<nn>`, B+ in the north, C+ in the south);
 * the received power comes from their datasheet when the rows are built.
 */
export const HISTORY_ORDERS: readonly Omit<OrderDef, "rxDbm">[] = HISTORY_INSTALLERS.flatMap((installerId, installerIndex) =>
  [W1, W2, W3].map((window, slot) => {
    const index = installerIndex * 3 + slot + 1;
    const nn = String(index).padStart(2, "0");
    const north = installerIndex < 2;
    return {
      number: `248${nn}`,
      date: DAYS.history,
      installerId,
      customer: 10400 + index,
      plan: HISTORY_PLANS[slot] ?? "Fibra 300",
      window,
      serial: `DEMO3E1B08${nn}`,
      oltPort: `${north ? "OLT-N3" : "OLT-S1"}/${6 + slot}/${installerIndex + 1}`,
      behaviour: "ONLINE_OK" as const,
      story: "Closed on 12/10 with certificate, evidence and validations (metrics and profile)",
    };
  }),
);

export function staff(personId: string): StaffDef {
  const found = STAFF.find((person) => person.personId === personId);
  if (found === undefined) throw new RangeError(`unknown staff ${personId}`);
  return found;
}

export function zoneOf(zoneId: string): ZoneDef {
  const found = ZONES.find((zone) => zone.zoneId === zoneId);
  if (found === undefined) throw new RangeError(`unknown zone ${zoneId}`);
  return found;
}

/** Zone of an order: the zone of its installer's crew. */
export function zoneOfOrder(order: Pick<OrderDef, "installerId">): ZoneDef {
  return zoneOf(staff(order.installerId).zoneId);
}
