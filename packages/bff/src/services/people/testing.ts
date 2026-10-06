// Test support for the deterministic handlers of services/{consent,people,evidence-override,
// case-console,demo-controls} (never imported by runtime code): a world in a memory connector with its
// operator, settings, paused clock at Tuesday 13/10 09:20, crew Norte 3 and its people, order 24817 with
// its checklist, and the callers each kind of principal would build. People, phones and emails are the
// synthetic ones of docs/seed-spec.md §2-§4, cloned into the guest or QA world when asked for.
import { type Caller, type ConsoleRole, clockIdOfIsp, ispKindOfIspId } from "@cuadrilla/shared";
import { testConnector } from "../../connector/testing";
import type { NewEntity } from "../../domain/common";
import type { Person } from "../../domain/people";
import type { Decision } from "../../domain/audit";
import { phoneHash } from "../../lib/crypto";
import { fixedClock } from "../../lib/clock";
import type { ConsoleQueueEvent, InstallerQueue } from "../case-console/queue";
import type { ServiceDeps } from "./direct-call";

/** Real instant of the tests: the demo is replayed weeks after its simulated day. */
export const REAL_NOW = "2026-11-02T18:00:00.000Z";
export const SIM_NOW = "2026-10-13T09:20:00-06:00";
export const PHONE_KEY = "phone-hash-test-key";

export const hashPhone = (phone: string): string => phoneHash(PHONE_KEY, phone);

export interface WorldSpec {
  readonly ispId: string;
  /** Id suffix of the cloned people and orders (`-g07`), empty in the demo world. */
  readonly tag: string;
  /** National block after +52 55 for staff phones (`0101`/`0102` demo; `0207` guest 07; `0900` QA). */
  readonly installerBlock: string;
  readonly supervisorBlock: string;
}

export const DEMO: WorldSpec = { ispId: "isp-demo", tag: "", installerBlock: "0101", supervisorBlock: "0102" };
export const GUEST_07: WorldSpec = { ispId: "isp-guest-07", tag: "-g07", installerBlock: "0207", supervisorBlock: "0207" };
export const SIGNUP: WorldSpec = { ispId: "isp-guest-s261101abcde", tag: "-gs261101abcde", installerBlock: "0300", supervisorBlock: "0300" };
export const SIGNUP_2: WorldSpec = { ispId: "isp-guest-s261102qwert", tag: "-gs261102qwert", installerBlock: "0300", supervisorBlock: "0300" };
export const QA: WorldSpec = { ispId: "isp-qa-812-1-sc-10", tag: "-qa", installerBlock: "0900", supervisorBlock: "0901" };

/** Ids of the world's people and order. */
export function idsOf(spec: WorldSpec) {
  return {
    rogelio: `inst-rogelio${spec.tag}`,
    julian: `inst-julian${spec.tag}`,
    adriana: `sup-adriana${spec.tag}`,
    hector: `sup-hector${spec.tag}`,
    marisol: `zc-marisol${spec.tag}`,
    order: `wo-24817${spec.tag}`,
    case: "case-01J9ZQX0000000000000000000",
  } as const;
}

export function phoneOf(block: string, n: number): string {
  return `+5255${block}${String(n).padStart(4, "0")}`;
}

function person(spec: WorldSpec, overrides: Partial<NewEntity<typeof Person>> & Pick<NewEntity<typeof Person>, "personId" | "role" | "firstName">): NewEntity<typeof Person> {
  const phone = overrides.phone;
  return {
    ispId: spec.ispId,
    clockId: clockIdOfIsp(spec.ispId),
    lastName: "Ficticio",
    crewId: "crew-n3",
    zoneId: "zone-norte",
    active: true,
    ...overrides,
    ...(phone === undefined ? {} : { phoneHash: hashPhone(phone) }),
  };
}

export interface ServiceWorld {
  readonly deps: ServiceDeps;
  readonly clockId: string;
  readonly ispId: string;
  readonly ids: ReturnType<typeof idsOf>;
  readonly spec: WorldSpec;
  readonly queued: ConsoleQueueEvent[];
  readonly queue: InstallerQueue;
  /** The console caller of this world (a guest world's role is always GUEST). */
  console(role?: ConsoleRole, userId?: string): Caller;
  /** The QaDriver's caller (only valid in its own worlds). */
  qa(userId?: string): Caller;
  channel(eventId?: string): Caller;
  decisions(): Promise<Decision[]>;
}

/**
 * A world with its clock paused at 09:20 of 13/10, crew Norte 3, Rogelio (opted in), Julián (no opt-in), Adriana and Héctor (opted in), Marisol. With `shared`,
 * the new world lives in the same tables as that one (two worlds side by side).
 */
