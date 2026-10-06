import { beforeEach, describe, expect, it } from "vitest";
import { CLOCK, ISP, installer, testConnector, workOrder } from "../connector/testing";
import type { Timer } from "../domain/timers";
import { createLogger } from "../lib/log";
import { type FireDayStartRequest, dayStartRequestOf, fireDayStart } from "./day-start";
import { dayStartTimerId, planDay } from "./plan-day";
import type { DayStartDeps } from "./ports";
import { policySender, recordingTimers, seedOperator } from "./testing";

const REAL_NOW = "2026-11-02T18:00:00.000Z";
const DAY = "2026-10-13";
const NEXT = "2026-10-14";
/** 07:30 of 13/10 and 14/10 in Mexico City. */
const DUE = "2026-10-13T13:30:00.000Z";
const DUE_NEXT = "2026-10-14T13:30:00.000Z";

let world: ReturnType<typeof testConnector>;
let sender: ReturnType<typeof policySender>;
let timers: ReturnType<typeof recordingTimers>;
let deps: DayStartDeps;
let logs: Array<Record<string, unknown>>;

const window = (date: string, start: string, end: string) => ({ startSim: `${date}T${start}:00-06:00`, endSim: `${date}T${end}:00-06:00` });

async function person(personId: string, firstName: string, hash: string, consent: "GRANTED" | "REVOKED" | "NONE", active = true): Promise<void> {
  const { people } = world.connector;
  await people.createPerson(installer({ personId, firstName, phone: `+52550101${hash.charCodeAt(0)}`, phoneHash: hash.repeat(64), active }));
  if (consent === "NONE") return;
  await people.grantConsent({ personId, clockId: CLOCK, medium: "WHATSAPP_KEYWORD", textVersion: "v001" }, { actor: `PERSON:${personId}`, atSim: "2026-10-01T08:00:00-06:00" });
  if (consent === "REVOKED") await people.revokeConsent(personId, { actor: `PERSON:${personId}`, atSim: "2026-10-05T08:00:00-06:00" });
}

/** The 13/10 of docs/seed-spec.md in small: Rogelio with three orders, Karina with one, Lorena with none. */
async function seedWorld(): Promise<void> {
  await seedOperator(world.connector, "2026-10-13T07:00:00-06:00");
  await person("inst-rogelio", "Rogelio", "a", "GRANTED");
  await person("inst-karina", "Karina", "b", "GRANTED");
  await person("inst-lorena", "Lorena", "c", "GRANTED");
  await person("inst-julian", "Julián", "d", "NONE");
  await person("inst-ernesto", "Ernesto", "e", "REVOKED");
  await person("inst-tomas", "Tomás", "f", "GRANTED", false);
  const { workOrders } = world.connector;
  await workOrders.createWorkOrder(workOrder({ appointmentWindow: window(DAY, "09:00", "11:00") }));
  await workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24818", workOrderNumber: "24818", customerId: "cust-10422", appointmentWindow: window(DAY, "11:30", "13:30") }));
  await workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24819", workOrderNumber: "24819", customerId: "cust-10423", appointmentWindow: window(DAY, "15:00", "17:00") }));
  await workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24820", workOrderNumber: "24820", customerId: "cust-10424", installerId: "inst-karina", appointmentWindow: window(DAY, "10:00", "12:00") }));
  await workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24830", workOrderNumber: "24830", customerId: "cust-10425", installerId: "inst-julian", appointmentWindow: window(DAY, "09:00", "11:00") }));
  await workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24831", workOrderNumber: "24831", customerId: "cust-10425", installerId: "inst-ernesto", appointmentWindow: window(DAY, "09:00", "11:00") }));
}

/** The planned timer of an installer for `date`, as `TimerPort.fire` leaves it when it fires. */
async function fired(installerId: string, date = DAY): Promise<Timer> {
  const request = timers.armed.find((armed) => armed.timerId === dayStartTimerId(installerId, date));
  if (request === undefined) throw new Error(`no timer planned for ${installerId} on ${date}`);
  const ref = { home: request.home, kind: request.kind, timerId: request.timerId };
  const timer = await world.connector.timers.getTimer(ref);
  if (timer === undefined) throw new Error("timer missing");
  return world.connector.timers.setTimerStatus(ref, { status: "FIRED", firedBy: "CLOCK", firedAtSim: timer.dueAtSim }, timer.version);
}

const fire = async (installerId: string, date = DAY): Promise<ReturnType<typeof fireDayStart>> => fireDayStart(deps, dayStartRequestOf(await fired(installerId, date), `${date}T07:30:00-06:00`, "corr-day-0001"));
const forced = (installerId: string, date = DAY): FireDayStartRequest => ({ clockId: CLOCK, installerId, date, eventAtSim: `${date}T07:40:00-06:00`, correlationId: "corr-day-0002" });

