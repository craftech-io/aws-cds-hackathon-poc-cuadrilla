// The fence of the QaDriver (ADR-0007, docs/tool-catalog.md "Acciones del QaDriver", docs/test-plan.md §4.1
// and §4.4): which worlds and actions it may touch, the closed list of the test guest's world, the seam of
// the own sign-up fenced by the address Cognito holds (never the input's), and idempotency by key.
import { describe, expect, it } from "vitest";
import { GUEST_TEST_CLOCK_ID } from "@cuadrilla/shared";
import { createLogger } from "../lib/log";
import { createMemoryConnector } from "../connector/memory/index";
import type { QaActionName, QaResponse } from "./contract";
import { type ActionHandlers, createQaDriver } from "./driver";
import { type GuardLookups, type Scope, checkFence } from "./guard";
import { memoryDriver, memoryQaPorts } from "./testing";

const QA = "qa-812-1-sc-01";
const OTHER_QA = "qa-812-1-sc-02";
const EVAL = "eval-812-1-q";
const KEY = "812-1/sc-01/3";

interface Rows {
  readonly kinds?: Record<string, "QA" | "EVAL" | "GUEST" | "DEMO">;
  readonly orders?: Record<string, string>;
  readonly people?: Record<string, string>;
}

function lookups(rows: Rows = {}): GuardLookups {
  return {
    ispKindOf: async (ispId) => rows.kinds?.[ispId],
    clockOfWorkOrder: async (id) => rows.orders?.[id],
    clockOfPerson: async (id) => rows.people?.[id],
    clockOfCase: async () => undefined,
    clockOfTimer: async () => undefined,
    procedureKind: (procedure) => (procedure.endsWith(".list") || procedure === "account.session" || procedure === "brand.get" ? "query" : "mutation"),
  };
}

/** A driver whose handlers only record what reached them. */
function recordingDriver(rows: Rows = {}) {
  const ran: Array<{ action: string; input: unknown }> = [];
  const handlers = new Proxy({} as Record<string, unknown>, {
    get: (_target, action: string) => async (input: unknown) => {
      ran.push({ action, input });
      return { ran: action, at: ran.length };
    },
  }) as unknown as ActionHandlers;
  const data = createMemoryConnector().connector;
  const driver = createQaDriver({ data, lookups: lookups(rows), handlers, now: () => new Date("2026-10-13T15:00:00Z"), sleep: async () => undefined, loggerFor: () => createLogger({ sink: () => undefined }) });
  return { driver, ran, call: (action: QaActionName, input: unknown, key = KEY): Promise<QaResponse> => driver({ action, idempotencyKey: key, input }) };
}

const refused = (response: QaResponse) => (response.ok ? undefined : response.error);

