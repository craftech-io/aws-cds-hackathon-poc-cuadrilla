// The rows of a QA or evaluation world (docs/seed-spec.md §13, docs/tool-catalog.md `world.create`),
// built from the model orders of `Seed/worlds/models.json`, before anything is written:
//
//   operator        `isp-qa-<runId>-<scenario>` / `isp-eval-<runId>` with the visible name of
//                   `resolveBrand`, the settings of the models (plus the request's overrides) and their
//                   zones and crews
//   roster          per crew the operations use: the on-duty and backup supervisors and the zone chief,
//                   cloned with ids of the world (`sup-adriana-<clockId>`), so the ladder never reaches a
//                   person of another world; supervisors carry leased phones, the zone chief an email
//                   of the simulator
//   per operation   its installer (`inst-<clockId>-<key>`, own, or the one of another operation), a
//                   customer with an email of the simulator tagged by the world (`bounce+`/`complaint+`
//                   when the model asks), the order with a leased number, its checklist, its `Network`
//                   and `Dispatch` rows, and one `DAY_START` per installer of the start day; operations
//                   of one model share its ONU serial (labels ask for it) and so its single `Network` row
//
// Ids, phones and emails never repeat across worlds: the clock id is in every person and customer id,
// numbers and phones come from leases. No row names an operator: the visible name is runtime config.
import { DispatchOrderItem, dispatchOrderPk } from "@cuadrilla/dispatch-mock/items";
import { addCalendarDays } from "@cuadrilla/shared";
import type { Item, Table } from "../connector/table-client";
import { defaultWorldPolicy } from "../connector/world";
import type { DomainTable } from "../domain/registry";
import { localDateOf, zonedInstant } from "../services/business-hours/zoned-time";
import type { ModelOrder, ModelsTemplate, QaOperation, StaffModel } from "./templates";

export const SIMULATOR_DOMAIN = "simulator.amazonses.com";
const DAY_START_TIME = "07:30";

export interface QaWorldPlan {
  readonly clockId: string;
  readonly ispId: string;
  readonly kind: "QA" | "EVAL";
  readonly startAtSim: string;
  /** Epoch of the world's clock: the orders carry it. */
  readonly worldEpoch: number;
  readonly displayName: string;
  readonly models: ModelsTemplate;
  readonly operations: readonly QaOperation[];
  /** Leased work order number per operation key. */
  readonly numbers: ReadonlyMap<string, string>;
  /** Leased phone (E.164) per person id of the world. */
  readonly phones: ReadonlyMap<string, string>;
  readonly phoneHash: (phone: string) => string;
  /** Overrides of the settings (`rateLimitPerHour`, `demoMode`, `templateStatus`, `turnCaps`, `simulatorCaps`). */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Real instant of the build. */
  readonly now: Date;
}

export interface QaWorldRows {
  readonly domain: ReadonlyMap<DomainTable, Item[]>;
  readonly mocks: { readonly Network: Item[]; readonly Dispatch: Item[] };
  /** Installer of each operation and work order id, in operation order. */
  readonly operations: ReadonlyArray<{ readonly key: string; readonly workOrderId: string; readonly installerId: string; readonly model: ModelOrder }>;
}

/** The world's clone of a staff member of the models (`sup-adriana-qa-812-1-sc-02`). */
export function staffIdOf(personId: string, clockId: string): string {
  return `${personId}-${clockId}`;
}

/** The installer of an operation of its own (`inst-qa-812-1-sc-02-a`). */
export function installerIdOf(clockId: string, key: string): string {
  return `inst-${clockId}-${key}`;
}

/** Local part tag of the world's simulator emails (`success+<tag>-<who>@…`), short enough for any run id. */
export function emailTagOf(clockId: string): string {
  return clockId.slice(0, 40).replace(/-+$/, "");
}

export function modelOf(models: ModelsTemplate, model: string): ModelOrder {
  const found = models.models.find((candidate) => candidate.model === model);
  if (found === undefined) throw new RangeError(`model ${model} is not in the models template`);
  return found;
}

/** The person each operation's installer is: its own, or the one of the operation it names. */
export function installersOf(clockId: string, operations: readonly QaOperation[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const operation of operations) if (operation.installer === "own") byKey.set(operation.key, installerIdOf(clockId, operation.key));
  for (const operation of operations) {
    if (operation.installer === "own") continue;
    const shared = byKey.get(operation.installer);
    if (shared === undefined) throw new RangeError(`operation ${operation.key} names the installer of ${operation.installer}, which has no own installer`);
    byKey.set(operation.key, shared);
  }
  return byKey;
}