beforeEach(async () => {
  world = testConnector(REAL_NOW);
  logs = [];
  sender = policySender(world.connector, REAL_NOW);
  timers = recordingTimers(world.connector);
  deps = { connector: world.connector, timers, sender, logger: createLogger({ level: "debug", correlationId: "corr-day", sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>) }) };
  await seedWorld();
  await planDay(deps, { ispId: ISP, clockId: CLOCK, date: DAY, atSim: "2026-10-13T07:00:00-06:00", actor: "SEED" });
});

describe("[FL-009] plan_day: one DAY_START at 07:30 for every active installer", () => {
  it("[FL-009] plans every active installer, with or without orders or opt-in, on the first order or on the person", async () => {
    const homes = Object.fromEntries(timers.armed.map((armed) => [armed.payload?.installerId, armed.home]));
    expect(homes).toEqual({
      "inst-rogelio": { kind: "WORK_ORDER", id: "wo-24817" },
      "inst-karina": { kind: "WORK_ORDER", id: "wo-24820" },
      "inst-lorena": { kind: "PERSON", id: "inst-lorena" },
      "inst-julian": { kind: "WORK_ORDER", id: "wo-24830" },
      "inst-ernesto": { kind: "WORK_ORDER", id: "wo-24831" },
    });
    expect(timers.armed.every((armed) => armed.kind === "DAY_START" && armed.dueAtSim === DUE && armed.clockId === CLOCK)).toBe(true);
    expect(timers.armed.find((armed) => armed.payload?.installerId === "inst-rogelio")).toMatchObject({ timerId: "day-start-2026-10-13-inst-rogelio", reason: "Inicio del día", payload: { installerId: "inst-rogelio", date: DAY } });
  });

  it("[FL-009] is idempotent: a planned day is left as it is, also once an order appears on it", async () => {
    await world.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24840", workOrderNumber: "24840", installerId: "inst-lorena", customerId: "cust-10425", appointmentWindow: window(DAY, "08:00", "09:00") }));
    const again = await planDay(deps, { ispId: ISP, clockId: CLOCK, date: DAY, atSim: "2026-10-13T07:05:00-06:00", actor: "SYSTEM" });
    expect(again.planned).toEqual([]);
    expect([...again.existing].sort()).toEqual(["inst-ernesto", "inst-julian", "inst-karina", "inst-lorena", "inst-rogelio"]);
  });
});

describe("[FL-009] fire_day_start: the template ordenes_del_dia with the day counted from the orders", () => {
  it("[FL-009] sends the template with the first name, the number of orders and the first window, then plans the next day", async () => {
    const outcome = await fire("inst-rogelio");
    expect(outcome).toMatchObject({ status: "SENT", workOrderIds: ["wo-24817", "wo-24818", "wo-24819"] });
    expect(sender.requests[0]).toMatchObject({
      installerId: "inst-rogelio",
      templateName: "ordenes_del_dia",
      params: ["Rogelio", "3", "09:00 a 11:00"],
      buttons: [{ action: "VIEW_ORDERS", object: { kind: "DAY", id: DAY } }],
      timerKey: "WORK_ORDER|wo-24817|DAY_START|day-start-2026-10-13-inst-rogelio",
    });
    const messages = await world.connector.conversations.listMessages("inst-rogelio");
    expect(messages.map((message) => [message.kind, message.templateName, message.templateParams])).toEqual([["DAY_START", "ordenes_del_dia", ["Rogelio", "3", "09:00 a 11:00"]]]);
    expect(messages[0]?.text).toBe("Hola Rogelio, hoy tienes 3 instalaciones asignadas en tu ruta. La primera cita es de 09:00 a 11:00. Toca Ver órdenes para recibir el detalle de cada una.");
    const next = timers.armed.filter((armed) => armed.dueAtSim === DUE_NEXT);
    expect(next.map((armed) => armed.payload?.installerId).sort()).toEqual(["inst-ernesto", "inst-julian", "inst-karina", "inst-lorena", "inst-rogelio"]);
    expect(outcome.nextDay).toMatchObject({ date: NEXT, dueAtSim: DUE_NEXT });
  });

  it("[FL-009] an installer without orders gets nothing: the timer ends SKIPPED NO_WORK_ORDERS", async () => {
    const outcome = await fire("inst-lorena");
    expect(outcome).toMatchObject({ status: "SKIPPED", reason: "NO_WORK_ORDERS", workOrderIds: [] });
    expect(sender.requests).toEqual([]);
    expect(await world.connector.conversations.listMessages("inst-lorena")).toEqual([]);
    const timer = await world.connector.timers.getTimer({ home: { kind: "PERSON", id: "inst-lorena" }, kind: "DAY_START", timerId: dayStartTimerId("inst-lorena", DAY) });
    expect(timer).toMatchObject({ status: "SKIPPED", reason: "NO_WORK_ORDERS" });
    const actions = await world.connector.audit.listByDecision(ISP, "ACTION");
    expect(actions.some((row) => row.action === "DAY_START_SKIPPED" && row.reason === "NO_WORK_ORDERS")).toBe(true);
    expect(outcome.nextDay?.planned).toContain("inst-lorena");
  });

  it("[FL-009] the policy decides consent: without opt-in or after BAJA nothing is sent", async () => {
    expect(await fire("inst-julian")).toMatchObject({ status: "DENIED", ruleIds: ["CP-OPTIN"] });
    expect(await fire("inst-ernesto")).toMatchObject({ status: "DENIED", ruleIds: ["CP-OPTOUT"] });
    expect(await world.connector.conversations.listMessages("inst-julian")).toEqual([]);
  });
});

