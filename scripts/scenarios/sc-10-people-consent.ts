// SC-10 · people and consent (docs/test-plan.md §4.5; FL-001 … FL-008): a person registered from the console
// (a repeated phone, a phone outside the synthetic block), "ALTA", a message before it, an unknown number
// answered once a day, "BAJA" of an installer and of a supervisor, the roster changed for the next case, and a
// person deactivated. Every person is the world's own.
import { DAY, at, decided, isNotice, orderIn, personIn, say, settledOn, settledWorld } from "./lib/assist";
import { CREW_N3, caseIn, caseOn, caseSnapshot } from "./lib/cases";
import { type ScenarioContext, ensure } from "./lib/context";
import { outOf } from "./lib/oracles";
import { defineScenario } from "./lib/steps";
import { type World, createWorld, op, staff, stored } from "./lib/world";

const world = (ctx: ScenarioContext) => stored<World>(ctx, "world");

/** A phone of the QA block for the person this run registers (`+52 55 09xx xxxx`), from the run id. */
function newPhone(runId: string, n: number): string {
  let hash = 0;
  for (const char of runId) hash = (hash * 31 + char.charCodeAt(0)) % 900;
  return `+525509${String(990000 + hash * 10 + n).padStart(6, "0").slice(-6)}`;
}

