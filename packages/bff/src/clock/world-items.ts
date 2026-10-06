// Every item a world wrote, found from its operator without scanning a table (docs/architecture.md §5
// and §8, "Reiniciar demo"): its people (each partition with consent, profile, shift window and
// `DAY_START` timers, their threads, their `ADDR#` claims if they still hold them, the installers'
// `INSTSTATE#`), its customers, its orders of the simulated span (each partition with checklist,
// evidence, validations, steps, certificate and timers, plus the order's `Dispatch` row and its ONU's
// `Network` row), its cases (with their timers), its outbox, its decisions of the span's months, its
// metrics, the rosters of its operator, `WORLDSTATE#`, `PENDING#`, `FAULTS#` and the business rate
// counters in simulated hours (`RATE#<clockId>#<hash>#<simHour>`) of its people.
//
// What a reset keeps is never listed: the operator's `META`, `SETTINGS`, zones, crews and console
// users (the template rewrites them, users keep their Cognito `sub`), `CLOCK#`, `COUNTER#EPOCH#`,
// tombstones, the kill switches, the live-world mark and every real-time counter (`RATE#…#REAL#…`,
// `SIMCAP#`, `TURNCAP#`, `JUMP#`), so a reset or a scene jump never empties a world's caps. Short-lived
// rows keyed by random ids (sessions, turns, nonces, uploads, join codes) expire by TTL and name an
// epoch that no longer resolves. Phone leases are deleted through their port first, so the world's
// `WORLDSTATE#` still lists them.
import { CaseStatus, addCalendarDays } from "@cuadrilla/shared";
import { COUNTER_KEYS, addressClaimKey, auditPartition, counterRowKey, faultsKey, hourKey, installerStateKey, ispPartition, metricsPartition, outboxPartition, pendingPartition, personPartition, worldStateKey } from "../connector/keys";
import type { Connector } from "../connector/ports";
import type { Item, Key, Table, TableClient } from "../connector/table-client";
import { StaffRole } from "../domain/people";

export interface WorldItemsDeps {
  readonly client: TableClient;
  readonly data: Pick<Connector, "people" | "workOrders" | "cases" | "worlds">;
}

export interface WorldSpan {
  readonly clockId: string;
  readonly ispId: string;
  /** Simulated start of the world (its template's `startAtSim`); seeded history goes back `HISTORY_DAYS`. */
  readonly startSim: string;
  /** The world's simulated now. */
  readonly toSim: string;
}

export type DeletedCounts = Readonly<Partial<Record<Table, number>>>;

/** At most this many simulated days of orders and hours of rate counters are looked for. */
const MAX_DAYS = 120;
/** Seeded history (closed orders, their decisions) goes back this many days before a world starts. */
export const HISTORY_DAYS = 31;
const MAX_RATE_HOURS = 14 * 24;
const HOUR_MS = 3_600_000;

const keyOf = (item: Item): Key => ({ PK: item.PK, SK: item.SK });

class Collector {
  private readonly keys = new Map<Table, Map<string, Key>>();

  add(table: Table, keys: readonly Key[]): void {
    const bucket = this.keys.get(table) ?? new Map<string, Key>();
    for (const key of keys) bucket.set(`${key.PK}\u0000${key.SK}`, key);
    this.keys.set(table, bucket);
  }

  entries(): Array<[Table, Key[]]> {
    return [...this.keys.entries()].map(([table, keys]) => [table, [...keys.values()]]);
  }
}

/**
 * Calendar days (UTC) from one day before `fromSim` to one day after `toSim`; a longer span keeps its
 * first and its last `MAX_DAYS / 2` days (the seeded history and what the world did lately).
 */
export function daysOfSpan(fromSim: string, toSim: string): string[] {
  const first = new Date(Date.parse(fromSim) - 86_400_000).toISOString().slice(0, 10);
  const last = new Date(Date.parse(toSim) + 86_400_000).toISOString().slice(0, 10);
  const days: string[] = [];
  for (let day = first; day <= last; day = addCalendarDays(day, 1)) days.push(day);
  return days.length <= MAX_DAYS ? days : [...days.slice(0, MAX_DAYS / 2), ...days.slice(-MAX_DAYS / 2)];
}

/** `yyyy-mm` of every month of the span, both ends included. */
export function monthsOfSpan(fromSim: string, toSim: string): string[] {
  return [...new Set(daysOfSpan(fromSim, toSim).map((day) => day.slice(0, 7)))];
}

/** `hourKey` of every simulated hour of the span (the last `MAX_RATE_HOURS` of it). */
export function hoursOfSpan(fromSim: string, toSim: string): string[] {
  const end = Math.floor(Date.parse(toSim) / HOUR_MS) * HOUR_MS;
  const start = Math.max(Math.floor(Date.parse(fromSim) / HOUR_MS) * HOUR_MS, end - (MAX_RATE_HOURS - 1) * HOUR_MS);
  const hours: string[] = [];
  for (let at = start; at <= end; at += HOUR_MS) hours.push(hourKey(new Date(at)));
  return hours;
}