describe("the fence by world", () => {
  const scope = (name: string, clockId: string | undefined, extra: Partial<Scope> = {}): Scope => ({ name, family: "WORLD", ...(clockId === undefined ? {} : { clockId }), mutating: true, ...extra });

  it("lets every action act on a qa-* world, and a closed list on an eval-* world", () => {
    for (const name of ["clock.advance", "case.open", "kill.set", "wa.inbound", "tool.invoke"]) expect(() => checkFence(scope(name, QA), "QA")).not.toThrow();
    for (const name of ["world.create", "world.destroy", "eval.runQuestions", "eval.runPhotos", "tool.invoke", "snapshot", "installer.settle", "world.settle", "metrics.get"]) expect(() => checkFence(scope(name, EVAL), "EVAL")).not.toThrow();
    for (const name of ["clock.advance", "case.open", "kill.set", "wa.inbound", "network.setFaults"]) expect(() => checkFence(scope(name, EVAL), "EVAL"), name).toThrow(/not allowed on an evaluation world/);
  });

  it("never touches the demo world or a guest's world, and refuses a QA clock whose stored operator is not of QA type", () => {
    for (const clockId of ["GLOBAL#isp-demo", "GUEST#isp-guest-07", "GUEST#isp-guest-s261001abcde"]) expect(() => checkFence(scope("snapshot", clockId, { mutating: false }), undefined)).toThrow(/never acts|closed list/);
    expect(() => checkFence(scope("clock.advance", QA), "DEMO")).toThrow(/not of type QA or EVAL/);
    expect(() => checkFence(scope("snapshot", QA, { mutating: false }), undefined)).not.toThrow();
  });

  it("keeps GUEST#isp-guest-test to its closed list: the GUEST principal on its procedures, world.create/destroy, reads and settles", () => {
    const guestConsole = (procedure: string, role = "GUEST") => scope(`console.${procedure}`, GUEST_TEST_CLOCK_ID, { console: { procedure, role } });
    for (const procedure of ["tour.run", "clock.jumpToScene", "clock.reset", "simulator.sendText", "orders.list", "cases.take", "evidence.queue", "metrics.summary", "account.session", "manual.section"]) {
      expect(() => checkFence(guestConsole(procedure), "GUEST"), procedure).not.toThrow();
    }
    for (const procedure of ["people.upsert", "audit.list", "outbox.list", "account.deleteGuest"]) expect(() => checkFence(guestConsole(procedure), "GUEST"), procedure).toThrow(/closed list/);
    expect(() => checkFence(guestConsole("tour.run", "SUPERVISOR"), "GUEST")).toThrow(/only the GUEST principal/);
    for (const name of ["world.create", "world.destroy", "snapshot", "installer.settle", "world.settle"]) expect(() => checkFence(scope(name, GUEST_TEST_CLOCK_ID), "GUEST")).not.toThrow();
    for (const name of ["clock.advance", "case.open", "kill.set", "wa.inbound", "tool.invoke", "memory.inspect"]) expect(() => checkFence(scope(name, GUEST_TEST_CLOCK_ID), "GUEST"), name).toThrow(/closed list/);
  });

  it("refuses world.create of the test guest's world with anything but {template: guest}", async () => {
    const { call, ran } = recordingDriver();
    expect(refused(await call("world.create", { clockId: GUEST_TEST_CLOCK_ID, template: "guest" }))).toBeUndefined();
    expect(refused(await call("world.create", { clockId: GUEST_TEST_CLOCK_ID, operations: [] }, "812-1/sc-19/1/m2"))).toMatchObject({ code: "FORBIDDEN", reason: "QA_FENCE" });
    expect(ran).toHaveLength(1);
  });

  it("resolves every id to its own world: an order of another world, or of the demo, is FORBIDDEN whatever clock the input names", async () => {
    const { call, ran } = recordingDriver({ kinds: { [`isp-${QA}`]: "QA" }, orders: { "wo-70001": QA, "wo-70002": OTHER_QA, "wo-24817": "GLOBAL#isp-demo" }, people: { [`inst-${QA}-a`]: QA } });
    expect(refused(await call("network.fix", { workOrderId: "wo-70001", kind: "INSTALLER_STEP" }))).toBeUndefined();
    expect(refused(await call("snapshot", { clockId: QA, workOrderIds: ["wo-70002"] }))).toMatchObject({ code: "FORBIDDEN", reason: "QA_FENCE" });
    expect(refused(await call("case.open", { workOrderId: "wo-24817", reason: "OTHER" }, "812-1/sc-01/4"))).toMatchObject({ code: "FORBIDDEN" });
    expect(refused(await call("installer.settle", { installerId: "inst-rogelio" }, "812-1/sc-01/5"))).toMatchObject({ code: "NOT_FOUND" });
    expect(ran.map((entry) => entry.action)).toEqual(["network.fix"]);
  });

  it("parses every input strictly before reading anything", async () => {
    const { call, ran } = recordingDriver({ kinds: { [`isp-${QA}`]: "QA" } });
    expect(refused(await call("clock.advance", { clockId: QA, minutes: 10, force: true }))).toMatchObject({ code: "INVALID", reason: "VALIDATION" });
    expect(refused(await call("kill.set", { clockId: QA, scope: "ALL", on: true }))).toMatchObject({ code: "INVALID" });
    expect(refused(await call("clock.advance", { clockId: "GLOBAL#isp-demo", minutes: 10 }))).toMatchObject({ code: "FORBIDDEN" });
    expect(ran).toEqual([]);
  });
});

