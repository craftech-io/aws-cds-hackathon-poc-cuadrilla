// SC-19 · the guest's world and sessions (docs/test-plan.md §4.5; FL-079, FL-084, FL-086), by IAM only: the
// `QaDriver`'s `GUEST` principal of `GUEST#isp-guest-test` (`usr-qa-guest`), built on the server, with two
// sessions (A and B), no password and no browser. It runs before `SC-18` in the same lane (both use the test
// guest's world, in series).
import { GUEST_TEST_CLOCK_ID } from "@cuadrilla/shared";
import { type ScenarioContext, ensure } from "./lib/context";
import { WAITS } from "./lib/eventually";
import { defineScenario } from "./lib/steps";
import { registerWorld } from "./lib/world";

export const GUEST_ORDER = "wo-24817-gtest";
const START = "2026-10-13T13:00:00.000Z";

/** A console procedure as the test guest, in session A or B. */
export function asGuest(ctx: ScenarioContext, procedure: string, input?: unknown, sessionId = "qa-session-a") {
  return ctx.qa("console", { clockId: GUEST_TEST_CLOCK_ID, procedure, role: "GUEST", sessionId, ...(input === undefined ? {} : { input }) });
}

export default defineScenario({
  id: "SC-19",
  slug: "sc-19",
  title: "The guest's world and sessions",
  suites: ["full"],
  lane: "guest-test",
  async setup(ctx) {
    registerWorld(ctx.state, GUEST_TEST_CLOCK_ID);
  },
  steps: [
    {
      id: "0",
      title: "world.destroy of the test guest's world",
      kind: "det",
      flows: ["FL-086"],
      after: "preset",
      async run(ctx) {
        await ctx.qa("world.destroy", { clockId: GUEST_TEST_CLOCK_ID });
        ctx.check((await ctx.snapshot({ clockId: GUEST_TEST_CLOCK_ID })).mode === "ABSENT", "the world is still there");
      },
    },
    {
      id: "1",
      title: "Session A (GUEST) → world.create({template: guest}), the clock paused on 13/10 07:00",
      kind: "det",
      flows: ["FL-079"],
      after: "0",
      async run(ctx) {
        const created = (await ctx.qa("world.create", { clockId: GUEST_TEST_CLOCK_ID, template: "guest" })) as { kind: string; worldEpoch: number };
        ctx.check(created.kind === "GUEST", `world.create built a ${created.kind} world`);
        const snapshot = await ctx.snapshot({ clockId: GUEST_TEST_CLOCK_ID });
        ctx.check(snapshot.mode === "PAUSED" && snapshot.simNow === START, `the clock is ${snapshot.mode} at ${snapshot.simNow}`);
        const session = (await asGuest(ctx, "account.session")) as { role: string; isGuest: boolean; clockId: string; otherSession: boolean };
        ctx.check(session.role === "GUEST" && session.isGuest && session.clockId === GUEST_TEST_CLOCK_ID && !session.otherSession, "the principal of session A is not the test guest's");
        ctx.state.epoch = created.worldEpoch;
      },
    },
    {
      id: "2",
      title: "A: \"Iniciar el día\" and setOnuBehaviour → visible changes",
      kind: "det",
      flows: ["FL-084"],
      after: "1",
      async run(ctx) {
        await asGuest(ctx, "clock.startDay", {});
        await asGuest(ctx, "clock.setOnuBehaviour", { workOrderId: GUEST_ORDER, behaviour: "ONLINE_OK", fixed: true, force: true });
        await ctx.qa("world.settle", { clockId: GUEST_TEST_CLOCK_ID, timeoutSec: WAITS.settleSec });
        const clock = (await asGuest(ctx, "clock.get")) as { simNow: string };
        ctx.check(Date.parse(clock.simNow) === Date.parse("2026-10-13T07:30:00-06:00"), `the clock reads ${clock.simNow}`);
        const onu = (await asGuest(ctx, "orders.onuStatus", { workOrderId: GUEST_ORDER })) as { operState?: string; status?: { operState?: string } };
        ctx.check((onu.operState ?? onu.status?.operState) === "ONLINE", "the ONU did not change");
      },
    },
    {
      id: "3",
      title: "Session B → account.session with the notice of another session and without the reset",
      kind: "det",
      flows: ["FL-079"],
      after: "1",
      async run(ctx) {
        const session = (await asGuest(ctx, "account.session", undefined, "qa-session-b")) as { otherSession: boolean; canReset: boolean };
        ctx.check(session.otherSession && !session.canReset, `session B: otherSession ${session.otherSession}, canReset ${session.canReset}`);
      },
    },
    {
      id: "4",
      title: "A: console.clock.reset → the world equal to the template, epoch + 1",
      kind: "det",
      flows: ["FL-086"],
      after: "1",
      async run(ctx) {
        await asGuest(ctx, "clock.reset");
        await ctx.qa("world.settle", { clockId: GUEST_TEST_CLOCK_ID, timeoutSec: WAITS.settleSec });
        const snapshot = await ctx.snapshot({ clockId: GUEST_TEST_CLOCK_ID, workOrderIds: [GUEST_ORDER] });
        const epoch = ctx.state.epoch as number | undefined;
        ensure(epoch !== undefined, "no epoch of step 1");
        ctx.check(snapshot.worldEpoch === epoch + 1, `epoch ${snapshot.worldEpoch} after ${epoch}`);
        ctx.check(snapshot.simNow === START && snapshot.mode === "PAUSED", "the clock is not back at the template's start");
        ctx.check(snapshot.orders[0]?.checklist.every((item) => item.status === "PENDING") === true, "the 24817 is not as the template has it");
      },
    },
    {
      id: "5",
      title: "world.destroy in finally",
      kind: "det",
      flows: ["FL-084"],
      after: "preset",
      async run(ctx) {
        await ctx.qa("world.destroy", { clockId: GUEST_TEST_CLOCK_ID });
        ctx.check((await ctx.snapshot({ clockId: GUEST_TEST_CLOCK_ID })).mode === "ABSENT", "the world is still there");
      },
    },
  ],
});