/** The crews the operations use, with their cloned staff. */
export function crewsOf(plan: Pick<QaWorldPlan, "models" | "operations">): ModelsTemplate["crews"] {
  const used = new Set(plan.operations.map((operation) => modelOf(plan.models, operation.model).crewId));
  return plan.models.crews.filter((crew) => used.has(crew.crewId));
}

class Rows {
  readonly domain = new Map<DomainTable, Item[]>();
  readonly network: Item[] = [];
  readonly dispatch: Item[] = [];

  constructor(
    private readonly meta: Record<string, unknown>,
    private readonly scope: (table: Table) => Record<string, unknown>,
  ) {}

  add(table: DomainTable, row: Record<string, unknown> & { PK: string; SK: string }): void {
    this.domain.set(table, [...(this.domain.get(table) ?? []), { ...row, ...this.meta, ...this.scope(table) } as Item]);
  }

  /** A mock row; the first one of a key wins (operations of one model share its ONU, one row per serial). */
  mock(table: "Network" | "Dispatch", row: Item): void {
    const rows = table === "Network" ? this.network : this.dispatch;
    if (rows.some((existing) => existing.PK === row.PK && existing.SK === row.SK)) return;
    rows.push({ ...row, ...this.scope(table) });
  }
}

function sortName(lastName: string, firstName: string, id: string): string {
  const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return `${fold(lastName)}#${fold(firstName)}#${id}`;
}

function addPerson(rows: Rows, plan: QaWorldPlan, staff: StaffModel, personId: string, extra: { crewId?: string; zoneId?: string; email?: string }): void {
  const phone = plan.phones.get(personId);
  rows.add("People", {
    PK: `PERSON#${personId}`,
    SK: "META",
    entity: "Person",
    personId,
    ispId: plan.ispId,
    clockId: plan.clockId,
    role: staff.role,
    firstName: staff.firstName,
    lastName: staff.lastName,
    ...(extra.crewId === undefined ? {} : { crewId: extra.crewId }),
    ...(extra.zoneId === undefined ? {} : { zoneId: extra.zoneId }),
    ...(phone === undefined ? {} : { phone, phoneHash: plan.phoneHash(phone) }),
    ...(extra.email === undefined ? {} : { email: extra.email }),
    active: staff.optIn !== "REVOKED",
    sortName: sortName(staff.lastName, staff.firstName, personId),
    history: [],
  });
  if (staff.optIn === "NONE") return;
  const atSim = new Date(Date.parse(plan.startAtSim) - 7 * 86_400_000).toISOString();
  const granted = staff.optIn === "GRANTED";
  rows.add("People", {
    PK: `PERSON#${personId}`,
    SK: "CONSENT#WHATSAPP",
    entity: "Consent",
    personId,
    clockId: plan.clockId,
    kind: "WHATSAPP_OPT_IN",
    status: granted ? "GRANTED" : "REVOKED",
    medium: "QA",
    textVersion: "v001",
    ...(granted ? { grantedAtSim: atSim } : { revokedAtSim: atSim }),
    history: [{ field: "consent", to: granted ? "GRANTED" : "REVOKED", atSim, atReal: plan.now.toISOString(), actor: "QA", reason: "world.create" }],
  });
}

function addOperator(rows: Rows, plan: QaWorldPlan, timeZone: string): void {
  const { models } = plan;
  const tag = emailTagOf(plan.clockId);
  rows.add("Isps", { PK: `ISP#${plan.ispId}`, SK: "META", entity: "Isp", ispId: plan.ispId, kind: plan.kind, clockId: plan.clockId, displayName: plan.displayName, opsMailbox: `success+${tag}-ops@${SIMULATOR_DOMAIN}` });
  rows.add("Isps", { PK: `ISP#${plan.ispId}`, SK: "SETTINGS", entity: "IspSettings", ispId: plan.ispId, clockId: plan.clockId, ...models.settings, timezone: timeZone, whatsappMode: "simulated", ...(plan.settings ?? {}), history: [] });
  for (const zone of models.zones) {
    const crew = models.crews.find((candidate) => candidate.zoneId === zone.zoneId);
    if (crew === undefined) continue;
    rows.add("Isps", { PK: `ISP#${plan.ispId}`, SK: `ZONE#${zone.zoneId}`, entity: "Zone", ispId: plan.ispId, clockId: plan.clockId, zoneId: zone.zoneId, name: zone.name, opticalClass: zone.opticalClass, acceptanceRange: zone.acceptanceRange, zoneChiefId: staffIdOf(crew.zoneChief.personId, plan.clockId) });
  }
  for (const crew of models.crews) rows.add("Isps", { PK: `ISP#${plan.ispId}`, SK: `CREW#${crew.crewId}`, entity: "Crew", ispId: plan.ispId, clockId: plan.clockId, crewId: crew.crewId, zoneId: crew.zoneId, name: crew.name });
  for (const user of models.consoleUsers) rows.add("Isps", { PK: `ISP#${plan.ispId}`, SK: `USER#${user.userId}`, entity: "ConsoleUser", ispId: plan.ispId, userId: user.userId, role: user.role, name: user.name, cognitoSub: "", active: true });
}

