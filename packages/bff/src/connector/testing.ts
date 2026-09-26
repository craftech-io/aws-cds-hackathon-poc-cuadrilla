// Test support for the connector's own tests and for any module that wants a seeded in-memory
// connector (never imported by runtime code). Fixtures are the synthetic ones of docs/seed-spec.md:
// operator `isp-demo`, world `GLOBAL#isp-demo`, installer Rogelio, order 24817.
import type { NewEntity } from "../domain/common";
import type { Case } from "../domain/cases";
import type { Person } from "../domain/people";
import type { WorkOrder } from "../domain/work-orders";
import { createMemoryConnector, type MemoryConnector } from "./memory/index";

export const T0 = "2026-10-13T13:00:00.000Z";
export const ISP = "isp-demo";
export const CLOCK = "GLOBAL#isp-demo";
export const QA_CLOCK = "qa-812-1-sc-02";
export const QA_ISP = "isp-qa-812-1-sc-02";
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const HASH_C = "c".repeat(64);
export const SHA_1 = "1".repeat(64);
export const CASE_1 = "case-01J9ZQX0000000000000000000";
export const CASE_2 = "case-01J9ZQX0000000000000000001";
export const EV_1 = "ev-01J9ZQX0000000000000000000";
export const EV_2 = "ev-01J9ZQX0000000000000000001";
export const VAL_1 = "val-01J9ZQX0000000000000000000";

/** A memory connector whose real clock the test moves with `advance(ms)`. */
export function testConnector(start: string = T0): MemoryConnector & { advance(ms: number): void; now(): Date } {
  let nowMs = Date.parse(start);
  const now = () => new Date(nowMs);
  return {
    ...createMemoryConnector({ now }),
    advance: (ms: number) => {
      nowMs += ms;
    },
    now,
  };
}

export function installer(overrides: Partial<NewEntity<typeof Person>> = {}): NewEntity<typeof Person> {
  return {
    personId: "inst-rogelio",
    ispId: ISP,
    clockId: CLOCK,
    role: "INSTALLER",
    firstName: "Rogelio",
    lastName: "Méndez",
    crewId: "crew-n3",
    zoneId: "zone-norte",
    phone: "+525501010001",
    phoneHash: HASH_A,
    active: true,
    ...overrides,
  };
}

export function supervisor(personId: string, phoneHash: string, overrides: Partial<NewEntity<typeof Person>> = {}): NewEntity<typeof Person> {
  return installer({ personId, role: "SUPERVISOR", firstName: personId.slice(4), lastName: "Supervisor", phone: "+525501020001", phoneHash, ...overrides });
}

export function workOrder(overrides: Partial<NewEntity<typeof WorkOrder>> = {}): NewEntity<typeof WorkOrder> {
  return {
    workOrderId: "wo-24817",
    workOrderNumber: "24817",
    ispId: ISP,
    clockId: CLOCK,
    worldEpoch: 1,
    installerId: "inst-rogelio",
    customerId: "cust-10421",
    crewId: "crew-n3",
    zoneId: "zone-norte",
    date: "2026-10-13",
    appointmentWindow: { startSim: "2026-10-13T09:00:00-06:00", endSim: "2026-10-13T11:00:00-06:00" },
    plan: "Fibra 300",
    onuSerial: "DEMO3F2C19A0",
    onuModel: "ONU-G1",
    oltPort: "OLT-N3/1/4",
    opticalClass: "B+",
    status: "SCHEDULED",
    ...overrides,
  };
}

export function openCase(overrides: Partial<NewEntity<typeof Case>> = {}): NewEntity<typeof Case> {
  return {
    caseId: CASE_1,
    ispId: ISP,
    clockId: CLOCK,
    workOrderId: "wo-24818",
    installerId: "inst-rogelio",
    kind: "ESCALATION",
    reason: "DIAGNOSIS_ATTEMPTS",
    status: "OPEN",
    rung: "PRIMARY",
    rungVersion: 0,
    roster: { primaryId: "sup-adriana", secondaryId: "sup-hector", zoneChiefId: "zc-marisol" },
    summary: "Potencia fuera de rango después de 3 pasos.",
    createdAtSim: "2026-10-13T11:50:00-06:00",
    ...overrides,
  };
}
