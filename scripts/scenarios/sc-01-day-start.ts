// SC-01 · start of the day (docs/test-plan.md §4.5; FL-009 … FL-015): the 07:30 `ordenes_del_dia` to the two
// installers with orders, "Ver órdenes" (the agent's detail), the installer without orders skipped, a second
// start denied, the start denied by consent, the order choice, and the dispatcher's reschedule, reassignment,
// cancellation (twice: the repeat is ignored) and a change of an order already closed.
import { DAY, at, decided, orderIn, personIn, say, settledOn, settledWorld, tap } from "./lib/assist";
import { ensure } from "./lib/context";
import { agentReplies, outOf, refList, turnOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, stored } from "./lib/world";

const A_KEYS = ["a1", "a2", "a3"] as const;
const window14 = { start: "2026-10-14T09:00:00-06:00", end: "2026-10-14T11:00:00-06:00" };

const world = (ctx: Parameters<typeof stored>[0]) => stored<World>(ctx, "world");

export default defineScenario({
  id: "SC-01",
  slug: "sc-01",
  title: "Start of the day",
  suites: ["full"],
  async setup(ctx) {
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "07:25"),
      settings: { demoMode: false },
      operations: [
        { key: "a1", model: "wo-24817", installer: "own" },
        { key: "a2", model: "wo-24818", installer: "a1" },
        { key: "a3", model: "wo-24819", installer: "a1" },
        { key: "b1", model: "wo-24820", installer: "own" },
        { key: "b2", model: "wo-24821", installer: "b1" },
        { key: "b3", model: "wo-24822", installer: "b1" },
        { key: "b4", model: "wo-24842", installer: "b1" },
        { key: "n1", model: "wo-24850", installer: "own" },
        { key: "j1", model: "wo-24840", installer: "own" },
        { key: "e1", model: "wo-24841", installer: "own" },
        { key: "c1", model: "wo-24801", installer: "a1" },
      ],
    });
  },
  steps: [
    {
      id: "1",
      title: "→ 07:30: ordenes_del_dia to a and b",
      kind: "det",
      flows: ["FL-009"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        await ctx.qa("clock.advanceTo", { clockId: w.clockId, to: at(DAY, "07:30") });
        const a = op(w, "a1").installerId;
        const b = op(w, "b1").installerId;
        const snapshot = await settledWorld(ctx, w, [], [a, b]);
        for (const installer of [a, b]) {
          const sent = outOf(personIn(snapshot, installer).messages, { kind: "DAY_START", templateName: "ordenes_del_dia" });
          ctx.check(sent.length === 1 && ["SENT", "DELIVERED", "READ"].includes(sent[0]?.status ?? ""), `${installer}: ${sent.length} ordenes_del_dia sent`);
        }
      },
    },
    {
      id: "2",
      title: "\"Ver órdenes\" of a → ORDERS_DETAIL with its 3 orders",
      kind: "agent",
      flows: ["FL-010"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a1").installerId;
        await tap(ctx, w, a, "VIEW_ORDERS");
        const orders = A_KEYS.map((key) => op(w, key).workOrderId);
        const snapshot = await settledOn(ctx, w, a, orders);
        const replies = agentReplies(personIn(snapshot, a).messages);
        const detail = replies.at(-1);
        ensure(detail !== undefined, "no ORDERS_DETAIL nor REPLY");
        const numbers = await Promise.all(orders.map(async (id) => orderIn(snapshot, id).order.workOrderNumber));
        const listed = refList(detail, "workOrderIds");
        const turn = turnOf(orderIn(snapshot, orders[0] ?? ""), detail) ?? snapshot.orders.flatMap((order) => order.turns).find((entry) => entry.turnId === detail.turnId);
        const inText = numbers.every((number) => (detail.text ?? "").includes(number));
        const inTurn = numbers.every((number) => (turn?.figures ?? []).some((figure) => figure.includes(number)));
        ctx.check(orders.every((id) => listed.includes(id)) || (listed.length === 0 && inText && inTurn), `the detail lists ${listed.length} order(s); numbers in text ${inText}, in TURN# ${inTurn}`);
        ctx.inform("kind", detail.kind ?? "");
      },
    },
    {
      id: "3",
      title: "The installer without orders: DAY_START SKIPPED NO_WORK_ORDERS and no message",
      kind: "det",
      flows: ["FL-009"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const n = op(w, "n1").installerId;
        const snapshot = await settledWorld(ctx, w, [], [n]);
        const person = personIn(snapshot, n);
        const timer = person.timers.find((entry) => entry.kind === "DAY_START" && entry.dueAtSim.startsWith("2026-10-13"));
        ctx.check(timer?.status === "SKIPPED" && (timer.reason ?? "").includes("NO_WORK_ORDERS"), `the DAY_START of the installer without orders is ${timer?.status ?? "missing"} (${timer?.reason ?? ""})`);
        ctx.none(snapshot, "messages to the installer without orders", outOf(person.messages));
      },
    },
    {
      id: "4",
      title: "clock.fireDayStart of a again → DENY CP-ONE-DAYSTART, exactly one DAY_START",
      kind: "det",
      flows: ["FL-012"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a1").installerId;
        await ctx.qa("clock.fireDayStart", { personId: a });
        const snapshot = await ctx.settled({ clockId: w.clockId }, { clockId: w.clockId, personIds: [a] });
        ctx.check(decided(snapshot.decisions, "DENY", "CP-ONE-DAYSTART").length > 0, "no DENY CP-ONE-DAYSTART");
        ctx.exactly(snapshot, 1, "DAY_START messages to a", outOf(personIn(snapshot, a).messages, { kind: "DAY_START" }));
      },
    },
    {
      id: "5",
      title: "The DAY_START of the installer without opt-in and of the one who opted out: DENY CP-OPTIN and DENY CP-OPTOUT",
      kind: "det",
      flows: ["FL-011"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const julian = op(w, "j1").installerId;
        const ernesto = op(w, "e1").installerId;
        const snapshot = await ctx.settled({ clockId: w.clockId }, { clockId: w.clockId, personIds: [julian, ernesto] });
        ctx.check(decided(snapshot.decisions, "DENY", "CP-OPTIN").length > 0, "no DENY CP-OPTIN");
        ctx.check(decided(snapshot.decisions, "DENY", "CP-OPTOUT").length > 0, "no DENY CP-OPTOUT");
        ctx.none(snapshot, "messages to the installers without consent", [...outOf(personIn(snapshot, julian).messages), ...outOf(personIn(snapshot, ernesto).messages)]);
      },
    },
    {
      id: "6",
      title: "b writes with no active order → ORDER_CHOICE → b picks → the turn carries the chosen order",
      kind: "det",
      flows: ["FL-013"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const b = op(w, "b1").installerId;
        await say(ctx, w, b, "La ONU no enciende");
        const choice = await settledOn(ctx, w, b, []);
        ctx.check(outOf(personIn(choice, b).messages, { kind: "ORDER_CHOICE" }).length === 1, "no ORDER_CHOICE before the choice");
        await tap(ctx, w, b, "CHOOSE_ORDER");
        const after = await settledOn(ctx, w, b, []);
        const person = personIn(after, b);
        ensure(person.activeWorkOrderId !== undefined, "no active order after the choice");
        const note = person.turnNotes.at(0);
        ctx.check(note?.workOrderId === person.activeWorkOrderId, `the turn carries ${note?.workOrderId ?? "no order"}, the choice is ${person.activeWorkOrderId}`);
      },
    },
    {
      id: "7",
      title: "dispatch.reschedule of an order of a to 14/10 → RESCHEDULED and WORK_ORDER_CHANGED queued",
      kind: "det",
      flows: ["FL-014"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const target = op(w, "a2");
        await ctx.qa("dispatch.reschedule", { workOrderId: target.workOrderId, newWindow: window14 });
        const snapshot = await ctx.eventually(
          "the reschedule applied",
          async () => {
            const seen = await ctx.snapshot({ clockId: w.clockId, workOrderIds: [target.workOrderId] });
            return orderIn(seen, target.workOrderId).order.status === "RESCHEDULED" ? seen : undefined;
          },
          60,
        );
        const order = orderIn(snapshot, target.workOrderId);
        ctx.check(order.order.date === "2026-10-14", `the order is on ${order.order.date}`);
        const settledSnapshot = await settledOn(ctx, w, target.installerId, [target.workOrderId]);
        ctx.check(orderIn(settledSnapshot, target.workOrderId).turnNotes.some((note) => note.trigger === "WORK_ORDER_CHANGED") || decided(orderIn(settledSnapshot, target.workOrderId).decisions, "ACTION", undefined, "DISPATCH_EVENT").length > 0, "no WORK_ORDER_CHANGED turn nor dispatch event recorded");
      },
    },
    {
      id: "8",
      title: "dispatch.reassign of 24819's clone from a to b → new owner and scope",
      kind: "det",
      flows: ["FL-015"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const target = op(w, "a3");
        const b = op(w, "b1").installerId;
        await ctx.qa("dispatch.reassign", { workOrderId: target.workOrderId, newInstallerId: b });
        await ctx.eventually(
          "the reassignment applied",
          async () => orderIn(await ctx.snapshot({ clockId: w.clockId, workOrderIds: [target.workOrderId] }), target.workOrderId).order.installerId === b,
          60,
        );
      },
    },
    {
      id: "9",
      title: "dispatch.cancel and its repeated event ignored; a reschedule of a CLOSED order → DISPATCH_AFTER_CLOSE",
      kind: "det",
      flows: ["FL-014"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const target = op(w, "b4");
        const platformKey = `cancel-${ctx.runId}-b4`;
        const first = (await ctx.qa("dispatch.cancel", { workOrderId: target.workOrderId, platformKey })) as { eventId: string };
        const again = (await ctx.qa("dispatch.cancel", { workOrderId: target.workOrderId, platformKey })) as { eventId: string; replayed: boolean };
        ctx.check(again.replayed && again.eventId === first.eventId, "the repeated cancel was not the same event");
        const closed = op(w, "c1");
        await ctx.qa("dispatch.reschedule", { workOrderId: closed.workOrderId, newWindow: window14 });
        await ctx.eventually("the cancellation applied", async () => orderIn(await ctx.snapshot({ clockId: w.clockId, workOrderIds: [target.workOrderId] }), target.workOrderId).order.status === "CANCELLED", 60);
        const snapshot = await ctx.settled({ clockId: w.clockId }, { clockId: w.clockId, workOrderIds: [target.workOrderId, closed.workOrderId] });
        const applied = orderIn(snapshot, target.workOrderId).order.history.filter((entry) => entry.to === "CANCELLED");
        ctx.exactly(snapshot, 1, "cancellations applied", applied);
        ctx.check(orderIn(snapshot, closed.workOrderId).order.status === "CLOSED", "the closed order changed");
        ctx.check(snapshot.decisions.some((entry) => entry.reason === "DISPATCH_AFTER_CLOSE" || entry.action === "DISPATCH_AFTER_CLOSE" || JSON.stringify(entry.detail ?? {}).includes("DISPATCH_AFTER_CLOSE")), "no DISPATCH_AFTER_CLOSE recorded");
      },
    },
    {
      id: "10",
      title: "→ 14/10 07:30: the DAY_START of a (planned by fire_day_start) counts the rescheduled order",
      kind: "det",
      flows: ["FL-014"],
      after: "7",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a1").installerId;
        const moved = op(w, "a2").workOrderId;
        await ctx.qa("clock.advanceTo", { clockId: w.clockId, to: "2026-10-14T07:30:00-06:00" });
        const snapshot = await settledWorld(ctx, w, [moved], [a]);
        const starts = outOf(personIn(snapshot, a).messages, { kind: "DAY_START" }).filter((message) => message.sentAtSim >= "2026-10-14");
        ensure(starts.length === 1, `${starts.length} DAY_START of 14/10`);
        const params = (starts[0]?.templateParams ?? []).join(" ");
        ctx.check(/\b1\b/.test(params) || params.includes(orderIn(snapshot, moved).order.workOrderNumber), "the DAY_START of 14/10 does not count the rescheduled order");
      },
    },
  ],
});