function addRoster(rows: Rows, plan: QaWorldPlan, timeZone: string, startDate: string): void {
  const tag = emailTagOf(plan.clockId);
  for (const crew of crewsOf(plan)) {
    const primaryId = staffIdOf(crew.primary.personId, plan.clockId);
    const secondaryId = staffIdOf(crew.secondary.personId, plan.clockId);
    const chiefId = staffIdOf(crew.zoneChief.personId, plan.clockId);
    addPerson(rows, plan, crew.primary, primaryId, { crewId: crew.crewId, zoneId: crew.zoneId });
    addPerson(rows, plan, crew.secondary, secondaryId, { crewId: crew.crewId, zoneId: crew.zoneId });
    addPerson(rows, plan, crew.zoneChief, chiefId, { zoneId: crew.zoneId, email: `success+${tag}-${crew.zoneChief.personId}@${SIMULATOR_DOMAIN}` });
    for (const date of [addCalendarDays(startDate, -1), startDate, addCalendarDays(startDate, 1)]) {
      rows.add("Isps", {
        PK: `ISP#${plan.ispId}`,
        SK: `ROSTER#${crew.crewId}#${date}`,
        entity: "ShiftRoster",
        ispId: plan.ispId,
        clockId: plan.clockId,
        crewId: crew.crewId,
        date,
        primaryId,
        secondaryId,
        startsAtSim: zonedInstant(date, crew.shift.start, timeZone).toISOString(),
        endsAtSim: zonedInstant(date, crew.shift.end, timeZone).toISOString(),
        history: [],
      });
    }
  }
}

function emailOf(plan: QaWorldPlan, key: string, outcome: ModelOrder["customer"]["emailOutcome"]): string {
  return `${outcome}+${emailTagOf(plan.clockId)}-${key}@${SIMULATOR_DOMAIN}`;
}

function addOrder(rows: Rows, plan: QaWorldPlan, operation: QaOperation, installerId: string, timeZone: string, startDate: string): { workOrderId: string; model: ModelOrder; date: string; windowStartSim: string } {
  const model = modelOf(plan.models, operation.model);
  const number = plan.numbers.get(operation.key);
  if (number === undefined) throw new RangeError(`operation ${operation.key} has no leased number`);
  const workOrderId = `wo-${number}`;
  const customerId = `${model.customer.customerId}-${plan.clockId}-${operation.key}`;
  const date = addCalendarDays(startDate, model.dayOffset);
  const window = { startSim: zonedInstant(date, model.window.start, timeZone).toISOString(), endSim: zonedInstant(date, model.window.end, timeZone).toISOString() };
  const { customer } = model;
  rows.add("People", {
    PK: `CUST#${customerId}`,
    SK: "META",
    entity: "Customer",
    customerId,
    ispId: plan.ispId,
    clockId: plan.clockId,
    firstName: customer.firstName,
    lastName: customer.lastName,
    addressLine: customer.addressLine,
    neighborhood: customer.neighborhood,
    email: emailOf(plan, operation.key, customer.emailOutcome),
    ...(customer.note === undefined ? {} : { note: customer.note }),
    sortName: sortName(customer.lastName, customer.firstName, customerId),
  });
  const closed = model.status === "CLOSED";
  rows.add("WorkOrders", {
    PK: `WO#${workOrderId}`,
    SK: "META",
    entity: "WorkOrder",
    workOrderId,
    workOrderNumber: number,
    ispId: plan.ispId,
    clockId: plan.clockId,
    worldEpoch: plan.worldEpoch,
    sessionEpoch: 0,
    installerId,
    customerId,
    crewId: model.crewId,
    zoneId: model.zoneId,
    date,
    appointmentWindow: window,
    plan: model.plan,
    onuSerial: model.onuSerial,
    onuModel: model.onuModel,
    oltPort: model.oltPort,
    opticalClass: model.opticalClass,
    status: model.status,
    onHoldSafety: false,
    ...(closed ? { closedAtSim: window.endSim } : {}),
    history: [],
  });
  for (const item of ["ONU_ONLINE", "POWER_READING_PHOTO", "ONU_LABEL_PHOTO", "ROSETTE_PHOTO", "CUSTOMER_OK"]) {
    rows.add("WorkOrders", { PK: `WO#${workOrderId}`, SK: `CHECK#${item}`, entity: "ChecklistItem", workOrderId, clockId: plan.clockId, item, status: closed ? "PASSED" : "PENDING", attempts: 0, history: [] });
  }
  const at = plan.now.toISOString();
  rows.mock("Network", { PK: `ONU#${plan.clockId}#${model.onuSerial}`, SK: "META", entity: "Onu", clockId: plan.clockId, serial: model.onuSerial, behaviour: model.onu.behaviour, ...(model.onu.rxPowerDbm === undefined ? {} : { rxPowerDbm: model.onu.rxPowerDbm }), oltPort: model.oltPort, profile: model.plan, fixed: false, queryCount: 0, createdAt: at, updatedAt: at, version: 1 });
  rows.mock(
    "Dispatch",
    DispatchOrderItem.parse({
      PK: dispatchOrderPk(plan.ispId, number),
      SK: "META",
      entity: "DispatchOrder",
      ispId: plan.ispId,
      clockId: plan.clockId,
      workOrderNumber: number,
      workOrderId,
      installerId,
      customerId,
      plan: model.plan,
      appointmentWindow: { start: window.startSim, end: window.endSim },
      status: "SCHEDULED",
      createdAt: at,
      updatedAt: at,
      version: 1,
    }) as unknown as Item,
  );
  return { workOrderId, model, date, windowStartSim: window.startSim };
}