function historyStart(world: WorldSpan): string {
  return new Date(Math.min(Date.parse(world.startSim), Date.parse(world.toSim)) - HISTORY_DAYS * 86_400_000).toISOString();
}

async function partition(client: TableClient, table: Table, hashValue: string, prefix?: string): Promise<Key[]> {
  return (await client.query(table, { hashValue, ...(prefix === undefined ? {} : { range: { prefix } }) })).map(keyOf);
}

async function collectPeople(world: WorldSpan, deps: WorldItemsDeps, keys: Collector): Promise<string[]> {
  const { client, data } = deps;
  const phoneHashes: string[] = [];
  for (const role of StaffRole.options) {
    for (const person of await data.people.listPeople(world.ispId, role)) {
      keys.add("People", await partition(client, "People", personPartition(person.personId)));
      keys.add("Conversations", await partition(client, "Conversations", personPartition(person.personId)));
      if (role === "INSTALLER") keys.add("Runtime", [installerStateKey(person.personId)]);
      if (person.phoneHash === undefined) continue;
      phoneHashes.push(person.phoneHash);
      const claim = await data.people.getAddressClaim(world.clockId, person.phoneHash);
      if (claim?.personId === person.personId) keys.add("People", [addressClaimKey(world.clockId, person.phoneHash)]);
    }
  }
  for (const customer of await data.people.listCustomers(world.ispId)) keys.add("People", await partition(client, "People", `CUST#${customer.customerId}`));
  return phoneHashes;
}

async function collectOrders(world: WorldSpan, deps: WorldItemsDeps, keys: Collector): Promise<void> {
  const { client, data } = deps;
  const seen = new Set<string>();
  for (const day of daysOfSpan(historyStart(world), world.toSim)) {
    for (const order of await data.workOrders.listIspDay(world.ispId, day)) {
      if (seen.has(order.workOrderId) || order.clockId !== world.clockId) continue;
      seen.add(order.workOrderId);
      keys.add("WorkOrders", await partition(client, "WorkOrders", `WO#${order.workOrderId}`));
      keys.add("Dispatch", await partition(client, "Dispatch", `DWO#${world.ispId}#${order.workOrderNumber}`));
      if (order.onuSerial !== undefined) keys.add("Network", [{ PK: `ONU#${world.clockId}#${order.onuSerial}`, SK: "META" }]);
    }
  }
  for (const status of CaseStatus.options) {
    for (const caseItem of await data.cases.listCasesByStatus(world.ispId, status)) {
      if (caseItem.clockId === world.clockId) keys.add("Cases", await partition(client, "Cases", `CASE#${caseItem.caseId}`));
    }
  }
}

async function collectWorldLevel(world: WorldSpan, deps: WorldItemsDeps, keys: Collector, phoneHashes: readonly string[]): Promise<void> {
  const { client } = deps;
  keys.add("Isps", await partition(client, "Isps", ispPartition(world.ispId), "ROSTER#"));
  keys.add("Conversations", await partition(client, "Conversations", outboxPartition(world.ispId)));
  for (const month of monthsOfSpan(historyStart(world), world.toSim)) keys.add("AuditLog", await partition(client, "AuditLog", auditPartition(world.ispId, `${month}-01T00:00:00.000Z`)));
  for (const source of ["WORLD", "EVAL"]) keys.add("CuadrillaMetrics", await partition(client, "CuadrillaMetrics", metricsPartition(world.ispId), `${source}#${world.clockId}#`));
  keys.add("Runtime", [worldStateKey(world.clockId), faultsKey(world.clockId), ...(await partition(client, "Runtime", pendingPartition(world.clockId)))]);
  const hours = hoursOfSpan(world.startSim, world.toSim);
  keys.add("Runtime", phoneHashes.flatMap((hash) => hours.map((hour) => counterRowKey(COUNTER_KEYS.rateSim(world.clockId, hash, hour)))));
}

/** Deletes every item of the world (see the header for what stays); answers how many keys per table. */
export async function purgeWorldItems(world: WorldSpan, deps: WorldItemsDeps): Promise<DeletedCounts> {
  for (const lease of await deps.data.worlds.listPhoneLeases(world.clockId)) await deps.data.worlds.deletePhoneLease(lease.phoneHash);
  const keys = new Collector();
  const phoneHashes = await collectPeople(world, deps, keys);
  await collectOrders(world, deps, keys);
  await collectWorldLevel(world, deps, keys, phoneHashes);
  const counts: Partial<Record<Table, number>> = {};
  for (const [table, tableKeys] of keys.entries()) {
    if (tableKeys.length === 0) continue;
    await deps.client.batchDelete(table, tableKeys);
    counts[table] = tableKeys.length;
  }
  return counts;
}