export async function serviceWorld(spec: WorldSpec = DEMO, shared?: ServiceWorld): Promise<ServiceWorld> {
  const connector = shared?.deps.connector ?? testConnector(REAL_NOW).connector;
  const ispId = spec.ispId;
  const clockId = clockIdOfIsp(ispId);
  const ids = idsOf(spec);
  await connector.isps.putIsp({ ispId, kind: ispKindOfIspId(ispId), clockId });
  await connector.isps.putSettings({
    ispId,
    clockId,
    quietHours: { start: "21:00", end: "07:00" },
    caseTimeoutSec: 600,
    demoMode: true,
    demoCaseTimeoutSec: 60,
    whatsappMode: "simulated",
    turnCaps: { perHour: 200, perDay: 1000 },
    simulatorCaps: { turnsPerHour: 60, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 20 },
  });
  await connector.runtime.createClock({ clockId, ispId, kind: ispKindOfIspId(ispId), mode: "PAUSED", offsetMs: 0, pausedSimNow: SIM_NOW, worldEpoch: 1 });
  await connector.isps.putZone({ ispId, clockId, zoneId: "zone-norte", name: "Zona Norte", opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8 }, zoneChiefId: ids.marisol });
  await connector.isps.putZone({ ispId, clockId, zoneId: "zone-sur", name: "Zona Sur", opticalClass: "C+", acceptanceRange: { minDbm: -28, maxDbm: -8 }, zoneChiefId: "zc-ricardo" });
  await connector.isps.putCrew({ ispId, clockId, crewId: "crew-n3", zoneId: "zone-norte", name: "Equipo Norte 3" });
  await connector.isps.putCrew({ ispId, clockId, crewId: "crew-s1", zoneId: "zone-sur", name: "Equipo Sur 1" });
  const { people } = connector;
  await people.createPerson(person(spec, { personId: ids.rogelio, role: "INSTALLER", firstName: "Rogelio", phone: phoneOf(spec.installerBlock, 1) }));
  await people.createPerson(person(spec, { personId: ids.julian, role: "INSTALLER", firstName: "Julián", phone: phoneOf(spec.installerBlock, 3) }));
  await people.createPerson(person(spec, { personId: ids.adriana, role: "SUPERVISOR", firstName: "Adriana", phone: phoneOf(spec.supervisorBlock, 101) }));
  await people.createPerson(person(spec, { personId: ids.hector, role: "SUPERVISOR", firstName: "Héctor", phone: phoneOf(spec.supervisorBlock, 102) }));
  await people.createPerson(person(spec, { personId: ids.marisol, role: "ZONE_CHIEF", firstName: "Marisol", crewId: undefined, email: "success+zc-marisol@simulator.amazonses.com" }));
  for (const personId of [ids.rogelio, ids.adriana, ids.hector]) {
    await people.grantConsent({ personId, clockId, medium: "SEED", textVersion: "v001" }, { actor: "SEED", atSim: "2026-10-01T08:00:00-06:00" });
  }
  await connector.workOrders.createWorkOrder({
    workOrderId: ids.order,
    workOrderNumber: "24817",
    ispId,
    clockId,
    worldEpoch: 1,
    installerId: ids.rogelio,
    customerId: `cust-10421${spec.tag}`,
    crewId: "crew-n3",
    zoneId: "zone-norte",
    date: "2026-10-13",
    appointmentWindow: { startSim: "2026-10-13T09:00:00-06:00", endSim: "2026-10-13T11:00:00-06:00" },
    plan: "Fibra 300",
    onuSerial: "DEMO3F2C19A0",
    onuModel: "ONU-G1",
    oltPort: "OLT-N3/1/4",
    opticalClass: "B+",
    status: "IN_PROGRESS",
  });
  const queued: ConsoleQueueEvent[] = [];
  const guest = ispKindOfIspId(ispId) === "GUEST";
  return {
    deps: { connector, realClock: fixedClock(REAL_NOW) },
    clockId,
    ispId,
    ids,
    spec,
    queued,
    queue: { enqueue: async (event) => void queued.push(event) },
    console: (role = guest ? "GUEST" : "SUPERVISOR", userId = guest ? "usr-guest-07" : "usr-adriana") => ({ kind: "CONSOLE", ispId, clockId, userId, role }),
    qa: (userId = "usr-qa-sup") => ({ kind: "QA", ispId, clockId, userId }),
    channel: (eventId = "wa-in-0001") => ({ kind: "CHANNEL", ispId, clockId, eventId }),
    decisions: async () => connector.audit.listByMonth(ispId, "2026-10"),
  };
}