export default defineScenario({
  id: "SC-10",
  slug: "sc-10",
  title: "People and consent",
  suites: ["full"],
  async setup(ctx) {
    ctx.state.world = await createWorld(ctx, {
      startAtSim: at(DAY, "07:00"),
      settings: { demoMode: false },
      operations: [
        { key: "j", model: "wo-24840", installer: "own" },
        { key: "a", model: "wo-24817", installer: "own" },
        { key: "c", model: "wo-24818", installer: "own" },
        { key: "d", model: "wo-24819", installer: "own" },
        { key: "f", model: "wo-24820", installer: "own" },
      ],
    });
  },
  steps: [
    {
      id: "1",
      title: "console.people.upsert → the person; the same phone again → CONFLICT; a phone outside the synthetic block → DENY PHONE_NOT_SYNTHETIC",
      kind: "det",
      flows: ["FL-001"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const phone = newPhone(ctx.runId, 1);
        const person = { role: "INSTALLER", firstName: "Lucía", lastName: "Prueba", crewId: "crew-n3", zoneId: "zone-norte", phone };
        const created = (await ctx.qa("console", { clockId: w.clockId, procedure: "people.upsert", input: person })) as { personId: string };
        ensure(typeof created.personId === "string", "no person created");
        ctx.state.newPerson = created.personId;
        const repeated = await ctx.attempt("console", { clockId: w.clockId, procedure: "people.upsert", input: { ...person, firstName: "Otra" } });
        ctx.check(!repeated.ok && repeated.error.code === "CONFLICT", `the repeated phone answered ${repeated.ok ? "ok" : repeated.error.code}`);
        const real = await ctx.attempt("console", { clockId: w.clockId, procedure: "people.upsert", input: { ...person, firstName: "Real", phone: "+525512345678" } });
        ctx.check(!real.ok && real.error.reason === "PHONE_NOT_SYNTHETIC", `the phone outside the block answered ${real.ok ? "ok" : `${real.error.code}/${real.error.reason ?? ""}`}`);
        const snapshot = await ctx.snapshot({ clockId: w.clockId, personIds: [created.personId] });
        ctx.check(personIn(snapshot, created.personId).active && personIn(snapshot, created.personId).consent === undefined, "the new person is not active without consent");
      },
    },
    {
      id: "2",
      title: "\"ALTA\" → the consent",
      kind: "det",
      flows: ["FL-002"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const j = op(w, "j");
        await say(ctx, w, j.installerId, "ALTA");
        const snapshot = await settledOn(ctx, w, j.installerId, []);
        const person = personIn(snapshot, j.installerId);
        ctx.check(person.consent?.status === "GRANTED", "no consent after ALTA");
        ctx.check(outOf(person.messages, { kind: "SYSTEM_NOTICE" }).length === 1, "no welcome notice");
        ctx.none(snapshot, "turns for ALTA", person.turnNotes);
      },
    },
    {
      id: "3",
      title: "A message before \"ALTA\" → the notice",
      kind: "det",
      flows: ["FL-003"],
      after: "1",
      async run(ctx) {
        const w = world(ctx);
        const personId = stored<string>(ctx, "newPerson");
        await say(ctx, w, personId, "Hola, ¿qué órdenes tengo?");
        const snapshot = await settledOn(ctx, w, personId, []);
        const person = personIn(snapshot, personId);
        ctx.check(person.messages.some((message) => isNotice(message, "optInRequired")), "no notice to send ALTA");
        ctx.check(decided(snapshot.decisions, "DENY", "CP-OPTIN").length > 0, "no DENY CP-OPTIN");
        ctx.none(snapshot, "turns before ALTA", person.turnNotes);
      },
    },
    {
      id: "4",
      title: "An unknown number → the notice once; a second message of the day → nothing",
      kind: "det",
      flows: ["FL-004"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        await say(ctx, w, "UNKNOWN", "Hola, ¿quién es?");
        await say(ctx, w, "UNKNOWN", "¿Hola?");
        const snapshot = await settledWorld(ctx, w);
        const unknown = decided(snapshot.decisions, "DENY", undefined, "UNKNOWN_SENDER");
        ctx.check(unknown.length === 2, `${unknown.length} UNKNOWN_SENDER decisions for two messages`);
        ctx.exactly(snapshot, 1, "notices to the unknown number", decided(snapshot.decisions, "ALLOW").filter((entry) => entry.refs.notice === "unknownNumber"));
      },
    },
    {
      id: "5",
      title: "\"BAJA\" of an installer → its next DAY_START denied",
      kind: "det",
      flows: ["FL-005"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const a = op(w, "a");
        await say(ctx, w, a.installerId, "BAJA");
        await settledOn(ctx, w, a.installerId, []);
        await ctx.qa("clock.advanceTo", { clockId: w.clockId, to: at(DAY, "07:30") });
        const snapshot = await settledWorld(ctx, w, [a.workOrderId], [a.installerId]);
        const person = personIn(snapshot, a.installerId);
        ctx.check(person.consent?.status === "REVOKED", "the consent was not revoked");
        ctx.check(decided(snapshot.decisions, "DENY", "CP-OPTOUT").length > 0, "no DENY CP-OPTOUT of the DAY_START");
        ctx.none(snapshot, "DAY_START to the installer who opted out", outOf(person.messages, { kind: "DAY_START" }));
      },
    },
    {
      id: "6",
      title: "\"BAJA\" of a supervisor + case.open → its rung skipped OPTED_OUT",
      kind: "det",
      flows: ["FL-006"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const primary = staff(w, CREW_N3.primary);
        await say(ctx, w, primary, "BAJA");
        await settledWorld(ctx, w);
        await ctx.qa("case.open", { workOrderId: op(w, "c").workOrderId, reason: "OTHER" });
        const opened = await caseOn(ctx, w, "c");
        const snapshot = await caseSnapshot(ctx, w, "c", opened.caseId, [primary]);
        const item = caseIn(snapshot, opened.caseId);
        ctx.check(item.ladder[0]?.outcome === "SKIPPED" && (item.ladder[0].reason ?? "").includes("OPTED_OUT"), `ladder[0] ${item.ladder[0]?.outcome ?? "none"} ${item.ladder[0]?.reason ?? ""}`);
        ctx.none(snapshot, "case requests to the supervisor who opted out", outOf(personIn(snapshot, primary).messages, { kind: "CASE_REQUEST" }));
      },
    },
    {
      id: "7",
      title: "roster.set → the next case (case.open) uses the new roster",
      kind: "det",
      flows: ["FL-007"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const hector = staff(w, CREW_N3.secondary);
        const adriana = staff(w, CREW_N3.primary);
        await ctx.qa("console", { clockId: w.clockId, procedure: "people.roster.set", input: { crewId: "crew-n3", date: DAY, primaryId: hector, secondaryId: adriana } });
        await ctx.qa("case.open", { workOrderId: op(w, "d").workOrderId, reason: "OTHER" });
        const opened = await caseOn(ctx, w, "d");
        ctx.check(opened.roster.primaryId === hector && opened.roster.secondaryId === adriana, `the case copied ${opened.roster.primaryId ?? "nobody"} / ${opened.roster.secondaryId ?? "nobody"}`);
      },
    },
    {
      id: "8",
      title: "deactivate → the person's messages are treated as an unknown number",
      kind: "det",
      flows: ["FL-008"],
      after: "preset",
      async run(ctx) {
        const w = world(ctx);
        const f = op(w, "f");
        await ctx.qa("console", { clockId: w.clockId, procedure: "people.deactivate", input: { personId: f.installerId, active: false, reason: "QA" } });
        await say(ctx, w, f.installerId, "Hola, ya estoy en el domicilio");
        const snapshot = await settledWorld(ctx, w, [f.workOrderId], [f.installerId]);
        const person = personIn(snapshot, f.installerId);
        ctx.check(!person.active, "the person is still active");
        ctx.none(snapshot, "turns of a deactivated person", person.turnNotes);
        ctx.check(decided(snapshot.decisions, "DENY", undefined, "UNKNOWN_SENDER").length > 0, "the message was not treated as an unknown number");
        ctx.none(snapshot, "templates or replies to the deactivated person", outOf(orderIn(snapshot, f.workOrderId).messages).filter((message) => message.personId === f.installerId));
      },
    },
  ],
});
