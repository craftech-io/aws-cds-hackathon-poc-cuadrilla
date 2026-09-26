// The five world templates (docs/seed-spec.md §3, lib/worlds.ts): `demo` and `judge` item by item,
// `models` with every order of §7 and its people, `qa-min` and `eval` as the operations the world
// factory clones from the models. All of them run `whatsappMode: simulated`.
import { judgeBlock } from "../lib/synthetic";
import type { SeedItem, WorldTable } from "../lib/tables";
import type { EvalQuestionDef } from "../lib/questions";
import { TEMPLATE_VERSION, type EvalTemplate, type ModelOrder, type ModelsTemplate, type QaMinTemplate, type WorldTablesTemplate } from "../lib/worlds";
import type { PhotoEntry } from "../photos/schema";
import { CREWS, ONU_MODEL, ZONES, staff, zoneOfOrder, type OrderDef, type StaffDef } from "./catalog";
import { GENERATOR, GENERATOR_VERSION } from "./context";
import { scriptedKpi } from "./metrics";
import { worldSettings } from "./org";
import { isClosedHistory } from "./orders";
import type { CustomerDef } from "./people";
import { judgeScenes, judgeTour } from "./scenes";
import { DAYS, WORLD_START_SIM } from "./time";
import { TEMPLATE_JUDGE, type WorldSpec } from "./world";

const HEADER = { templateVersion: TEMPLATE_VERSION, generator: GENERATOR, generatorVersion: GENERATOR_VERSION, seed: 20260926, startAtSim: WORLD_START_SIM, whatsappMode: "simulated" } as const;

/** The order every answerable or risky question of `EV-01` is asked on: an ordinary online order of the day. */
export const EVAL_QUESTION_MODEL = "wo-24819";
/** The two orders of `qa-min` (docs/seed-spec.md §3). */
export const QA_MIN_MODELS = ["wo-24817", "wo-24820"] as const;

export function worldTemplate(world: WorldSpec, tables: Readonly<Record<WorldTable, readonly SeedItem[]>>): WorldTablesTemplate {
  const base = {
    template: world.name,
    ...HEADER,
    ispId: world.ispId,
    clockId: world.clockId,
    unknownNumber: world.unknownNumber,
    tables: Object.fromEntries(Object.entries(tables).map(([table, items]) => [table, [...items]])) as WorldTablesTemplate["tables"],
  };
  if (world.kind === "DEMO") return base;
  const tokens = judgeBlock(TEMPLATE_JUDGE);
  return {
    ...base,
    placeholders: { judgeNumber: "00", clockTag: "j00", ispId: world.ispId, clockId: world.clockId, phoneBlock: tokens.phoneBlock, emailTag: "j00" },
    judgeTest: { simulatorCaps: { messagesPerRealHourPerIdentity: 80, turnsPerHour: 180, emailsPerDay: 60 }, consoleUsers: [{ userId: "usr-qa-judge", role: "JUDGE", name: "Jurado de QA" }] },
    tour: judgeTour(world),
    scenes: judgeScenes(world),
  };
}

function staffModel(person: StaffDef) {
  return { personId: person.personId, role: person.role, firstName: person.firstName, lastName: person.lastName, optIn: person.optIn === null ? ("NONE" as const) : person.optIn.revokedOn === undefined ? ("GRANTED" as const) : ("REVOKED" as const) };
}

function modelOrder(order: OrderDef, customer: CustomerDef): ModelOrder {
  const installer = staff(order.installerId);
  const zone = zoneOfOrder(order);
  return {
    model: `wo-${order.number}`,
    workOrderNumber: order.number,
    dayOffset: order.date === DAYS.history ? -1 : order.date === DAYS.next ? 1 : 0,
    window: { start: order.window[0], end: order.window[1] },
    plan: order.plan,
    onuSerial: order.serial,
    onuModel: ONU_MODEL,
    oltPort: order.oltPort,
    opticalClass: zone.opticalClass,
    zoneId: zone.zoneId,
    crewId: installer.crewId ?? "",
    status: isClosedHistory(order) ? "CLOSED" : "SCHEDULED",
    installer: { ...staffModel(installer), crewId: installer.crewId ?? "" },
    customer: {
      customerId: `cust-${customer.customer}`,
      firstName: customer.firstName,
      lastName: customer.lastName,
      addressLine: customer.addressLine,
      neighborhood: customer.neighborhood,
      emailOutcome: customer.emailOutcome,
      ...(customer.note === undefined ? {} : { note: customer.note }),
    },
    onu: { behaviour: order.behaviour, ...(order.rxDbm === undefined ? {} : { rxPowerDbm: order.rxDbm }) },
    story: order.story,
  };
}

export function modelsTemplate(demo: WorldSpec, customers: ReadonlyMap<number, CustomerDef>): ModelsTemplate {
  return {
    template: "models",
    ...HEADER,
    zones: ZONES.map((zone) => ({ zoneId: zone.zoneId, name: zone.name, opticalClass: zone.opticalClass, acceptanceRange: { ...zone.acceptanceRange } })),
    crews: CREWS.map((crew) => ({
      crewId: crew.crewId,
      zoneId: crew.zoneId,
      name: crew.name,
      shift: { start: crew.shift[0], end: crew.shift[1] },
      primary: staffModel(staff(crew.primaryId)),
      secondary: staffModel(staff(crew.secondaryId)),
      zoneChief: staffModel(staff(ZONES.find((zone) => zone.zoneId === crew.zoneId)?.zoneChiefId ?? "")),
    })),
    settings: worldSettings(),
    consoleUsers: [
      { userId: "usr-qa-sup", role: "SUPERVISOR", name: "Supervisión QA" },
      { userId: "usr-qa-ops", role: "OPS", name: "Operaciones QA" },
    ],
    models: demo.orders.map((order) => {
      const customer = customers.get(order.customer);
      if (customer === undefined) throw new RangeError(`no customer ${order.customer}`);
      return modelOrder(order, customer);
    }),
  };
}

export function qaMinTemplate(): QaMinTemplate {
  return {
    template: "qa-min",
    ...HEADER,
    operations: QA_MIN_MODELS.map((model, index) => ({ key: index === 0 ? "a" : "b", model, installer: "own" as const })),
    metrics: QA_MIN_MODELS.map((model, index) => ({ key: index === 0 ? "a" : "b", source: "WORLD" as const, agentMode: "SCRIPTED" as const, ...scriptedKpi(`qa-min-${model}`, 3) })),
  };
}

export function evalTemplate(questions: readonly EvalQuestionDef[], photos: readonly PhotoEntry[]): EvalTemplate {
  return {
    template: "eval",
    ...HEADER,
    questions: questions.map((question) => ({ questionId: question.questionId, model: EVAL_QUESTION_MODEL, installer: "own" as const })),
    photos: photos.map((photo) => {
      if (photo.workOrderId === null) throw new RangeError(`${photo.photoId} names no model order`);
      return {
        photoId: photo.photoId,
        item: photo.item,
        model: photo.workOrderId,
        installer: "own" as const,
        onu: { behaviour: "ONLINE_OK" as const, rxPowerDbm: photo.orchestratorRxDbm, operState: photo.operState },
        ...(photo.precondition === undefined ? {} : { precondition: { seedPassEvidence: { photoId: photo.precondition.seededPassEvidenceOf, item: photo.item, on: "separate-order" as const } } }),
      };
    }),
  };
}
