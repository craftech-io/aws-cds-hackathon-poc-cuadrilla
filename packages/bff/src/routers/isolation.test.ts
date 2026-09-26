import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import { AUTH_REASON, AuthError } from "../auth/errors";
import { type TestContextDeps, createTestIssuer, functionUrlEvent, testContextDeps, testLambdaContext, trpcResponse } from "../auth/testing";
import { createMemoryConnector, type Connector } from "../connector/index";
import { HASH_A, HASH_B, installer, openCase, workOrder } from "../connector/testing";
import { createHandler } from "./handler";
import { createQaCaller } from "./index";
import { type ServerCallOptions, createCallerFactory, createContextFactory, createServerContext, ispProcedure, recentLoginProcedure, router, supervisorProcedure } from "./trpc";

// Worlds of the fixture: the demo, two guests and one QA scenario, each with its own order.
const G03 = { ispId: "isp-guest-03", clockId: "GUEST#isp-guest-03" };
const G07 = { ispId: "isp-guest-07", clockId: "GUEST#isp-guest-07" };
const QA = { ispId: "isp-qa-812-1-sc-13", clockId: "qa-812-1-sc-13" };
const SUB = { adriana: "sub-adriana-0001", guest07: "sub-guest07-0001" };
const CASE_G03 = "case-01J9ZQX0000000000000000003";

const byId = z.object({ id: z.string() });
const testRouter = router({
  orders: router({
    get: ispProcedure.input(z.object({ workOrderId: z.string() })).query(async ({ ctx, input }) => {
      const order = await ctx.deps.connector.workOrders.getWorkOrder(input.workOrderId);
      if (order === undefined) throw new ToolError("NOT_FOUND", "no such order");
      return { workOrderId: order.workOrderId, world: ctx.world.clockId };
    }),
    bulk: ispProcedure.input(z.object({ filter: z.object({ items: z.array(z.object({ workOrderId: z.string() })) }) })).query(({ input }) => input.filter.items.length),
  }),
  cases: router({ get: ispProcedure.input(z.object({ caseId: z.string() })).query(({ input }) => input.caseId) }),
  people: router({ get: ispProcedure.input(byId).query(({ input }) => input.id) }),
  scope: router({
    world: ispProcedure.input(z.object({ clockId: z.string() })).query(({ input }) => input.clockId),
    operator: ispProcedure.input(z.object({ ispId: z.string() })).query(({ input }) => input.ispId),
    free: ispProcedure.input(z.unknown()).query(() => "ok"),
  }),
  evidence: router({ override: recentLoginProcedure.input(z.object({ workOrderId: z.string() })).mutation(() => "OVERRIDDEN") }),
  clock: router({ reset: supervisorProcedure.mutation(({ ctx }) => ctx.world.clockId) }),
});
const createTestCaller = createCallerFactory(testRouter);

async function seed(data: Connector): Promise<void> {
  await data.isps.putUser({ ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR", name: "Adriana Solís", cognitoSub: SUB.adriana });
  await data.isps.putUser({ ispId: G07.ispId, userId: "usr-guest-07", role: "GUEST", name: "Invitado 07", cognitoSub: SUB.guest07 });
  await data.workOrders.createWorkOrder(workOrder());
  await data.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24817-g03", ...G03 }));
  await data.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-24817-g07", ...G07 }));
  await data.workOrders.createWorkOrder(workOrder({ workOrderId: "wo-70001", workOrderNumber: "70001", ...QA }));
  await data.cases.createCase(openCase({ caseId: CASE_G03, workOrderId: "wo-24817-g03", ...G03 }));
  await data.people.createPerson(installer({ personId: "inst-rogelio-g03", phoneHash: HASH_B, ...G03 }));
  await data.people.createPerson(installer({ phoneHash: HASH_A }));
  await data.people.putCustomer({ customerId: "cust-10421-g03", ...G03, firstName: "Lucía", lastName: "Ficticia", addressLine: "Calle 1", neighborhood: "Centro", email: "success+g03-c10421@simulator.amazonses.com" });
  await data.runtime.createClock({ clockId: G07.clockId, ispId: G07.ispId, kind: "GUEST", mode: "PAUSED", offsetMs: 0, pausedSimNow: "2026-10-13T09:20:00-06:00", worldEpoch: 1 });
}

const issuer = createTestIssuer();
const tokens = {
  adriana: () => issuer.idToken({ sub: SUB.adriana, ispId: "isp-demo", userId: "usr-adriana", role: "SUPERVISOR" }),
  guest07: (extra: Record<string, unknown> = {}) =>
    issuer.idToken({ sub: SUB.guest07, ispId: G07.ispId, userId: "usr-guest-07", role: "GUEST", isGuest: "true", "cognito:groups": ["GUEST"], ...extra }),
};

async function reasonOf(call: Promise<unknown>): Promise<{ code: string; reason: string | undefined }> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    const cause = error.cause;
    return { code: error.code, reason: cause instanceof AuthError ? cause.reason : cause instanceof ToolError ? (cause.reason ?? cause.code) : undefined };
  }
  throw new Error("expected the call to be refused");
}