describe("idempotency by key (docs/test-plan.md §4.4)", () => {
  it("replays a changing action under the same key instead of running it again, and never caches a read", async () => {
    const { call, ran } = recordingDriver({ kinds: { [`isp-${QA}`]: "QA" } });
    const first = await call("clock.advance", { clockId: QA, minutes: 10 });
    const again = await call("clock.advance", { clockId: QA, minutes: 10 });
    expect(first).toMatchObject({ ok: true, replayed: false, result: { ran: "clock.advance", at: 1 } });
    expect(again).toMatchObject({ ok: true, replayed: true, result: { ran: "clock.advance", at: 1 } });
    await call("snapshot", { clockId: QA }, "812-1/sc-01/3/r1");
    await call("snapshot", { clockId: QA }, "812-1/sc-01/3/r1");
    expect(ran.map((entry) => entry.action)).toEqual(["clock.advance", "snapshot", "snapshot"]);
  });

  it("refuses the same key with another action or input, and runs nothing", async () => {
    const { call, ran } = recordingDriver({ kinds: { [`isp-${QA}`]: "QA" } });
    await call("clock.advance", { clockId: QA, minutes: 10 });
    expect(refused(await call("clock.advance", { clockId: QA, minutes: 20 }))).toMatchObject({ code: "CONFLICT", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(refused(await call("clock.advanceToNext", { clockId: QA }))).toMatchObject({ code: "CONFLICT", reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(ran).toHaveLength(1);
  });

  it("refuses a key that is not <runId>/<scenario>/<step>", async () => {
    const { driver } = recordingDriver();
    for (const key of ["sc-01/3", "812-1/sc-1/3", "812-1/sc-01/3/UPPER", "local-1/sc-01/3"]) expect(refused(await driver({ action: "snapshot", idempotencyKey: key, input: { clockId: QA } }))).toMatchObject({ code: "INVALID" });
  });
});

describe("the QA seam of the own sign-up (ADR-0025 §7)", () => {
  const USER = "gst-01K80000000000000000000001";
  const QA_EMAIL = "success+qa-812-1-1@simulator.amazonses.com";

  it("[FL-105] refuses a QA address in the input when the address Cognito holds is a real one: nothing confirmed, signed in or deleted", async () => {
    const memory = memoryQaPorts();
    memory.cognito.users.set(USER, { username: USER, status: "UNCONFIRMED", email: "persona.real@example.com", emailVerified: false });
    const driver = memoryDriver(memory);
    const at = (step: string) => `812-1/sc-20/${step}`;
    const signUp = await driver({ action: "auth.signUp", idempotencyKey: at("2"), input: { username: USER, email: QA_EMAIL, ticket: "t" } });
    expect(refused(signUp)).toMatchObject({ code: "FORBIDDEN", reason: "NOT_A_QA_ADDRESS" });
    for (const action of ["auth.confirmQaSignup", "auth.qaLogin", "auth.cleanupQaSignup", "guest.forceExpire", "leads.get"] as const) {
      expect(refused(await driver({ action, idempotencyKey: at(`3/${action.replace(/\W/g, "-").toLowerCase()}`), input: { username: USER } })), action).toMatchObject({ code: "FORBIDDEN", reason: "NOT_A_QA_ADDRESS" });
    }
    expect(memory.cognito.confirmed).toEqual([]);
    expect(memory.cognito.signIns).toEqual([]);
    expect(memory.deletions).toEqual([]);
  });

  it("[FL-105] confirms and cleans up only a user whose address in Cognito is a QA address", async () => {
    const memory = memoryQaPorts();
    memory.cognito.users.set(USER, { username: USER, status: "UNCONFIRMED", email: QA_EMAIL, emailVerified: false });
    const driver = memoryDriver(memory);
    expect(await driver({ action: "auth.confirmQaSignup", idempotencyKey: "812-1/sc-20/3", input: { username: USER } })).toMatchObject({ ok: true, result: { previousStatus: "UNCONFIRMED", status: "CONFIRMED" } });
    expect(await driver({ action: "auth.cleanupQaSignup", idempotencyKey: "812-1/sc-20/9", input: { username: USER } })).toMatchObject({ ok: true, result: { outcome: "DELETED" } });
    expect(memory.cognito.confirmed).toEqual([USER]);
    expect(memory.deletions).toEqual(["usr-g01K80000000000000000000001"]);
  });

  it("[FL-104] answers the pre sign-up's refusal of a SignUp without its ticket, and never accepts a non-QA address in the input", async () => {
    const memory = memoryQaPorts();
    const driver = memoryDriver(memory);
    expect(await driver({ action: "auth.signUp", idempotencyKey: "812-1/sc-20/2/m2", input: { username: USER, email: QA_EMAIL, omitTicket: true } })).toMatchObject({ ok: true, result: { outcome: "REFUSED", reason: "TICKET_INVALID", userExists: false } });
    expect(refused(await driver({ action: "auth.signUp", idempotencyKey: "812-1/sc-20/2/m3", input: { username: USER, email: "persona.real@example.com", ticket: "t" } }))).toMatchObject({ code: "INVALID" });
    expect(memory.cognito.signUps).toHaveLength(1);
  });
});