describe("[FL-012] one day start per installer and day", () => {
  it("[FL-012] a second start the same simulated day is denied by CP-ONE-DAYSTART and sends nothing", async () => {
    expect(await fire("inst-rogelio")).toMatchObject({ status: "SENT" });
    expect(await fireDayStart(deps, forced("inst-rogelio"))).toMatchObject({ status: "DENIED", ruleIds: ["CP-ONE-DAYSTART"] });
    const sent = (await world.connector.conversations.listMessages("inst-rogelio")).filter((message) => message.kind === "DAY_START");
    expect(sent).toHaveLength(1);
    const denials = await world.connector.audit.listByDecision(ISP, "DENY");
    expect(denials.map((row) => row.ruleIds)).toEqual([["CP-ONE-DAYSTART"]]);
  });

  it("[FL-012] the next day plans no second timer for a day already planned", async () => {
    await fire("inst-rogelio");
    const before = timers.armed.length;
    await fire("inst-karina");
    expect(timers.armed.length).toBe(before);
  });
});

describe("[FL-014] orders the dispatch moved count on their new day", () => {
  it("[FL-014] a rescheduled order counts on its new day, a cancelled one never, a reassigned one for its new installer", async () => {
    const { workOrders } = world.connector;
    await workOrders.updateWorkOrder("wo-24819", { date: NEXT, appointmentWindow: window(NEXT, "08:30", "10:30") });
    await workOrders.setStatus("wo-24819", "RESCHEDULED", { actor: "SYSTEM", atSim: "2026-10-13T07:10:00-06:00" });
    await workOrders.setStatus("wo-24818", "CANCELLED", { actor: "SYSTEM", atSim: "2026-10-13T07:10:00-06:00" });
    await workOrders.updateWorkOrder("wo-24820", { installerId: "inst-lorena" });

    expect(await fire("inst-rogelio")).toMatchObject({ status: "SENT", workOrderIds: ["wo-24817"] });
    expect(sender.requests.at(-1)?.params).toEqual(["Rogelio", "1", "09:00 a 11:00"]);
    expect(await fire("inst-karina")).toMatchObject({ status: "SKIPPED", reason: "NO_WORK_ORDERS" });
    expect(await fireDayStart(deps, forced("inst-lorena"))).toMatchObject({ status: "SENT", workOrderIds: ["wo-24820"] });

    const rogelioNext = timers.armed.find((armed) => armed.timerId === dayStartTimerId("inst-rogelio", NEXT));
    expect(rogelioNext?.home).toEqual({ kind: "WORK_ORDER", id: "wo-24819" });
    expect(await fire("inst-rogelio", NEXT)).toMatchObject({ status: "SENT", workOrderIds: ["wo-24819"] });
    expect(sender.requests.at(-1)?.params).toEqual(["Rogelio", "1", "08:30 a 10:30"]);
  });
});

describe("fire_day_start inputs", () => {
  it("reads installer and day from the timer and refuses a timer of another kind", async () => {
    const timer = await fired("inst-rogelio");
    expect(dayStartRequestOf(timer, "2026-10-13T07:30:00-06:00", "corr")).toMatchObject({ clockId: CLOCK, installerId: "inst-rogelio", date: DAY });
    expect(() => dayStartRequestOf({ ...timer, kind: "CASE_TIMEOUT" }, "2026-10-13T07:30:00-06:00", "corr")).toThrow(/not DAY_START/);
  });

  it("skips an installer that is not in the world, and keeps the start when planning the next day fails", async () => {
    expect(await fireDayStart(deps, forced("inst-nadie"))).toMatchObject({ status: "SKIPPED", reason: "INSTALLER_NOT_FOUND" });
    const broken = { ...deps, timers: { arm: async () => Promise.reject(new Error("scheduler down")) } };
    const outcome = await fireDayStart(broken, dayStartRequestOf(await fired("inst-rogelio"), "2026-10-13T07:30:00-06:00", "corr"));
    expect(outcome).toMatchObject({ status: "SENT" });
    expect(outcome.nextDay).toBeUndefined();
    expect(logs.some((line) => line.message === "dayplan.next_day_failed")).toBe(true);
  });
});