describe("cross-operator fence of the console [FL-081]", () => {
  let data: Connector;
  let deps: TestContextDeps;
  const asUser = async (token: string) => createTestCaller(await createContextFactory(() => deps)({ event: { headers: { authorization: `Bearer ${token}` } } }));
  const denials = (ispId: string) => data.audit.listByDecision(ispId, "DENY");

  beforeEach(async () => {
    data = createMemoryConnector().connector;
    deps = testContextDeps(issuer, { connector: data });
    await seed(data);
  });

  it("[FL-081] lets a guest read its own world", async () => {
    expect(await (await asUser(tokens.guest07())).orders.get({ workOrderId: "wo-24817-g07" })).toEqual({ workOrderId: "wo-24817-g07", world: G07.clockId });
    expect(await (await asUser(tokens.guest07())).scope.world({ clockId: G07.clockId })).toBe(G07.clockId);
  });

  it("[FL-081] refuses a guest an order of another guest with 403 and AuditLog DENY CROSS_ISP in its own operator", async () => {
    const caller = await asUser(tokens.guest07());
    expect(await reasonOf(caller.orders.get({ workOrderId: "wo-24817-g03" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_ISP });
    const [row, ...rest] = await denials(G07.ispId);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      ispId: G07.ispId,
      clockId: G07.clockId,
      decision: "DENY",
      action: "CROSS_ISP",
      actor: "USER:usr-guest-07",
      // The world's simulated time, 09:20 in Mexico City.
      atSim: "2026-10-13T15:20:00.000Z",
      refs: { procedure: "orders.get" },
      detail: { targetKind: "workOrder", field: "workOrderId", requestedId: "wo-24817-g03" },
    });
    expect(await denials(G03.ispId)).toEqual([]);
    expect(deps.lines.some((line) => line.includes("console.auth.refused") && line.includes("CROSS_ISP"))).toBe(true);
  });

  it("[FL-081] a guest never reaches the demo, another guest's world, operator, case, installer or customer", async () => {
    const caller = await asUser(tokens.guest07());
    const refused = [
      caller.orders.get({ workOrderId: "wo-24817" }),
      caller.scope.world({ clockId: G03.clockId }),
      caller.scope.world({ clockId: "GLOBAL#isp-demo" }),
      caller.scope.operator({ ispId: G03.ispId }),
      caller.cases.get({ caseId: CASE_G03 }),
      caller.people.get({ id: "inst-rogelio-g03" }),
      caller.people.get({ id: "cust-10421-g03" }),
      caller.orders.bulk({ filter: { items: [{ workOrderId: "wo-24817-g07" }, { workOrderId: "wo-24817-g03" }] } }),
      caller.scope.free({ note: "see", nested: [{ deeper: { ref: "GUEST#isp-guest-03" } }] }),
    ];
    for (const call of refused) expect(await reasonOf(call)).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_ISP });
    const kinds = (await denials(G07.ispId)).map((row) => row.detail?.targetKind);
    expect(kinds.sort()).toEqual(["case", "clock", "clock", "clock", "customer", "installer", "isp", "workOrder", "workOrder"]);
  });

  it("[FL-081] refuses the demo's supervisor a guest's order, and audits it without the world's time when the world has no clock", async () => {
    const caller = await asUser(tokens.adriana());
    expect(await caller.orders.get({ workOrderId: "wo-24817" })).toEqual({ workOrderId: "wo-24817", world: "GLOBAL#isp-demo" });
    expect(await reasonOf(caller.orders.get({ workOrderId: "wo-24817-g07" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_ISP });
    const [row] = await denials("isp-demo");
    expect(row).toMatchObject({ actor: "USER:usr-adriana", clockId: "GLOBAL#isp-demo" });
    expect(row?.atSim).toBeUndefined();
  });

  it("[FL-081] lets an unknown id through to the procedure's own NOT_FOUND, without an audit row", async () => {
    const caller = await asUser(tokens.guest07());
    expect(await reasonOf(caller.orders.get({ workOrderId: "wo-24899-g07" }))).toEqual({ code: "NOT_FOUND", reason: "NOT_FOUND" });
    expect(await caller.scope.free({ text: "ids of nothing: wo-24817 and inst-rogelio", zone: "zone-norte", evidenceIds: ["ev-01J9ZQX0000000000000000000"] })).toBe("ok");
    expect(await denials(G07.ispId)).toEqual([]);
  });

  it("[FL-081] a custom:ispId the user changed does not change the operator", async () => {
    const caller = await asUser(tokens.guest07({ "custom:ispId": G03.ispId }));
    expect((await caller.orders.get({ workOrderId: "wo-24817-g07" })).world).toBe(G07.clockId);
    expect(await reasonOf(caller.orders.get({ workOrderId: "wo-24817-g03" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_ISP });
  });

  it("[FL-081] checks the registry on every request: deactivated, moved or replaced users are refused", async () => {
    await data.isps.setUserActive(G07.ispId, "usr-guest-07", false);
    expect(await reasonOf((await asUser(tokens.guest07())).orders.get({ workOrderId: "wo-24817-g07" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.USER_INACTIVE });
    // A token stamped before the user moved to another operator names an operator the registry no longer has.
    const moved = await asUser(issuer.idToken({ sub: SUB.adriana, ispId: G03.ispId, userId: "usr-adriana", role: "GUEST", isGuest: "true" }));
    expect(await reasonOf(moved.orders.get({ workOrderId: "wo-24817-g03" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.USER_INACTIVE });
    const replaced = await asUser(issuer.idToken({ sub: SUB.adriana, ispId: "isp-demo", userId: "usr-other", role: "SUPERVISOR" }));
    expect(await reasonOf(replaced.orders.get({ workOrderId: "wo-24817" }))).toEqual({ code: "UNAUTHORIZED", reason: AUTH_REASON.PRINCIPAL_INCOMPLETE });
  });

  it("[FL-081] fails closed: an unreadable owner is 503; an audit that cannot be written does not lift the 403", async () => {
    const broken = { ...data, workOrders: { ...data.workOrders, getWorkOrder: () => Promise.reject(new Error("table unavailable")) } };
    deps = testContextDeps(issuer, { connector: broken });
    expect(await reasonOf((await asUser(tokens.guest07())).orders.get({ workOrderId: "wo-24817-g03" }))).toEqual({ code: "SERVICE_UNAVAILABLE", reason: AUTH_REASON.AUTH_UNAVAILABLE });
    const noAudit = { ...data, audit: { ...data.audit, append: () => Promise.reject(new Error("audit unavailable")) } };
    deps = testContextDeps(issuer, { connector: noAudit });
    expect(await reasonOf((await asUser(tokens.guest07())).orders.get({ workOrderId: "wo-24817-g03" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_ISP });
    expect(deps.lines.some((line) => line.includes("console.audit.failed"))).toBe(true);
  });

  it("[FL-081] refuses an input too large to fence as a bad request", async () => {
    const deep = Array.from({ length: 12 }).reduce<unknown>((inner) => ({ inner }), "wo-24817-g03");
    expect(await reasonOf((await asUser(tokens.guest07())).scope.free(deep))).toEqual({ code: "BAD_REQUEST", reason: "INPUT_TOO_LARGE" });
  });

  it("[FL-081] answers 403 with the reason through the Lambda handler", async () => {
    const handler = createHandler(testRouter, createContextFactory(() => deps));
    const query = `input=${encodeURIComponent(JSON.stringify({ workOrderId: "wo-24817-g03" }))}`;
    const event = functionUrlEvent("/api/orders.get", { query, requestId: "req-isolation-0001", headers: { authorization: `Bearer ${tokens.guest07()}` } });
    const response = trpcResponse(await handler(event, testLambdaContext));
    expect(response.status).toBe(403);
    expect(response.body.error?.data).toMatchObject({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_ISP, correlationId: "req-isolation-0001" });
    // Nothing of the other operator travels back, not even the id that was asked for.
    expect(JSON.stringify(response.body)).not.toContain("wo-24817-g03");
  });
});

describe("QaDriver principals bound to a world [FL-081]", () => {
  let data: Connector;
  let deps: TestContextDeps;
  const asQa = (options: ServerCallOptions) => createTestCaller(createServerContext(options, deps));

  beforeEach(async () => {
    data = createMemoryConnector().connector;
    deps = testContextDeps(issuer, { connector: data });
    await seed(data);
  });

  it("[FL-081] a QA supervisor reads its own scenario and is fenced out of the demo like anyone else", async () => {
    const supervisor = asQa({ role: "SUPERVISOR", clockId: QA.clockId });
    expect(await supervisor.orders.get({ workOrderId: "wo-70001" })).toEqual({ workOrderId: "wo-70001", world: QA.clockId });
    expect(await reasonOf(supervisor.orders.get({ workOrderId: "wo-24817" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_ISP });
    expect(await data.audit.listByDecision(QA.ispId, "DENY")).toEqual([expect.objectContaining({ actor: "USER:usr-qa-sup", clockId: QA.clockId })]);
  });

  it("[FL-081] runs the role and recent-login middlewares for real (SC-13/2)", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await asQa({ role: "SUPERVISOR", clockId: QA.clockId }).evidence.override({ workOrderId: "wo-70001" })).toBe("OVERRIDDEN");
    expect(await reasonOf(asQa({ role: "OPS", clockId: QA.clockId }).evidence.override({ workOrderId: "wo-70001" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.ROLE_NOT_ALLOWED });
    expect(await reasonOf(asQa({ role: "SUPERVISOR", clockId: QA.clockId, authTime: now - 20 * 60 }).evidence.override({ workOrderId: "wo-70001" }))).toEqual({
      code: "FORBIDDEN",
      reason: AUTH_REASON.LOGIN_NOT_RECENT,
    });
  });

  it("[FL-081] the GUEST principal acts only on isp-guest-test, as a supervisor of that world", async () => {
    const guest = asQa({ role: "GUEST", clockId: "GUEST#isp-guest-test", sessionId: "A" });
    expect(await guest.clock.reset()).toBe("GUEST#isp-guest-test");
    expect(await reasonOf(guest.orders.get({ workOrderId: "wo-24817-g07" }))).toEqual({ code: "FORBIDDEN", reason: AUTH_REASON.CROSS_ISP });
    expect(() => asQa({ role: "GUEST", clockId: G07.clockId })).toThrowError(expect.objectContaining({ reason: AUTH_REASON.ROLE_NOT_ALLOWED }));
    expect(() => asQa({ role: "SUPERVISOR", clockId: "GLOBAL#isp-demo" })).toThrowError(expect.objectContaining({ reason: AUTH_REASON.ROLE_NOT_ALLOWED }));
  });

  it("[FL-081] createQaCaller runs the real console router", async () => {
    const caller = createQaCaller({ role: "OPS", clockId: QA.clockId }, deps);
    expect(await caller.health.ping()).toEqual({ ok: true, service: "bff", mocks: { network: "OK", dispatch: "OK" } });
  });
});
