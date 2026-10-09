// SC-09 · plan B of unapproved templates (docs/test-plan.md §4.5; FL-016, FL-054, FL-074, FL-075): the
// supervisor on duty registers the shift with "TURNO" and gets the case as an interactive message inside
// that window; the backup without "TURNO" is skipped (`NO_CHANNEL`) and the zone chief alerted; the day's
// template denied and the installer's "ÓRDENES" as the way out; and the same path with the templates PENDING.
import { DAY, at, decided, orderIn, personIn, say, settledOn, settledWorld } from "./lib/assist";
import { CREW_N3, caseIn, caseOn, caseSnapshot } from "./lib/cases";
import { type ScenarioContext, ensure } from "./lib/context";
import { agentReplies, outOf, refList } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, staff, stored } from "./lib/world";

const PLAN_B = ["caso_escalado", "caso_reasignado", "ordenes_del_dia"] as const;
const statusOf = (status: "REJECTED" | "PENDING") => Object.fromEntries(PLAN_B.map((name) => [name, status]));
const world = (ctx: ScenarioContext) => stored<World>(ctx, "world");

export default defineScenario({
  id: "SC-09",
  slug: "sc-09",
  title: "Plan B of unapproved templates",
  suites: ["full"],
  async setup(ctx) {
    const operations = [{ key: "k", model: "wo-24818", installer: "own" as const, preset: { activeWorkOrderId: true } }];
    ctx.state.world = await createWorld(ctx, { startAtSim: at(DAY, "07:05"), settings: { demoMode: false, templateStatus: statusOf("REJECTED") }, operations });
    ctx.state.pending = await createWorld(ctx, { startAtSim: at(DAY, "07:05"), settings: { demoMode: false, templateStatus: statusOf("PENDING") }, operations }, "pending");
  },
  steps: [
    {
      id: "1",
      title: "The supervisor on duty sends \"TURNO\" → the confirmation and the shift window",
      kind: "det",
      flows: ["FL-074"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const primary = staff(w, CREW_N3.primary);
        await say(ctx, w, primary, "TURNO");
        const snapshot = await settledWorld(ctx, w, [], [primary]);
        ctx.check(outOf(personIn(snapshot, primary).messages, { kind: "SYSTEM_NOTICE" }).length === 1, "no confirmation of the shift");
        ctx.check(decided(snapshot.decisions, "ACTION", undefined, "SHIFT_REGISTERED").length === 1, "no SHIFT_REGISTERED");
      },
    },
    {
      id: "2",
      title: "case.open → CASE_REQUEST interactive, DENY CP-TEMPLATE-APPROVED before",
      kind: "det",
      flows: ["FL-054", "FL-074"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const primary = staff(w, CREW_N3.primary);
        await ctx.qa("case.open", { workOrderId: op(w, "k").workOrderId, reason: "OTHER" });
        const opened = await caseOn(ctx, w, "k");
        const snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, [primary]);
        const requests = ctx.exactly(snapshot, 1, "CASE_REQUEST to the supervisor on duty", outOf(personIn(snapshot, primary).messages, { kind: "CASE_REQUEST" }));
        ctx.check(requests[0]?.content === "INTERACTIVE" && requests[0].templateName === undefined, `the request went as ${requests[0]?.content ?? "nothing"}`);
        const decisions = orderIn(snapshot, op(w, "k").workOrderId).decisions;
        const denied = decided(decisions, "DENY", "CP-TEMPLATE-APPROVED")[0];
        const allowed = decisions.find((entry) => entry.decision === "ALLOW" && entry.messageId === requests[0]?.messageId);
        ensure(denied !== undefined, "no DENY CP-TEMPLATE-APPROVED");
        ctx.check(allowed === undefined || denied.ts <= allowed.ts, "the template was denied after the interactive went out");
        ctx.state.caseId = opened.caseId;
      },
    },
    {
      id: "3",
      title: "The backup without \"TURNO\": SKIPPED NO_CHANNEL → the alert",
      kind: "det",
      flows: ["FL-075"],
      after: "2",
      async run(ctx) {
        const w = world(ctx);
        const caseId = stored<string>(ctx, "caseId");
        await ctx.qa("clock.advance", { clockId: w.clockId, minutes: 10 });
        const snapshot = await caseSnapshot(ctx, w, "k", caseId, []);
        const item = caseIn(snapshot, caseId);
        ctx.check(item.ladder.some((entry) => entry.rung === "SECONDARY" && entry.outcome === "SKIPPED" && (entry.reason ?? "").includes("NO_CHANNEL")), "the backup was not skipped with NO_CHANNEL");
        ctx.check(orderIn(snapshot, op(w, "k").workOrderId).emails.some((email) => email.kind === "ZONE_CHIEF_ALERT"), "no alert to the zone chief");
      },
    },
    {
      id: "4",
      title: "The day's template denied, and \"ÓRDENES\"",
      parts: [
        {
          part: "a",
          title: "DAY_START denied (CP-TEMPLATE-APPROVED), nothing sent",
          kind: "det",
          flows: ["FL-016"],
          after: "preset",
          async run(ctx) {
            const w = world(ctx);
            const k = op(w, "k");
            await ctx.qa("clock.advanceTo", { clockId: w.clockId, to: at(DAY, "07:30") });
            const snapshot = await settledWorld(ctx, w, [k.workOrderId], [k.installerId]);
            const dayStart = Date.parse(at(DAY, "07:30"));
            ctx.check(decided(snapshot.decisions, "DENY", "CP-TEMPLATE-APPROVED").some((entry) => Date.parse(entry.atSim ?? entry.ts) >= dayStart), "no DENY CP-TEMPLATE-APPROVED of the DAY_START");
            ctx.none(snapshot, "DAY_START sent", outOf(personIn(snapshot, k.installerId).messages, { kind: "DAY_START" }));
          },
        },
        {
          part: "b",
          title: "\"ÓRDENES\" → the detail of the day",
          kind: "agent",
          flows: ["FL-016"],
          after: "4.a",
          async run(ctx) {
            const w = world(ctx);
            const k = op(w, "k");
            await say(ctx, w, k.installerId, "ÓRDENES");
            const snapshot = await settledOn(ctx, w, k.installerId, [k.workOrderId]);
            const detail = agentReplies(personIn(snapshot, k.installerId).messages).at(-1);
            ensure(detail !== undefined, "no ORDERS_DETAIL nor REPLY");
            const number = orderIn(snapshot, k.workOrderId).order.workOrderNumber;
            ctx.check(refList(detail, "workOrderIds").includes(k.workOrderId) || (detail.text ?? "").includes(number), "the detail does not list the installer's order");
          },
        },
      ],
    },
    {
      id: "5",
      title: "The same path with the templates PENDING: the supervisors without a window are skipped (NO_CHANNEL)",
      kind: "det",
      flows: ["FL-075"],
      after: "preset",
      async run(ctx) {
        const w = stored<World>(ctx, "pending");
        await ctx.qa("case.open", { workOrderId: op(w, "k").workOrderId, reason: "OTHER" });
        const opened = await caseOn(ctx, w, "k");
        const snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, []);
        const item = caseIn(snapshot, opened.caseId);
        ctx.check(item.ladder.filter((entry) => entry.outcome === "SKIPPED" && (entry.reason ?? "").includes("NO_CHANNEL")).length >= 1, `ladder ${item.ladder.map((entry) => `${entry.rung}:${entry.outcome}`).join(", ")}`);
        ctx.check(decided(orderIn(snapshot, op(w, "k").workOrderId).decisions, "DENY", "CP-TEMPLATE-APPROVED").length >= 1, "no DENY CP-TEMPLATE-APPROVED");
      },
    },
  ],
});
