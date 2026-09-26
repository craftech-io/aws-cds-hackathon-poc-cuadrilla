import { beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "@cuadrilla/shared";
import { CASE_1, CASE_2, CLOCK, ISP, QA_CLOCK, QA_ISP, openCase, workOrder } from "../../connector/testing";
import { createLogger } from "../../lib/log";
import { type SessionRecord, resolveSession } from "../../services/session/session";
import type { ToolIdentity } from "./context";
import type { DenialContext } from "./denials";
import { principalScope } from "./invocation";
import { authorizeCase, authorizeWorkOrder, authorizeWorkOrders, requireActiveWorkOrder, scopeWithSubject, sessionDay } from "./scope";
import { TEST_SESSION_KEY, TURN_ID, type ToolTestKit, seedDay, toolTestKit } from "./testing";

let kit: ToolTestKit;

beforeEach(async () => {
  kit = toolTestKit();
  await seedDay(kit);
});

function contextOf(identity: ToolIdentity): DenialContext {
  return { tool: "get_work_order", identity, scope: principalScope(identity), actor: identity.kind === "HARNESS" ? "AGENT" : identity.kind, deps: kit.runtime, logger: createLogger({ level: "error", sink: () => undefined }) };
}

async function harness(overrides: Partial<Omit<SessionRecord, "sessionId">> = {}): Promise<DenialContext> {
  const token = await kit.openSession(overrides);
  return contextOf({ kind: "HARNESS", session: await resolveSession(TEST_SESSION_KEY, token, kit.memory.connector.runtime, kit.memory.now().getTime()) });
}

function channel(ispId = ISP, clockId = CLOCK): DenialContext {
  return contextOf({ kind: "CHANNEL", caller: { kind: "CHANNEL", ispId, clockId, eventId: "evt-0001" } });
}

async function refusal(promise: Promise<unknown>): Promise<[string, string | undefined]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolError) return [error.code, error.reason];
    throw error;
  }
  throw new Error("expected a refusal");
}

async function scopeDenials(ispId = ISP) {
  return (await kit.memory.connector.audit.listByDecision(ispId, "DENY")).map((row) => ({ ruleIds: row.ruleIds, refs: row.refs, detail: row.detail }));
}

const FORBIDDEN: [string, string] = ["FORBIDDEN", "WORK_ORDER_NOT_IN_SESSION"];

describe("[FL-025] LAM-SCOPE for the Harness: only the installer's own orders of the session's day", () => {
  it("resolves an order of the installer's day by number or by id", async () => {
    const ctx = await harness();
    expect((await authorizeWorkOrder(ctx, "24818")).workOrderId).toBe("wo-24818");
    expect((await authorizeWorkOrder(ctx, "wo-24817")).workOrderNumber).toBe("24817");
    expect((await requireActiveWorkOrder(ctx)).workOrderId).toBe("wo-24817");
    expect((await authorizeWorkOrders(ctx, ["24818", "wo-24817", "24818"])).map((order) => order.workOrderId)).toEqual(["wo-24818", "wo-24817"]);
  });

  it("refuses another installer's order, another day's and an unknown number alike, with AuditLog DENY LAM-SCOPE", async () => {
    const ctx = await harness();
    for (const ref of ["24819", "wo-24819", "24820", "24899"]) expect(await refusal(authorizeWorkOrder(ctx, ref)), ref).toEqual(FORBIDDEN);
    const rows = await scopeDenials();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ ruleIds: ["LAM-SCOPE"], refs: { tool: "get_work_order", turnId: TURN_ID, workOrderId: "wo-24817" }, detail: { requestedRef: "24819" } });
    await expect(authorizeWorkOrders(ctx, ["24817", "24819"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await refusal(authorizeWorkOrder(ctx, "orden 24817"))).toEqual(["INVALID", undefined]);
  });

  it("refuses an order of the same installer id in another world", async () => {
    await kit.memory.connector.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-70001", workOrderNumber: "70001", ispId: QA_ISP, clockId: QA_CLOCK }));
    expect(await refusal(authorizeWorkOrder(await harness(), "70001"))).toEqual(FORBIDDEN);
  });

  it("reads the day in the operator's zone", async () => {
    const ctx = await harness({ eventAtSim: "2026-10-14T00:30:00-06:00" });
    expect(await sessionDay(ctx)).toBe("2026-10-14");
    const isps = { ...kit.runtime.connector.isps, getSettings: async () => ({ timezone: "America/Tijuana" }) } as unknown as typeof kit.runtime.connector.isps;
    const tijuana: DenialContext = { ...ctx, deps: { ...ctx.deps, connector: { ...ctx.deps.connector, isps } } };
    expect(await sessionDay(tijuana)).toBe("2026-10-13");
    expect((await authorizeWorkOrder(tijuana, "24817")).workOrderId).toBe("wo-24817");
  });

  it("answers NOT_FOUND when the turn has no active order", async () => {
    const ctx = await harness({ workOrderId: undefined });
    expect(await refusal(requireActiveWorkOrder(ctx))).toEqual(["NOT_FOUND", "NO_ACTIVE_WORK_ORDER"]);
  });
});

