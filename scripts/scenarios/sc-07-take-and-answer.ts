// SC-07 · take a case and answer (docs/test-plan.md §4.5; FL-055 … FL-058, FL-063 … FL-065): "Tomar caso" and
// the brief with its photos, the bridge both ways without the agent, the answer with the installer's window
// closed (the template and "Ver respuesta"), a supervisor holding two cases, the case closed and the agent
// back, and the console's take and close (`OPS` refused). The first case is opened by its preset; the second
// one of the same supervisor is preset TAKEN; the console's case has a world of its own (its clock stays put).
import { DAY, at, personIn, say, send, settledOn, tap, withAction } from "./lib/assist";
import { CREW_N3, caseIn, caseOn, caseSnapshot } from "./lib/cases";
import { type ScenarioContext, ensure } from "./lib/context";
import { outOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, staff, stored } from "./lib/world";

const world = (ctx: ScenarioContext) => stored<World>(ctx, "world");

export default defineScenario({
  id: "SC-07",
  slug: "sc-07",
  title: "Take a case and answer",
  suites: ["full"],
  async setup(ctx) {
    const recent = at(DAY, "11:30");
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "11:40"),
      settings: { demoMode: false },
      operations: [
        { key: "k", model: "wo-24818", installer: "own", preset: { activeWorkOrderId: true, lastInboundAtSim: recent, onu: { behaviour: "LOW_POWER_THEN_OK" }, case: { reason: "DIAGNOSIS_ATTEMPTS", rung: "PRIMARY", status: "OPEN" } } },
        { key: "k2", model: "wo-24819", installer: "own", preset: { activeWorkOrderId: true, lastInboundAtSim: recent, case: { reason: "INSTALLER_ASKED", rung: "PRIMARY", status: "TAKEN" } } },
      ],
    });
    // The console's case lives in a world of its own: step 4 moves the main world's clock 25 h ahead.
    ctx.state.console = await createWorld(ctx, { startAtSim: at(DAY, "11:40"), settings: { demoMode: false }, operations: [{ key: "k3", model: "wo-24820", installer: "own", preset: { activeWorkOrderId: true, case: { reason: "OTHER", rung: "PRIMARY", status: "OPEN" } } }] }, "console");
  },
  steps: [
    {
      id: "1",
      title: "\"Tomar caso\" → CASE_BRIEF with the images and its button, CASE_NOTICE",
      kind: "det",
      flows: ["FL-055"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const supervisor = staff(w, CREW_N3.primary);
        const opened = await caseOn(ctx, w, "k");
        await tap(ctx, w, supervisor, "TAKE_CASE", { objectId: opened.caseId });
        const snapshot = await caseSnapshot(ctx, w, "k", opened.caseId, [supervisor]);
        const item = caseIn(snapshot, opened.caseId);
        ctx.check(item.status === "TAKEN" && item.takenBy === supervisor, `the case is ${item.status} by ${item.takenBy ?? "nobody"}`);
        const briefs = ctx.exactly(snapshot, 1, "CASE_BRIEF", outOf(personIn(snapshot, supervisor).messages, { kind: "CASE_BRIEF" }));
        ctx.check(JSON.stringify(briefs[0]?.interactive ?? {}).includes("CLOSE_CASE"), "the brief has no \"Cerrar caso\" button");
        ctx.check(outOf(personIn(snapshot, op(w, "k").installerId).messages, { kind: "CASE_NOTICE" }).length >= 2, "no CASE_NOTICE of the take");
        ctx.state.caseId = opened.caseId;
      },
    },
    {
      id: "2",
      title: "The supervisor's text → RELAY to the installer; the physical action SUPERVISOR_FIX recorded",
      kind: "det",
      flows: ["FL-056"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const k = op(w, "k");
        const supervisor = staff(w, CREW_N3.primary);
        await say(ctx, w, supervisor, "Cambia el conector de la roseta y vuelve a medir");
        const snapshot = await settledOn(ctx, w, k.installerId, [k.workOrderId], [k.installerId, supervisor]);
        const relays = outOf(personIn(snapshot, k.installerId).messages, { kind: "RELAY" });
        ctx.check(relays.some((message) => message.author === `PERSON:${supervisor}`), "no RELAY from the supervisor");
        ctx.check(withAction(snapshot.decisions, "PHYSICAL_ACTION_REPORTED").some((entry) => JSON.stringify(entry.detail ?? {}).includes("SUPERVISOR_FIX")), "no SUPERVISOR_FIX reported");
      },
    },
    {
      id: "3",
      title: "The installer's text and image → RELAY to the supervisor, no TURN#",
      kind: "det",
      flows: ["FL-058"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const k = op(w, "k");
        const supervisor = staff(w, CREW_N3.primary);
        const before = personIn(await ctx.snapshot({ clockId: w.clockId, personIds: [k.installerId] }), k.installerId).turnNotes.length;
        await say(ctx, w, k.installerId, "Ya lo cambié, ahora mide −22,1");
        await send(ctx, w, k.installerId, { type: "photo", photoId: "ph-meter-02" });
        const snapshot = await settledOn(ctx, w, k.installerId, [k.workOrderId], [k.installerId, supervisor]);
        const relays = outOf(personIn(snapshot, supervisor).messages, { kind: "RELAY" });
        ctx.check(relays.length >= 2, `${relays.length} RELAY to the supervisor`);
        ctx.exactly(snapshot, before, "turns while the case is taken", personIn(snapshot, k.installerId).turnNotes);
      },
    },
    {
      id: "4",
      title: "→ +25 h → the supervisor's text → respuesta_supervisor → \"Ver respuesta\" → the pending relays delivered",
      kind: "det",
      flows: ["FL-057"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const k = op(w, "k");
        const supervisor = staff(w, CREW_N3.primary);
        await ctx.qa("clock.advance", { clockId: w.clockId, minutes: 25 * 60 });
        await say(ctx, w, supervisor, "Revisa también la curvatura antes de cerrar");
        const held = await settledOn(ctx, w, k.installerId, [k.workOrderId], [k.installerId]);
        ctx.exactly(held, 1, "respuesta_supervisor templates", outOf(personIn(held, k.installerId).messages, { templateName: "respuesta_supervisor" }));
        const caseId = stored<string>(ctx, "caseId");
        const pendingBefore = caseIn(await caseSnapshot(ctx, w, "k", caseId, []), caseId).bridge.pendingRelays.length;
        ctx.check(pendingBefore >= 1, "no pending relay before \"Ver respuesta\"");
        await tap(ctx, w, k.installerId, "VIEW_REPLY");
        const after = await caseSnapshot(ctx, w, "k", caseId, [k.installerId]);
        ctx.check(caseIn(after, caseId).bridge.pendingRelays.length === 0, "the pending relays were not delivered");
      },
    },
    {
      id: "5",
      title: "Two taken cases → the list → the choice → the RELAY to the right installer",
      kind: "det",
      flows: ["FL-064"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const supervisor = staff(w, CREW_N3.primary);
        const k2 = op(w, "k2");
        const second = await caseOn(ctx, w, "k2");
        await say(ctx, w, supervisor, "¿Ya terminaste la revisión?");
        const listed = await settledOn(ctx, w, k2.installerId, [k2.workOrderId], [supervisor, k2.installerId]);
        ctx.check(outOf(personIn(listed, supervisor).messages).some((message) => (message.interactive as { type?: string } | undefined)?.type === "list"), "no list of cases");
        const relaysBefore = outOf(personIn(listed, k2.installerId).messages, { kind: "RELAY" }).length;
        await tap(ctx, w, supervisor, "CHOOSE_CASE", { objectId: second.caseId });
        const chosen = await settledOn(ctx, w, k2.installerId, [k2.workOrderId], [k2.installerId]);
        ctx.exactly(chosen, relaysBefore + 1, "RELAY to the installer of the chosen case", outOf(personIn(chosen, k2.installerId).messages, { kind: "RELAY" }));
      },
    },
    {
      id: "6",
      title: "\"Cerrar caso\" → the CASE_CLOSED turn (oracle FL-063)",
      kind: "agent",
      flows: ["FL-063"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const k = op(w, "k");
        const caseId = stored<string>(ctx, "caseId");
        await tap(ctx, w, staff(w, CREW_N3.primary), "CLOSE_CASE", { objectId: caseId });
        const snapshot = await caseSnapshot(ctx, w, "k", caseId, [k.installerId]);
        ctx.check(caseIn(snapshot, caseId).status === "CLOSED", "the case is not CLOSED");
        const turn = personIn(snapshot, k.installerId).turnNotes.find((note) => note.trigger === "CASE_CLOSED");
        ensure(turn !== undefined, "no CASE_CLOSED turn");
        const passed = new Set(snapshot.orders[0]?.checklist.filter((entry) => entry.status === "PASSED").map((entry) => entry.item) ?? []);
        const asked = outOf(personIn(snapshot, k.installerId).messages).filter((message) => message.turnId === turn.turnId).flatMap((message) => (Array.isArray(message.refs?.items) ? (message.refs.items as string[]) : []));
        ctx.check(asked.every((item) => !passed.has(item as never)), "the agent asks again for an item already PASSED");
      },
    },
    {
      id: "7",
      title: "Take and close from the console (SUPERVISOR); OPS → 403",
      kind: "det",
      flows: ["FL-065"],
      after: "preset",
      async run(ctx) {
        const w = stored<World>(ctx, "console");
        const third = await caseOn(ctx, w, "k3");
        const refused = await ctx.attempt("console", { clockId: w.clockId, procedure: "cases.take", input: { caseId: third.caseId }, role: "OPS" });
        ctx.check(!refused.ok && refused.error.code === "FORBIDDEN", "OPS could take the case");
        await ctx.qa("console", { clockId: w.clockId, procedure: "cases.take", input: { caseId: third.caseId } });
        let snapshot = await caseSnapshot(ctx, w, "k3", third.caseId, []);
        ctx.check(caseIn(snapshot, third.caseId).status === "TAKEN", "the console did not take the case");
        await ctx.qa("console", { clockId: w.clockId, procedure: "cases.close", input: { caseId: third.caseId } });
        snapshot = await caseSnapshot(ctx, w, "k3", third.caseId, []);
        ctx.check(caseIn(snapshot, third.caseId).status === "CLOSED", "the console did not close the case");
      },
    },
  ],
});