function addDayStarts(rows: Rows, plan: QaWorldPlan, orders: ReadonlyArray<{ workOrderId: string; installerId: string; date: string; windowStartSim: string }>, timeZone: string, startDate: string): void {
  const dueAtSim = zonedInstant(startDate, DAY_START_TIME, timeZone).toISOString();
  for (const installerId of new Set(orders.map((order) => order.installerId))) {
    const first = orders.filter((order) => order.installerId === installerId && order.date === startDate).sort((a, b) => Date.parse(a.windowStartSim) - Date.parse(b.windowStartSim))[0];
    const timerId = `day-start-${startDate}-${installerId}`;
    const home = first === undefined ? { kind: "PERSON", id: installerId } : { kind: "WORK_ORDER", id: first.workOrderId };
    const PK = first === undefined ? `PERSON#${installerId}` : `WO#${first.workOrderId}`;
    rows.add(first === undefined ? "People" : "WorkOrders", { PK, SK: `TIMER#DAY_START#${timerId}`, entity: "Timer", timerId, kind: "DAY_START", home, clockId: plan.clockId, dueAtSim, status: "SCHEDULED", reason: "Inicio del día", payload: { date: startDate, installerId } });
  }
}

/** Every row of the world; throws (before anything is written) for an operation the models cannot clone. */
export function qaWorldRows(plan: QaWorldPlan): QaWorldRows {
  const timeZone = plan.models.settings.timezone;
  const startDate = localDateOf(new Date(plan.startAtSim), timeZone);
  // Every row is stamped with the world's scope, also those without a clock (console users).
  const scope = (table: Table): Record<string, unknown> => {
    const stamp = defaultWorldPolicy(plan.clockId, table, plan.now);
    return { ...(stamp.world === undefined ? {} : { world: stamp.world }), ...(stamp.expiresAt === undefined ? {} : { expiresAt: stamp.expiresAt }) };
  };
  const rows = new Rows({ createdAt: plan.now.toISOString(), updatedAt: plan.now.toISOString(), version: 1, synthetic: true }, scope);
  addOperator(rows, plan, timeZone);
  addRoster(rows, plan, timeZone, startDate);
  const installers = installersOf(plan.clockId, plan.operations);
  const seenInstallers = new Set<string>();
  const orders: Array<{ key: string; workOrderId: string; installerId: string; model: ModelOrder; date: string; windowStartSim: string }> = [];
  for (const operation of plan.operations) {
    const installerId = installers.get(operation.key) ?? installerIdOf(plan.clockId, operation.key);
    const model = modelOf(plan.models, operation.model);
    if (!seenInstallers.has(installerId)) {
      seenInstallers.add(installerId);
      addPerson(rows, plan, model.installer, installerId, { crewId: model.crewId, zoneId: model.zoneId });
      rows.add("People", { PK: `PERSON#${installerId}`, SK: "PROFILE", entity: "InstallerProfile", installerId, clockId: plan.clockId, rejects: {}, stepsBySymptom: {}, casesByReason: {}, events: [] });
    }
    orders.push({ key: operation.key, installerId, ...addOrder(rows, plan, operation, installerId, timeZone, startDate) });
  }
  addDayStarts(rows, plan, orders, timeZone, startDate);
  return { domain: rows.domain, mocks: { Network: rows.network, Dispatch: rows.dispatch }, operations: orders.map(({ key, workOrderId, installerId, model }) => ({ key, workOrderId, installerId, model })) };
}
