// SC-16 · audit and isolation, the last scenario (docs/test-plan.md §4.5; FL-076, FL-077, FL-081, FL-087,
// FL-088, FL-096): the recipient fence of a QA world and of the demo world (a computation: no row of the demo
// is read), the policy audits of every scenario of the run added up, access across operators and two worlds
// (one moves, the other does not change), the world's KPIs against the `qa-min` fixture, the audit views, a
// known attack stopped by G1, and the world destroyed.
//
// Deviation from §4.5 step 3: the `QaDriver` builds only `qa-*` and `eval-*` worlds (and the test guest's),
// so the two worlds are two `qa-min` worlds of this scenario, not two worlds of the `guest` template.
import { DEMO_CLOCK_ID } from "@cuadrilla/shared";
import { decided } from "./lib/assist";
import { type ScenarioContext, ensure } from "./lib/context";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, stored } from "./lib/world";

const ADDRESSES = ["success@simulator.amazonses.com", "ops@cuadrilla.demo.craftech.io", "cliente@example.com", "alguien@demo.craftech.io"];
const named = (ctx: ScenarioContext, name: string) => stored<World>(ctx, name);

export default defineScenario({
  id: "SC-16",
  slug: "sc-16",
  title: "Audit and isolation",
  suites: ["full"],
  last: true,
  async setup(ctx) {
    ctx.state.world = await createWorld(ctx, { template: "qa-min" });
    ctx.state.twin = await createWorld(ctx, { template: "qa-min" }, "twin");
  },
  steps: [
    {
      id: "1",
      title: "fence.probe in a QA world and in the demo world",
      kind: "det",
      flows: ["FL-076"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "world");
        for (const clockId of [w.clockId, DEMO_CLOCK_ID]) {
          const probe = (await ctx.qa("fence.probe", { clockId, addresses: ADDRESSES })) as { decisions: Array<{ allowed: boolean }> };
          ctx.check(probe.decisions.map((decision) => decision.allowed).join(",") === "true,false,false,false", `${clockId}: ${probe.decisions.map((decision) => decision.allowed).join(",")}`);
        }
      },
    },
    {
      id: "2",
      title: "policyAudit = 0 adding up every scenario of the run",
      kind: "det",
      flows: ["FL-077"],
      after: "preset",
      async run(ctx) {
        const own = (await ctx.qa("policyAudit.run", { clockId: named(ctx, "world").clockId })) as { violations: number };
        const earlier = ctx.previous.reduce((sum, entry) => sum + entry.violations, 0);
        const unaudited = ctx.previous.reduce((sum, entry) => sum + entry.unaudited, 0);
        ctx.inform("scenariosAudited", String(ctx.previous.length));
        ctx.check(own.violations + earlier === 0, `${own.violations + earlier} violation(s) in the run`);
        ctx.check(unaudited === 0, `${unaudited} world(s) of the run could not be audited`);
      },
    },
    {
      id: "3",
      title: "Access across operators is refused; of two worlds, one moves and the other does not change",
      kind: "det",
      flows: ["FL-081"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "world");
        const twin = named(ctx, "twin");
        const foreign = op(twin, "a").workOrderId;
        const answer = await ctx.attempt("console", { clockId: w.clockId, procedure: "orders.get", input: { workOrderId: foreign } });
        ctx.check(!answer.ok && answer.error.code === "FORBIDDEN", `the other operator's order answered ${answer.ok ? "ok" : answer.error.code}`);
        const before = await ctx.snapshot({ clockId: twin.clockId });
        await ctx.qa("clock.advance", { clockId: w.clockId, minutes: 30 });
        await ctx.qa("world.settle", { clockId: w.clockId, timeoutSec: 300 });
        const after = await ctx.snapshot({ clockId: twin.clockId });
        ctx.check(after.simNow === before.simNow && after.worldEpoch === before.worldEpoch, "the other world changed");
        ctx.check(decided((await ctx.snapshot({ clockId: w.clockId })).decisions, "DENY", undefined, "CROSS_ISP").length > 0, "no DENY CROSS_ISP");
      },
    },
    {
      id: "4",
      title: "The world's KPIs against the qa-min fixture",
      kind: "det",
      flows: ["FL-087"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "world");
        const metrics = (await ctx.qa("metrics.get", { clockId: w.clockId })) as { conversations: number; usage: { turns: number } };
        ctx.check(metrics.conversations === 2 && metrics.usage.turns === 14, `KPIs: ${metrics.conversations} conversation(s), ${metrics.usage.turns} turn(s)`);
        const summary = (await ctx.qa("console", { clockId: w.clockId, procedure: "metrics.summary", input: { tab: "WORLD" } })) as unknown;
        ensure(summary !== null && typeof summary === "object", "no metrics summary");
        ctx.check(!/evaluaci[oó]n|EV-0/i.test(JSON.stringify(summary)), "the summary names what the product measures with internal words");
      },
    },
    {
      id: "5",
      title: "audit.list, violations, decisionsByRule",
      kind: "det",
      flows: ["FL-088"],
      after: "preset",
      async run(ctx) {
        const w = named(ctx, "world");
        const list = (await ctx.qa("console", { clockId: w.clockId, procedure: "audit.list", input: {} })) as unknown;
        const violations = (await ctx.qa("console", { clockId: w.clockId, procedure: "audit.violations", input: {} })) as { count: number };
        const byRule = (await ctx.qa("console", { clockId: w.clockId, procedure: "audit.decisionsByRule", input: {} })) as unknown;
        ensure(list !== null && byRule !== null, "an audit view answered nothing");
        ctx.check(violations.count === 0, `${violations.count} violation(s) in the world`);
      },
    },
    {
      id: "6",
      title: "guardrail.probe → GUARDRAIL_INTERVENED",
      kind: "det",
      flows: ["FL-096"],
      after: "preset",
      async run(ctx) {
        const probe = (await ctx.qa("guardrail.probe", {})) as { action: string };
        ctx.check(probe.action === "GUARDRAIL_INTERVENED", `G1 answered ${probe.action}`);
      },
    },
    {
      id: "7",
      title: "world.destroy (also in the cleanup): nothing of the world stays reachable",
      kind: "det",
      flows: ["FL-081"],
      after: "preset",
      async run(ctx) {
        const twin = named(ctx, "twin");
        await ctx.qa("world.destroy", { clockId: twin.clockId });
        const gone = await ctx.snapshot({ clockId: twin.clockId });
        ctx.check(gone.mode === "ABSENT", "the world still has its clock");
        const order = await ctx.attempt("snapshot", { clockId: twin.clockId, workOrderIds: [op(twin, "a").workOrderId] });
        ctx.check(!order.ok, "an order of the destroyed world is still readable");
      },
    },
  ],
});