describe("[FL-015] a reassigned order stops being reachable", () => {
  it("refuses the order after the dispatch moves it to another installer, also as the active one", async () => {
    const ctx = await harness({ workOrderId: "wo-24818" });
    expect((await requireActiveWorkOrder(ctx)).installerId).toBe("inst-rogelio");
    await kit.memory.connector.workOrders.updateWorkOrder("wo-24818", { installerId: "inst-karina" });
    expect(await refusal(requireActiveWorkOrder(ctx))).toEqual(FORBIDDEN);
    expect(await refusal(authorizeWorkOrder(ctx, "24818"))).toEqual(FORBIDDEN);
  });
});

describe("cases named by the model", () => {
  it("accepts a case of an order in scope and refuses any other", async () => {
    await kit.memory.connector.cases.createCase(openCase({ workOrderId: "wo-24818" }));
    await kit.memory.connector.cases.createCase(openCase({ caseId: CASE_2, workOrderId: "wo-24819", installerId: "inst-karina" }));
    const ctx = await harness();
    expect((await authorizeCase(ctx, CASE_1)).workOrderId).toBe("wo-24818");
    expect(await refusal(authorizeCase(ctx, CASE_2))).toEqual(FORBIDDEN);
    expect(await refusal(authorizeCase(ctx, "case-01J9ZQX0000000000000000009"))).toEqual(FORBIDDEN);
    expect(await refusal(authorizeCase(channel(), "case-01J9ZQX0000000000000000009"))).toEqual(["NOT_FOUND", undefined]);
    expect((await scopeDenials()).map((row) => row.detail)).toEqual([{ requestedRef: "wo-24819" }, { requestedCaseId: "case-01J9ZQX0000000000000000009" }]);
  });
});

describe("direct callers: their operator, their world and their verified subject", () => {
  it("resolve orders of their world by id only", async () => {
    const ctx = channel();
    expect((await authorizeWorkOrder(ctx, "wo-24819")).installerId).toBe("inst-karina");
    expect(await refusal(authorizeWorkOrder(ctx, "24819"))).toEqual(["INVALID", undefined]);
    expect(await refusal(authorizeWorkOrder(ctx, "wo-24898"))).toEqual(["NOT_FOUND", undefined]);
    expect(await refusal(authorizeWorkOrder(channel(QA_ISP, QA_CLOCK), "wo-24817"))).toEqual(FORBIDDEN);
    expect(await scopeDenials(QA_ISP)).toHaveLength(1);
  });

  it("scope a subject to its installer and order, refusing mismatches", async () => {
    const ctx = channel();
    expect(await scopeWithSubject(ctx, { workOrderId: "wo-24817" })).toEqual({ ispId: ISP, clockId: CLOCK, eventId: "evt-0001", installerId: "inst-rogelio", workOrderId: "wo-24817" });
    expect(await scopeWithSubject(ctx, { installerId: "inst-karina" })).toEqual({ ispId: ISP, clockId: CLOCK, eventId: "evt-0001", installerId: "inst-karina" });
    expect(await scopeWithSubject(ctx, undefined)).toEqual(ctx.scope);
    expect(await refusal(scopeWithSubject(ctx, { installerId: "inst-karina", workOrderId: "wo-24817" }))).toEqual(FORBIDDEN);
    expect(await refusal(scopeWithSubject(ctx, { installerId: "inst-nadie" }))).toEqual(["NOT_FOUND", undefined]);
    expect(await refusal(scopeWithSubject(channel(QA_ISP, QA_CLOCK), { installerId: "inst-rogelio" }))).toEqual(FORBIDDEN);
  });
});
